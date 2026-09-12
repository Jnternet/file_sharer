//! 启动参数与校验。

use std::net::IpAddr;

use clap::Parser;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "file_sharer",
    version,
    about = "局域网文件直传：单产物、网页访问、P2P 不落地、断点续传、SHA-256 校验"
)]
pub struct Config {
    /// 监听地址（默认 0.0.0.0，局域网内可访问）
    #[arg(long, default_value = "0.0.0.0")]
    pub bind: IpAddr,

    /// 监听端口，0 表示随机分配空闲端口
    #[arg(long, default_value_t = 8080)]
    pub port: u16,

    /// 同时在线人数上限
    #[arg(long, default_value_t = 64)]
    pub max_peers: usize,

    /// 追加 ICE 服务器（可重复），例如 stun:stun.example.org:3478
    #[arg(long = "ice-server", value_name = "URL")]
    pub ice_servers: Vec<String>,

    /// 只输出错误日志
    #[arg(long)]
    pub quiet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("max_peers 至少为 1（当前 {0}）")]
    MaxPeersZero(usize),
    #[error("ICE 服务器地址必须以 stun: / stuns: / turn: / turns: 开头：{0}")]
    BadIceServer(String),
}

impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.max_peers == 0 {
            return Err(ConfigError::MaxPeersZero(self.max_peers));
        }
        for url in &self.ice_servers {
            let lower = url.trim().to_ascii_lowercase();
            let ok = ["stun:", "stuns:", "turn:", "turns:"]
                .iter()
                .any(|p| lower.starts_with(p));
            if !ok || lower.len() < 6 {
                return Err(ConfigError::BadIceServer(url.clone()));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Config {
        Config {
            bind: "0.0.0.0".parse().unwrap(),
            port: 8080,
            max_peers: 64,
            ice_servers: vec![],
            quiet: false,
        }
    }

    #[test]
    fn default_config_is_valid() {
        assert!(base().validate().is_ok());
    }

    #[test]
    fn port_zero_means_ephemeral_and_is_allowed() {
        let cfg = Config { port: 0, ..base() };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn max_peers_zero_is_rejected() {
        let cfg = Config {
            max_peers: 0,
            ..base()
        };
        assert_eq!(cfg.validate(), Err(ConfigError::MaxPeersZero(0)));
    }

    #[test]
    fn ice_server_scheme_is_checked() {
        let ok = Config {
            ice_servers: vec!["stun:stun.example.org:3478".into()],
            ..base()
        };
        assert!(ok.validate().is_ok());

        for bad in ["stun.example.org:3478", "http://x", "stun:", "turn:"] {
            let cfg = Config {
                ice_servers: vec![bad.into()],
                ..base()
            };
            assert!(cfg.validate().is_err(), "{bad} 应当被拒绝");
        }
    }

    #[test]
    fn cli_parses_flags() {
        let cfg = Config::try_parse_from([
            "file_sharer",
            "--port",
            "0",
            "--bind",
            "127.0.0.1",
            "--max-peers",
            "3",
            "--ice-server",
            "stun:example.org:3478",
        ])
        .unwrap();
        assert_eq!(cfg.port, 0);
        assert_eq!(cfg.bind.to_string(), "127.0.0.1");
        assert_eq!(cfg.max_peers, 3);
        assert_eq!(cfg.ice_servers, vec!["stun:example.org:3478"]);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn cli_rejects_bad_ip() {
        assert!(Config::try_parse_from(["file_sharer", "--bind", "not-an-ip"]).is_err());
    }
}
