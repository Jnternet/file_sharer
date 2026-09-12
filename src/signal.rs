//! 在线名单（信令的纯逻辑部分，不依赖 axum，便于单测）。
//!
//! 这里是服务器唯一持有的"状态"：一份内存中的 peer 名单。
//! 进程退出即清空 —— 也就是"每次启动后都是一个空桶"（需求 R3）。

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    #[error("在线人数已达上限")]
    Full,
}

#[derive(Debug)]
pub struct PeerRegistry {
    max_peers: usize,
    seq: AtomicU64,
    peers: Mutex<BTreeMap<String, String>>,
}

impl PeerRegistry {
    pub fn new(max_peers: usize) -> Self {
        Self {
            max_peers: max_peers.max(1),
            seq: AtomicU64::new(1),
            peers: Mutex::new(BTreeMap::new()),
        }
    }

    /// 注册一个 peer，返回（自己，除自己外的在线名单）。
    pub fn join(&self, requested_name: Option<&str>) -> Result<(PeerInfo, Vec<PeerInfo>), JoinError> {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if peers.len() >= self.max_peers {
            return Err(JoinError::Full);
        }
        let id = format!("p{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let info = PeerInfo {
            id: id.clone(),
            name: sanitize_name(requested_name, &id),
        };
        peers.insert(id.clone(), info.name.clone());
        let others = peers
            .iter()
            .filter(|(peer_id, _)| **peer_id != id)
            .map(|(peer_id, name)| PeerInfo {
                id: peer_id.clone(),
                name: name.clone(),
            })
            .collect();
        Ok((info, others))
    }

    /// 注销 peer，返回剩余的在线名单（用于广播）。
    pub fn leave(&self, id: &str) -> Vec<PeerInfo> {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.remove(id);
        peers
            .iter()
            .map(|(peer_id, name)| PeerInfo {
                id: peer_id.clone(),
                name: name.clone(),
            })
            .collect()
    }

    pub fn list(&self) -> Vec<PeerInfo> {
        self.peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, name)| PeerInfo {
                id: id.clone(),
                name: name.clone(),
            })
            .collect()
    }

    pub fn count(&self) -> usize {
        self.peers.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn max_peers(&self) -> usize {
        self.max_peers
    }

    pub fn contains(&self, id: &str) -> bool {
        self.peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    }
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
// 信令协议（浏览器 ⇄ 服务器）
// ---------------------------------------------------------------------------

/// 单条信令消息的字节上限。SDP/ICE 消息通常只有几 KiB，64 KiB 留足余量。
pub const MAX_SIGNAL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// 注册显示名并进入在线名单（必须是第一条消息）
    Hello { name: Option<String> },
    /// 透明转发给指定 peer（SDP / ICE 等），服务器不解析 data
    Signal {
        to: String,
        data: serde_json::Value,
    },
    /// 请求当前在线名单
    List,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "self")]
        me: PeerInfo,
        peers: Vec<PeerInfo>,
        ice_servers: Vec<String>,
        max_peers: usize,
    },
    Peers {
        peers: Vec<PeerInfo>,
    },
    Signal {
        from: String,
        data: serde_json::Value,
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

/// 解析客户端消息；错误信息直接映射到 `bad-request` 错误码。
pub fn parse_client_message(text: &str) -> Result<ClientMessage, String> {
    serde_json::from_str::<ClientMessage>(text).map_err(|err| err.to_string())
}

pub type Outbox = mpsc::UnboundedSender<ServerMessage>;

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
        Self::per_second(60)
    }
}

/// 固定窗口限流器（足够挡住误用与低强度滥用，逻辑可精确单测）。
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

    /// 指定起始时刻（测试可注入时钟，保证结果可复现）。
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
// 信令中枢：名单 + 每连接发件箱
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Hub {
    registry: Arc<PeerRegistry>,
    outboxes: Mutex<HashMap<String, Outbox>>,
    rate_limit: RateLimit,
    ice_servers: Vec<String>,
}

impl Hub {
    pub fn new(max_peers: usize, rate_limit: RateLimit, ice_servers: Vec<String>) -> Self {
        Self {
            registry: Arc::new(PeerRegistry::new(max_peers)),
            outboxes: Mutex::new(HashMap::new()),
            rate_limit,
            ice_servers,
        }
    }

    pub fn registry(&self) -> &Arc<PeerRegistry> {
        &self.registry
    }

    pub fn rate_limit(&self) -> RateLimit {
        self.rate_limit
    }

    pub fn limiter(&self) -> RateLimiter {
        RateLimiter::new(self.rate_limit)
    }

    pub fn ice_servers(&self) -> &[String] {
        &self.ice_servers
    }

    pub fn max_peers(&self) -> usize {
        self.registry.max_peers()
    }

    /// 注册 peer：先占名单名额，再挂上发件箱。
    pub fn join(
        &self,
        requested_name: Option<&str>,
        tx: Outbox,
    ) -> Result<(PeerInfo, Vec<PeerInfo>), JoinError> {
        let (me, others) = self.registry.join(requested_name)?;
        self.outboxes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(me.id.clone(), tx);
        Ok((me, others))
    }

