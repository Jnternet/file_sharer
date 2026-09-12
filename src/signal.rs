//! 在线名单（信令的纯逻辑部分，不依赖 axum，便于单测）。
//!
//! 这里是服务器唯一持有的"状态"：一份内存中的 peer 名单。
//! 进程退出即清空 —— 也就是"每次启动后都是一个空桶"（需求 R3）。

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

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
}
