//! 会话表与转发协议（纯逻辑，便于单测）。
//!
//! 服务器在这里只有两样东西：谁在线（会话 id + 显示名）、每条连接的转发目标绑定。
//! 它没有"文件"这个概念——文件名、大小、哈希、分块都不进入服务器状态，
//! 因此也就无从记录、无从留存（见 tests/architecture.rs 的约束）。

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// 文本帧（JSON 负载）上限。
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
/// 二进制帧上限（分块 1 MiB + 头部，留足余量）。
pub const MAX_BINARY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    #[error("在线人数已达上限")]
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    #[error("目标会话不在线")]
    UnknownSession,
    #[error("本连接尚未绑定转发目标（先发 bind）")]
    Unbound,
    #[error("目标连接已关闭")]
    Closed,
}

/// 服务器 → 客户端：文本（JSON）或二进制（原样转发）。
#[derive(Debug, Clone)]
pub enum OutMessage {
    Json(ServerMessage),
    Bytes(Vec<u8>),
}

pub type Outbox = mpsc::UnboundedSender<OutMessage>;

// ---------------------------------------------------------------------------
// 线协议（客户端 ⇄ 服务器）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// 建立会话（必须是第一条消息）
    Hello { name: Option<String> },
    /// 拉取在线会话列表（拉取，不是推送）
    Sessions,
    /// 定向转发一段 JSON 负载；服务器不解析 payload
    Relay {
        to: String,
        payload: serde_json::Value,
    },
    /// 把本连接后续的二进制帧绑定到该目标
    Bind { to: String },
    /// 解除绑定
    Unbind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "self")]
        me: SessionInfo,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Relay {
        from: String,
        payload: serde_json::Value,
    },
    Bound {
        to: String,
    },
    Error {
        code: &'static str,
        message: String,
    },
}

impl ServerMessage {
    pub fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self::Error {
            code,
            message: message.into(),
        }
    }
}

pub fn parse_client_message(text: &str) -> Result<ClientMessage, String> {
    serde_json::from_str::<ClientMessage>(text).map_err(|err| err.to_string())
}

/// 显示名清洗：去控制字符、压缩空白、限长 32 字符；空则给默认名。
pub fn sanitize_name(raw: Option<&str>, id: &str) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(32).collect();
    if cleaned.is_empty() {
        format!("访客-{id}")
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub capacity: u32,
    pub window: Duration,
}

impl RateLimit {
    pub fn new(capacity: u32, window: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            window,
        }
    }

    pub fn per_second(capacity: u32) -> Self {
        Self::new(capacity, Duration::from_secs(1))
    }
}

impl Default for RateLimit {
    fn default() -> Self {
        Self::per_second(120)
    }
}

#[derive(Debug, Clone)]
pub struct RateLimiter {
    limit: RateLimit,
    window_start: Instant,
    used: u32,
}

impl RateLimiter {
    pub fn new(limit: RateLimit) -> Self {
        Self::starting_at(limit, Instant::now())
    }

    pub fn starting_at(limit: RateLimit, now: Instant) -> Self {
        Self {
            limit,
            window_start: now,
            used: 0,
        }
    }

    pub fn check(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window_start) >= self.limit.window {
            self.window_start = now;
            self.used = 0;
        }
        if self.used >= self.limit.capacity {
            return false;
        }
        self.used += 1;
        true
    }
}

// ---------------------------------------------------------------------------
// 会话表
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Session {
    info: SessionInfo,
    outbox: Outbox,
    /// 本连接二进制帧的转发目标（临时路由状态，不含任何文件信息）
    bound_to: Option<String>,
}

#[derive(Debug)]
pub struct Registry {
    max_sessions: usize,
    rate_limit: RateLimit,
    seq: AtomicU64,
    sessions: Mutex<BTreeMap<String, Session>>,
}

impl Registry {
    pub fn new(max_sessions: usize) -> Self {
        Self::with_rate_limit(max_sessions, RateLimit::default())
    }

