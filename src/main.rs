//! 单产物入口：CLI → 监听 → 打印局域网地址 → 提供网页 + 信令。

use std::process::ExitCode;

use anyhow::Context;
use axum_server::Handle;
use clap::Parser;
use file_sharer::assets;
use file_sharer::config::Config;
use file_sharer::net;
use file_sharer::tls;
use file_sharer::{APP_NAME, AppState, VERSION, build_router};
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    let config = Config::parse();
    init_tracing(config.quiet);

    if let Err(err) = config.validate() {
        error!("启动参数不合法：{err}");
        return ExitCode::from(2);
    }

    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            error!("{err:#}");
            ExitCode::from(1)
        }
    }
}

async fn run(config: Config) -> anyhow::Result<()> {
    // 启动前先确认内嵌资源完整（单产物自检）
    let _ = assets::index_html();

    let state = AppState::new(config.max_sessions);
    let app = build_router(state);

    if config.uses_tls() {
        serve_tls(&config, app).await?;
    } else {
        let listener = TcpListener::bind((config.bind, config.port))
            .await
            .with_context(|| format!("无法监听 {}:{}", config.bind, config.port))?;
        let addr = listener.local_addr()?;
        print_banner(&config, addr.port(), "http", None);
        info!(%addr, "server listening (http)");
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .context("HTTP 服务异常退出")?;
    }

    println!("已退出，服务器端未保留任何数据。");
    Ok(())
}

fn print_banner(config: &Config, port: u16, scheme: &str, tls_note: Option<(&str, &[String])>) {
    println!("{APP_NAME} {VERSION} 已启动（服务器只做定向转发：不记录、不留存）");
    for url in net::advertised_urls(scheme, config.bind, port, net::lan_ip()) {
        if url.contains("127.0.0.1") || url.contains("[::1]") {
            println!("  本机:   {url}");
        } else {
            println!("  局域网: {url}");
        }
    }
    println!("  在线会话上限: {}（Ctrl+C 退出）", config.max_sessions);
    if let Some((fingerprint, subjects)) = tls_note {
        if !subjects.is_empty() {
            println!(
                "  HTTPS（自签名证书，内存生成不落盘）：{}",
                subjects.join("、")
            );
            println!("  证书 SHA-256 指纹: {fingerprint}");
        }
        println!("  浏览器会提示证书不受信任：这是自签名证书，选择「继续访问」即可。");
        println!(
            "  安全上下文的用处：Chrome/Edge 在 https 下可用系统目录选择器（showDirectoryPicker）。"
        );
    }
}

/// HTTPS 分支：自签名（默认）或用户提供的 --cert/--key。
async fn serve_tls(config: &Config, app: axum::Router) -> anyhow::Result<()> {
    let material = match (&config.cert, &config.key) {
        (Some(cert), Some(key)) => tls::from_files(cert, key)?,
        _ => {
            let mut hosts = vec!["localhost".to_string(), "127.0.0.1".to_string()];
            if let Some(ip) = net::lan_ip() {
                hosts.push(ip.to_string());
            }
            if let Ok(name) = std::env::var("HOSTNAME") {
                hosts.push(name);
            }
            tls::self_signed(&hosts)?
        }
    };
    let (tls_config, fingerprint, subjects) = material.into_config().await?;

    // 先绑定拿到真实端口（支持 --port 0），再交给 axum-server
    let listener = std::net::TcpListener::bind((config.bind, config.port))
        .with_context(|| format!("无法监听 {}:{}", config.bind, config.port))?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;

    print_banner(
        config,
        addr.port(),
        "https",
        Some((&fingerprint, &subjects)),
    );
    info!(%addr, "server listening (https)");

    let handle = Handle::new();
    let shutdown = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        shutdown.graceful_shutdown(Some(std::time::Duration::from_secs(3)));
    });

    axum_server::from_tcp_rustls(listener, tls_config)
        .handle(handle)
        .serve(app.into_make_service())
        .await
        .context("HTTPS 服务异常退出")?;

    Ok(())
}

fn init_tracing(quiet: bool) {
    let default = if quiet { "error" } else { "info" };
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("file_sharer={default},axum={default}")));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