    /// 注销 peer，返回剩余名单。
    pub fn leave(&self, id: &str) -> Vec<PeerInfo> {
        self.outboxes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.registry.leave(id)
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        self.registry.list()
    }

    pub fn count(&self) -> usize {
        self.registry.count()
    }

    /// 发给指定 peer；目标不在线返回 false。
    pub fn send_to(&self, target: &str, message: ServerMessage) -> bool {
        let outboxes = self.outboxes.lock().unwrap_or_else(|e| e.into_inner());
        match outboxes.get(target) {
            Some(tx) => tx.send(message).is_ok(),
            None => false,
        }
    }

    pub fn broadcast(&self, message: ServerMessage) {
        let outboxes = self.outboxes.lock().unwrap_or_else(|e| e.into_inner());
        for tx in outboxes.values() {
            let _ = tx.send(message.clone());
        }
    }

    /// 名单广播：每个接收者拿到的列表**不包含自己**（否则前端会尝试连自己）。
    pub fn broadcast_peers(&self) {
        let peers = self.registry.list();
        let outboxes = self.outboxes.lock().unwrap_or_else(|e| e.into_inner());
        for (id, tx) in outboxes.iter() {
            let others = peers
                .iter()
                .filter(|peer| &peer.id != id)
                .cloned()
                .collect::<Vec<_>>();
            let _ = tx.send(ServerMessage::Peers { peers: others });
        }
    }

