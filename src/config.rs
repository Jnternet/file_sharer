//! 启动参数与校验。

use std::net::IpAddr;
use std::path::PathBuf;

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

    /// 同时在线会话上限
    #[arg(long, default_value_t = 64)]
    pub max_sessions: usize,

    /// 只输出错误日志
    #[arg(long)]
    pub quiet: bool,

    /// 启用 HTTPS（自签名证书在内存中生成，不落盘；浏览器会提示证书不受信任，继续访问即可）
    #[arg(long)]
    pub tls: bool,

    /// 使用现成证书（PEM），需与 --key 一起给出；给出后自动启用 HTTPS
    #[arg(long, value_name = "FILE", requires = "key")]
    pub cert: Option<PathBuf>,

    /// 使用现成私钥（PEM），需与 --cert 一起给出
    #[arg(long, value_name = "FILE", requires = "cert")]
    pub key: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("max_sessions 至少为 1（当前 {0}）")]
    MaxSessionsZero(usize),
}

impl Config {
    /// 是否走 HTTPS：显式 --tls，或提供了 --cert/--key。
    pub fn uses_tls(&self) -> bool {
        self.tls || (self.cert.is_some() && self.key.is_some())
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.max_sessions == 0 {
            return Err(ConfigError::MaxSessionsZero(self.max_sessions));
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
            max_sessions: 64,
            quiet: false,
            tls: false,
            cert: None,
            key: None,
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
    fn max_sessions_zero_is_rejected() {
        let cfg = Config {
            max_sessions: 0,
            ..base()
        };
        assert_eq!(cfg.validate(), Err(ConfigError::MaxSessionsZero(0)));
    }

    #[test]
    fn cli_parses_flags() {
        let cfg = Config::try_parse_from([
            "file_sharer",
            "--port",
            "0",
            "--bind",
            "127.0.0.1",
            "--max-sessions",
            "3",
        ])
        .unwrap();
        assert_eq!(cfg.port, 0);
        assert_eq!(cfg.bind.to_string(), "127.0.0.1");
        assert_eq!(cfg.max_sessions, 3);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn cli_rejects_bad_ip() {
        assert!(Config::try_parse_from(["file_sharer", "--bind", "not-an-ip"]).is_err());
    }

    #[test]
    fn tls_flag_and_cert_pair_parse() {
        let tls = Config::try_parse_from(["file_sharer", "--tls"]).unwrap();
        assert!(tls.tls);
        assert!(tls.cert.is_none());

        let paired = Config::try_parse_from([
            "file_sharer",
            "--cert",
            "/tmp/cert.pem",
            "--key",
            "/tmp/key.pem",
        ])
        .unwrap();
        assert_eq!(
            paired.cert.as_deref(),
            Some(std::path::Path::new("/tmp/cert.pem"))
        );
        assert_eq!(
            paired.key.as_deref(),
            Some(std::path::Path::new("/tmp/key.pem"))
        );
    }

    #[test]
    fn cert_without_key_is_rejected() {
        assert!(Config::try_parse_from(["file_sharer", "--cert", "/tmp/cert.pem"]).is_err());
        assert!(Config::try_parse_from(["file_sharer", "--key", "/tmp/key.pem"]).is_err());
    }
}
