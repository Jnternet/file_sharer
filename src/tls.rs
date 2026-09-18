//! HTTPS 支持：自签名证书在**内存中生成**（不落盘，符合"空桶"），也可用 `--cert/--key` 指定现成证书。
//!
//! 为什么要 HTTPS：浏览器推荐的目录选择 API（File System Access，`showDirectoryPicker`）
//! 只在**安全上下文**（https 或 localhost）下可用；局域网用 http 明文访问时，
//! 浏览器只能退回到行为不一致的旧接口，Linux 上就表现为"弹的是选择文件对话框"。

use std::path::Path;

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;

pub struct TlsMaterial {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    /// 证书指纹（SHA-256 十六进制），打印给用户核对
    pub fingerprint: String,
    /// 自签名证书里写入的访问域名/IP
    pub subjects: Vec<String>,
}

/// 生成自签名证书（ECDSA P-256，SAN 里带上 localhost 与局域网地址）。
pub fn self_signed(hosts: &[String]) -> Result<TlsMaterial> {
    let subjects: Vec<String> = hosts
        .iter()
        .filter(|h| !h.trim().is_empty())
        .cloned()
        .collect();
    let key_pair = rcgen::KeyPair::generate().context("生成私钥失败")?;
    let params = rcgen::CertificateParams::new(subjects.clone()).context("构造证书参数失败")?;
    let cert = params
        .self_signed(&key_pair)
        .context("签发自签名证书失败")?;
    let fingerprint = sha256_hex(cert.der().as_ref());
    Ok(TlsMaterial {
        cert_pem: cert.pem().into_bytes(),
        key_pem: key_pair.serialize_pem().into_bytes(),
        fingerprint,
        subjects,
    })
}

/// 读取用户提供的证书/私钥（PEM）。
pub fn from_files(cert_path: &Path, key_path: &Path) -> Result<TlsMaterial> {
    let cert_pem = std::fs::read(cert_path)
        .with_context(|| format!("读取证书失败：{}", cert_path.display()))?;
    let key_pem =
        std::fs::read(key_path).with_context(|| format!("读取私钥失败：{}", key_path.display()))?;
    Ok(TlsMaterial {
        fingerprint: String::from("(使用提供的证书)"),
        subjects: Vec::new(),
        cert_pem,
        key_pem,
    })
}

impl TlsMaterial {
    pub async fn into_config(self) -> Result<(RustlsConfig, String, Vec<String>)> {
        let config = RustlsConfig::from_pem(self.cert_pem, self.key_pem)
            .await
            .context("加载 TLS 证书/私钥失败")?;
        Ok((config, self.fingerprint, self.subjects))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_signed_produces_pem_and_fingerprint() {
        let material = self_signed(&["localhost".into(), "192.168.1.23".into()]).unwrap();
        let cert = String::from_utf8(material.cert_pem.clone()).unwrap();
        let key = String::from_utf8(material.key_pem.clone()).unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE"));
        assert!(key.contains("BEGIN PRIVATE KEY"));
        assert_eq!(material.fingerprint.len(), 64);
        assert!(material.fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(material.subjects, vec!["localhost", "192.168.1.23"]);
    }

    #[test]
    fn each_run_gets_a_fresh_certificate() {
        let first = self_signed(&["localhost".into()]).unwrap();
        let second = self_signed(&["localhost".into()]).unwrap();
        assert_ne!(first.cert_pem, second.cert_pem, "每次启动应生成不同证书");
        assert_ne!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn blank_hosts_are_filtered() {
        let material = self_signed(&["localhost".into(), "  ".into()]).unwrap();
        assert_eq!(material.subjects, vec!["localhost"]);
    }
}