    pub fn welcome(&self, me: PeerInfo, peers: Vec<PeerInfo>) -> ServerMessage {
        ServerMessage::Welcome {
            me,
            peers,
            ice_servers: self.ice_servers.clone(),
            max_peers: self.max_peers(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_empty_every_time() {
        let registry = PeerRegistry::new(8);
        assert_eq!(registry.count(), 0);
        assert!(registry.list().is_empty());
        assert_eq!(registry.max_peers(), 8);
    }

    #[test]
    fn join_returns_self_and_others() {
        let registry = PeerRegistry::new(8);
        let (a, others) = registry.join(Some("Alice")).unwrap();
        assert_eq!(a.name, "Alice");
        assert!(others.is_empty());

        let (b, others) = registry.join(Some("Bob")).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(others, vec![a.clone()]);
        assert_eq!(registry.count(), 2);
        assert!(registry.contains(&a.id));
    }

    #[test]
    fn leave_removes_and_lists_rest() {
        let registry = PeerRegistry::new(8);
        let (a, _) = registry.join(Some("A")).unwrap();
        let (b, _) = registry.join(Some("B")).unwrap();
        let rest = registry.leave(&a.id);
        assert_eq!(rest, vec![b.clone()]);
        assert_eq!(registry.count(), 1);

        let rest = registry.leave(&b.id);
        assert!(rest.is_empty());
        assert_eq!(registry.count(), 0);
        assert!(!registry.contains(&b.id));
    }

    #[test]
    fn leaving_unknown_peer_is_noop() {
        let registry = PeerRegistry::new(8);
        registry.join(None).unwrap();
        assert_eq!(registry.leave("nope").len(), 1);
    }

    #[test]
    fn max_peers_is_enforced() {
        let registry = PeerRegistry::new(2);
        assert!(registry.join(None).is_ok());
        assert!(registry.join(None).is_ok());
        assert_eq!(registry.join(None).unwrap_err(), JoinError::Full);
        assert_eq!(registry.count(), 2);
        // 有人离开后又能加入
        let first = registry.list()[0].id.clone();
        registry.leave(&first);
        assert!(registry.join(None).is_ok());
    }

    #[test]
    fn zero_max_peers_still_allows_one() {
        let registry = PeerRegistry::new(0);
        assert!(registry.join(None).is_ok());
        assert!(registry.join(None).is_err());
    }

    #[test]
    fn duplicate_names_are_allowed() {
        let registry = PeerRegistry::new(8);
        registry.join(Some("同名")).unwrap();
        let (second, _) = registry.join(Some("同名")).unwrap();
        assert_eq!(second.name, "同名");
    }

    #[test]
    fn name_is_sanitized() {
        assert_eq!(sanitize_name(Some("  Alice   Bob "), "p1"), "Alice Bob");
        assert_eq!(sanitize_name(Some(""), "p7"), "访客-p7");
        assert_eq!(sanitize_name(None, "p7"), "访客-p7");
        assert_eq!(sanitize_name(Some("bad\u{7}name\n"), "p1"), "badname");
        let long = "字".repeat(100);
        assert_eq!(sanitize_name(Some(&long), "p1").chars().count(), 32);
    }

    #[test]
    fn rate_limiter_resets_after_window() {
        let t0 = Instant::now();
        let mut limiter =
            RateLimiter::starting_at(RateLimit::new(2, Duration::from_secs(10)), t0);
        assert!(limiter.check(t0));
        assert!(limiter.check(t0));
        assert!(!limiter.check(t0), "窗口内超过容量必须被拒绝");
        assert!(
            limiter.check(t0 + Duration::from_secs(10)),
            "新窗口应当重新放行"
        );
    }

    #[test]
    fn rate_limit_has_sane_defaults() {
        let limit = RateLimit::default();
        assert_eq!(limit.capacity, 60);
        assert_eq!(limit.window, Duration::from_secs(1));
        assert_eq!(RateLimit::new(0, Duration::from_secs(1)).capacity, 1);
    }

    #[test]
    fn client_messages_parse() {
        let hello = parse_client_message(r#"{"t":"hello","name":"Alice"}"#).unwrap();
        assert_eq!(
            hello,
            ClientMessage::Hello {
                name: Some("Alice".into())
            }
        );

        let bare = parse_client_message(r#"{"t":"hello"}"#).unwrap();
        assert_eq!(bare, ClientMessage::Hello { name: None });

        let list = parse_client_message(r#"{"t":"list"}"#).unwrap();
        assert_eq!(list, ClientMessage::List);

        let signal =
            parse_client_message(r#"{"t":"signal","to":"p2","data":{"sdp":"v=0"}}"#).unwrap();
        match signal {
            ClientMessage::Signal { to, data } => {
                assert_eq!(to, "p2");
                assert_eq!(data["sdp"], "v=0");
            }
            other => panic!("expected signal, got {other:?}"),
        }
    }

    #[test]
    fn bad_client_messages_are_rejected() {
        for bad in [
            "not json",
            "{}",
            r#"{"t":"nope"}"#,
            r#"{"t":"signal"}"#,
            r#"{"t":"signal","to":123,"data":{}}"#,
            r#"[1,2,3]"#,
        ] {
            assert!(parse_client_message(bad).is_err(), "{bad} 应当解析失败");
        }
    }

    #[test]
    fn server_message_serializes_with_type_tag() {
        let msg = ServerMessage::Peers {
            peers: vec![PeerInfo {
                id: "p1".into(),
                name: "Alice".into(),
            }],
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "peers");
        assert_eq!(json["peers"][0]["id"], "p1");
        assert_eq!(json["peers"][0]["name"], "Alice");

        let err = ServerMessage::error("too-large", "太大");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["t"], "error");
        assert_eq!(json["code"], "too-large");
    }

    #[test]
    fn welcome_carries_self_peers_and_ice_config() {
        let hub = Hub::new(4, RateLimit::default(), vec!["stun:example.org:3478".into()]);
        let (tx, _rx) = mpsc::unbounded_channel();
        let (me, others) = hub.join(Some("Alice"), tx).unwrap();
        let msg = hub.welcome(me.clone(), others);
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "welcome");
        assert_eq!(json["self"]["id"], me.id);
        assert_eq!(json["ice_servers"][0], "stun:example.org:3478");
        assert_eq!(json["max_peers"], 4);
    }

    #[test]
    fn hub_routes_signals_between_peers() {
        let hub = Hub::new(4, RateLimit::default(), vec![]);
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        let (a, _) = hub.join(Some("A"), tx_a).unwrap();
        let (b, others) = hub.join(Some("B"), tx_b).unwrap();
        assert_eq!(others, vec![a.clone()]);
        assert_eq!(hub.count(), 2);

        assert!(hub.send_to(
            &b.id,
            ServerMessage::Signal {
                from: a.id.clone(),
                data: serde_json::json!({"sdp": "v=0"}),
            }
        ));
        let received = rx_b.try_recv().unwrap();
        match received {
            ServerMessage::Signal { from, data } => {
                assert_eq!(from, a.id);
                assert_eq!(data["sdp"], "v=0");
            }
            other => panic!("expected signal, got {other:?}"),
        }
        assert!(rx_a.try_recv().is_err(), "A 不应收到发给 B 的消息");

        assert!(!hub.send_to("p999", ServerMessage::error("unknown-peer", "x")));
    }

    #[test]
    fn hub_broadcasts_and_cleans_up_on_leave() {
        let hub = Hub::new(4, RateLimit::default(), vec![]);
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        let (a, _) = hub.join(Some("A"), tx_a).unwrap();
        let (b, _) = hub.join(Some("B"), tx_b).unwrap();

        hub.broadcast_peers();
        // 名单里不应包含接收者自己
        match rx_a.try_recv().unwrap() {
            ServerMessage::Peers { peers } => assert_eq!(peers, vec![b.clone()]),
            other => panic!("expected peers, got {other:?}"),
        }
        match rx_b.try_recv().unwrap() {
            ServerMessage::Peers { peers } => assert_eq!(peers, vec![a.clone()]),
            other => panic!("expected peers, got {other:?}"),
        }

        let remaining = hub.leave(&a.id);
        assert_eq!(remaining, vec![b.clone()]);
        assert_eq!(hub.count(), 1);
        assert!(!hub.send_to(&a.id, ServerMessage::error("x", "y")), "离开后不再可投递");
    }

    #[test]
    fn hub_enforces_max_peers() {
        let hub = Hub::new(1, RateLimit::default(), vec![]);
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        assert!(hub.join(None, tx1).is_ok());
        assert_eq!(hub.join(None, tx2).unwrap_err(), JoinError::Full);
    }
}
