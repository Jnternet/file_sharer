//! 局域网地址探测与展示（启动横幅用）。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

/// 探测本机在局域网中的地址。
///
/// 通过"连接"一个外部地址（不会真正发包）让内核选出默认出口网卡。
/// 没有默认路由（纯离线局域网）时返回 None，此时只展示 127.0.0.1。
pub fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket.connect(SocketAddr::from(([8, 8, 8, 8], 80))).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip)
    }
}

/// 根据监听地址与协议决定打印哪些访问 URL（纯函数，便于测试）。
pub fn advertised_urls(scheme: &str, bind: IpAddr, port: u16, lan: Option<IpAddr>) -> Vec<String> {
    let mut out = Vec::new();
    match bind {
        IpAddr::V4(v4) if v4.is_unspecified() => {
            out.push(format!("{scheme}://127.0.0.1:{port}/"));
            if let Some(ip) = lan {
                out.push(format!("{scheme}://{ip}:{port}/"));
            }
        }
        IpAddr::V6(v6) if v6.is_unspecified() => {
            out.push(format!("{scheme}://[::1]:{port}/"));
            if let Some(ip) = lan {
                out.push(format!("{scheme}://{ip}:{port}/"));
            }
        }
        other => out.push(format!("{scheme}://{}:{}/", format_host(other), port)),
    }
    out
}

fn format_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_bind_advertises_loopback_and_lan() {
        let urls = advertised_urls(
            "http",
            "0.0.0.0".parse().unwrap(),
            8080,
            Some("192.168.1.7".parse().unwrap()),
        );
        assert_eq!(
            urls,
            vec!["http://127.0.0.1:8080/", "http://192.168.1.7:8080/"]
        );
    }

    #[test]
    fn unspecified_bind_without_lan_only_shows_loopback() {
        let urls = advertised_urls("http", "0.0.0.0".parse().unwrap(), 1, None);
        assert_eq!(urls, vec!["http://127.0.0.1:1/"]);
    }

    #[test]
    fn loopback_bind_is_not_advertised_as_lan() {
        let urls = advertised_urls(
            "http",
            "127.0.0.1".parse().unwrap(),
            9000,
            Some("10.0.0.5".parse().unwrap()),
        );
        assert_eq!(urls, vec!["http://127.0.0.1:9000/"]);
    }

    #[test]
    fn specific_ip_and_ipv6_are_formatted() {
        assert_eq!(
            advertised_urls("http", "10.0.0.5".parse().unwrap(), 80, None),
            vec!["http://10.0.0.5:80/"]
        );
        assert_eq!(
            advertised_urls("https", "::1".parse().unwrap(), 80, None),
            vec!["https://[::1]:80/"]
        );
    }

    #[test]
    fn lan_ip_probe_never_panics() {
        let _ = lan_ip();
    }
}