    pub fn with_rate_limit(max_sessions: usize, rate_limit: RateLimit) -> Self {
        Self {
            max_sessions: max_sessions.max(1),
            rate_limit,
            seq: AtomicU64::new(1),
            sessions: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn rate_limit(&self) -> RateLimit {
        self.rate_limit
    }

    pub fn limiter(&self) -> RateLimiter {
        RateLimiter::new(self.rate_limit)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn join(
        &self,
        requested_name: Option<&str>,
        outbox: Outbox,
    ) -> Result<SessionInfo, JoinError> {
        let mut sessions = self.lock();
        if sessions.len() >= self.max_sessions {
            return Err(JoinError::Full);
        }
        let id = format!("s{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let info = SessionInfo {
            id: id.clone(),
            name: sanitize_name(requested_name, &id),
        };
        sessions.insert(
            id,
            Session {
                info: info.clone(),
                outbox,
                bound_to: None,
            },
        );
        Ok(info)
    }

    /// 注销会话。返回其信息（调用方**不要**向其他人广播，本项目不广播）。
    pub fn leave(&self, id: &str) -> Option<SessionInfo> {
        self.lock().remove(id).map(|session| session.info)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.lock().values().map(|s| s.info.clone()).collect()
    }

    pub fn list_except(&self, id: &str) -> Vec<SessionInfo> {
        self.lock()
            .values()
            .filter(|session| session.info.id != id)
            .map(|session| session.info.clone())
            .collect()
    }

    pub fn count(&self) -> usize {
        self.lock().len()
    }

    pub fn max_sessions(&self) -> usize {
        self.max_sessions
    }

    pub fn contains(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }

    /// 定向投递一段 JSON 消息；目标不在线时返回 UnknownSession。
    pub fn send_to(&self, target: &str, message: ServerMessage) -> Result<(), RouteError> {
        let sessions = self.lock();
        let session = sessions.get(target).ok_or(RouteError::UnknownSession)?;
        session
            .outbox
            .send(OutMessage::Json(message))
            .map_err(|_| RouteError::Closed)
    }

    /// 绑定本连接的二进制转发目标。
    pub fn bind(&self, from: &str, target: &str) -> Result<(), RouteError> {
        let mut sessions = self.lock();
        if !sessions.contains_key(target) {
            return Err(RouteError::UnknownSession);
        }
        let session = sessions.get_mut(from).ok_or(RouteError::UnknownSession)?;
        session.bound_to = Some(target.to_string());
        Ok(())
    }

    pub fn unbind(&self, from: &str) {
        if let Some(session) = self.lock().get_mut(from) {
            session.bound_to = None;
        }
    }

    pub fn bound_target(&self, from: &str) -> Option<String> {
        self.lock().get(from).and_then(|s| s.bound_to.clone())
    }

    /// 把二进制帧原样转发给绑定的目标。
    pub fn forward_binary(&self, from: &str, bytes: Vec<u8>) -> Result<usize, RouteError> {
        let target = self.bound_target(from).ok_or(RouteError::Unbound)?;
        let sessions = self.lock();
        let session = sessions.get(&target).ok_or(RouteError::UnknownSession)?;
        session
            .outbox
            .send(OutMessage::Bytes(bytes))
            .map_err(|_| RouteError::Closed)?;
        Ok(target.len())
    }

    /// 用于 test：确认服务器里没有任何"文件"相关字段。
    pub fn session_count(&self) -> usize {
        self.count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(max: usize) -> Registry {
        Registry::new(max)
    }

    #[test]
    fn rate_limit_is_configurable() {
        let registry = Registry::with_rate_limit(4, RateLimit::per_second(3));
        assert_eq!(registry.rate_limit().capacity, 3);
        assert_eq!(registry.max_sessions(), 4);
    }

    fn outbox() -> (Outbox, mpsc::UnboundedReceiver<OutMessage>) {
        mpsc::unbounded_channel()
    }

    #[test]
    fn starts_empty_every_time() {
        let registry = registry(8);
        assert_eq!(registry.count(), 0);
        assert!(registry.list().is_empty());
    }

    #[test]
    fn join_creates_session_without_telling_anyone() {
        let registry = registry(8);
        let (tx_a, mut rx_a) = outbox();
        let (tx_b, mut rx_b) = outbox();
        let a = registry.join(Some("Alice"), tx_a).unwrap();
        assert_eq!(a.name, "Alice");
        assert!(rx_a.try_recv().is_err(), "加入时不应收到任何推送");

        let b = registry.join(Some("Bob"), tx_b).unwrap();
        assert_ne!(a.id, b.id);
        assert!(rx_a.try_recv().is_err(), "有人加入也不应推送给其他人");
        assert!(rx_b.try_recv().is_err());
        assert_eq!(registry.list_except(&a.id), vec![b.clone()]);
        assert_eq!(registry.list_except(&b.id), vec![a.clone()]);
    }

    #[test]
    fn leave_removes_session_without_broadcast() {
        let registry = registry(8);
        let (tx_a, mut rx_a) = outbox();
        let (tx_b, _rx_b) = outbox();
        let a = registry.join(Some("A"), tx_a).unwrap();
        let b = registry.join(Some("B"), tx_b).unwrap();

        assert_eq!(registry.leave(&a.id), Some(a.clone()));
        assert!(rx_a.try_recv().is_err());
        assert_eq!(registry.count(), 1);
        assert_eq!(registry.list(), vec![b]);
        assert_eq!(registry.leave("nope"), None);
    }

    #[test]
    fn relay_is_point_to_point() {
        let registry = registry(8);
        let (tx_a, mut rx_a) = outbox();
        let (tx_b, mut rx_b) = outbox();
        let (_c_tx, mut rx_c) = outbox();
        let a = registry.join(Some("A"), tx_a).unwrap();
        let b = registry.join(Some("B"), tx_b).unwrap();
        registry.join(Some("C"), _c_tx).unwrap();

        let payload = serde_json::json!({"k": "index-request"});
        registry
            .send_to(
                &b.id,
                ServerMessage::Relay {
                    from: a.id.clone(),
                    payload: payload.clone(),
                },
            )
            .unwrap();

        match rx_b.try_recv().unwrap() {
            OutMessage::Json(ServerMessage::Relay { from, payload: got }) => {
                assert_eq!(from, a.id);
                assert_eq!(got, payload);
            }
            other => panic!("expected relay, got {other:?}"),
        }
        assert!(rx_a.try_recv().is_err(), "发送方不应收到回显");
        assert!(rx_c.try_recv().is_err(), "第三者不应收到任何消息（不广播）");

        assert_eq!(
            registry.send_to("nope", ServerMessage::error("x", "y")),
            Err(RouteError::UnknownSession)
        );
    }

    #[test]
    fn payload_is_opaque_and_forwarded_unchanged() {
        let registry = registry(8);
        let (tx_a, _rx_a) = outbox();
        let (tx_b, mut rx_b) = outbox();
        let a = registry.join(None, tx_a).unwrap();
        let b = registry.join(None, tx_b).unwrap();

        // 故意塞入服务器完全无法理解的负载（包括看起来像文件元数据的东西）
        let payload = serde_json::json!({
            "k": "manifest",
            "files": [{"path": "a/b.bin", "size": 1234, "sha256": "ab".repeat(32)}],
            "chunkSize": 1048576
        });
        registry
            .send_to(
                &b.id,
                ServerMessage::Relay {
                    from: a.id.clone(),
                    payload: payload.clone(),
                },
            )
            .unwrap();
        match rx_b.try_recv().unwrap() {
            OutMessage::Json(ServerMessage::Relay { payload: got, .. }) => assert_eq!(got, payload),
            other => panic!("expected relay, got {other:?}"),
        }
    }

    #[test]
    fn binary_frames_follow_the_binding() {
        let registry = registry(8);
        let (tx_a, _rx_a) = outbox();
        let (tx_b, mut rx_b) = outbox();
        let (_tx_c, mut rx_c) = outbox();
        let a = registry.join(None, tx_a).unwrap();
        let b = registry.join(None, tx_b).unwrap();
        let c = registry.join(None, _tx_c).unwrap();

        assert_eq!(
            registry.forward_binary(&a.id, vec![1, 2, 3]),
            Err(RouteError::Unbound),
            "没有绑定时必须拒绝"
        );
        assert_eq!(registry.bind(&a.id, &c.id), Ok(()));
        assert_eq!(
            registry.bind(&a.id, "nope"),
            Err(RouteError::UnknownSession)
        );

        // 重新绑定到 B
        registry.bind(&a.id, &b.id).unwrap();
        assert_eq!(registry.bound_target(&a.id).as_deref(), Some(b.id.as_str()));
        registry.forward_binary(&a.id, vec![9, 8, 7]).unwrap();
        match rx_b.try_recv().unwrap() {
            OutMessage::Bytes(bytes) => assert_eq!(bytes, vec![9, 8, 7]),
            other => panic!("expected bytes, got {other:?}"),
        }
        assert!(rx_c.try_recv().is_err(), "绑定后不应发给其他人");

        registry.unbind(&a.id);
        assert!(registry.bound_target(&a.id).is_none());
        assert_eq!(
            registry.forward_binary(&a.id, vec![0]),
            Err(RouteError::Unbound)
        );
    }

    #[test]
    fn leaving_drops_the_binding() {
        let registry = registry(8);
        let (tx_a, _rx_a) = outbox();
        let (tx_b, _rx_b) = outbox();
        let a = registry.join(None, tx_a).unwrap();
        let b = registry.join(None, tx_b).unwrap();
        registry.bind(&a.id, &b.id).unwrap();
        registry.leave(&a.id);
        assert!(registry.bound_target(&a.id).is_none());
        assert_eq!(
            registry.forward_binary(&a.id, vec![1]),
            Err(RouteError::Unbound)
        );
    }

    #[test]
    fn max_sessions_is_enforced() {
        let registry = registry(2);
        let (tx1, _rx1) = outbox();
        let (tx2, _rx2) = outbox();
        let (tx3, _rx3) = outbox();
        assert!(registry.join(None, tx1).is_ok());
        assert!(registry.join(None, tx2).is_ok());
        assert_eq!(registry.join(None, tx3).unwrap_err(), JoinError::Full);
    }

    #[test]
    fn name_is_sanitized() {
        assert_eq!(sanitize_name(Some("  Alice   Bob "), "s1"), "Alice Bob");
        assert_eq!(sanitize_name(Some(""), "s7"), "访客-s7");
        assert_eq!(sanitize_name(Some("bad\u{7}name\n"), "s1"), "badname");
        assert_eq!(
            sanitize_name(Some(&"字".repeat(100)), "s1").chars().count(),
            32
        );
    }

    #[test]
    fn rate_limiter_resets_after_window() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::starting_at(RateLimit::new(2, Duration::from_secs(10)), t0);
        assert!(limiter.check(t0));
        assert!(limiter.check(t0));
        assert!(!limiter.check(t0));
        assert!(limiter.check(t0 + Duration::from_secs(10)));
    }

    #[test]
    fn client_messages_parse() {
        assert_eq!(
            parse_client_message(r#"{"t":"hello","name":"Alice"}"#).unwrap(),
            ClientMessage::Hello {
                name: Some("Alice".into())
            }
        );
        assert_eq!(
            parse_client_message(r#"{"t":"sessions"}"#).unwrap(),
            ClientMessage::Sessions
        );
        assert_eq!(
            parse_client_message(r#"{"t":"unbind"}"#).unwrap(),
            ClientMessage::Unbind
        );
        assert_eq!(
            parse_client_message(r#"{"t":"bind","to":"s2"}"#).unwrap(),
            ClientMessage::Bind { to: "s2".into() }
        );
        match parse_client_message(r#"{"t":"relay","to":"s2","payload":{"k":"x"}}"#).unwrap() {
            ClientMessage::Relay { to, payload } => {
                assert_eq!(to, "s2");
                assert_eq!(payload["k"], "x");
            }
            other => panic!("expected relay, got {other:?}"),
        }
        for bad in [
            "not json",
            "{}",
            r#"{"t":"nope"}"#,
            r#"{"t":"bind"}"#,
            "[1]",
        ] {
            assert!(parse_client_message(bad).is_err(), "{bad} 应解析失败");
        }
    }

    #[test]
    fn server_messages_serialize_with_type_tag() {
        let sessions = serde_json::to_value(ServerMessage::Sessions {
            sessions: vec![SessionInfo {
                id: "s1".into(),
                name: "A".into(),
            }],
        })
        .unwrap();
        assert_eq!(sessions["t"], "sessions");
        assert_eq!(sessions["sessions"][0]["id"], "s1");

        let welcome = serde_json::to_value(ServerMessage::Welcome {
            me: SessionInfo {
                id: "s1".into(),
                name: "A".into(),
            },
        })
        .unwrap();
        assert_eq!(welcome["t"], "welcome");
        assert_eq!(welcome["self"]["id"], "s1");

        let bound = serde_json::to_value(ServerMessage::Bound { to: "s2".into() }).unwrap();
        assert_eq!(bound["t"], "bound");
        assert_eq!(bound["to"], "s2");
    }

    #[test]
    fn session_count_matches_registry() {
        let registry = registry(4);
        assert_eq!(registry.session_count(), 0);
        let (tx, _rx) = outbox();
        registry.join(None, tx).unwrap();
        assert_eq!(registry.session_count(), 1);
        assert_eq!(registry.max_sessions(), 4);
    }
}
