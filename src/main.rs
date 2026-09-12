//! 单产物入口：CLI → 监听 → 打印局域网地址 → 提供网页 + 信令。

use std::process::ExitCode;

use anyhow::Context;
use clap::Parser;
use file_sharer::assets;
use file_sharer::config::Config;
use file_sharer::net;
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

    let state = AppState::new(config.max_peers, config.ice_servers.clone());
    let listener = TcpListener::bind((config.bind, config.port))
        .await
        .with_context(|| format!("无法监听 {}:{}", config.bind, config.port))?;
    let addr = listener.local_addr()?;

    println!("{APP_NAME} {VERSION} 已启动（服务器零存储：每次启动都是空桶）");
    for url in net::advertised_urls(config.bind, addr.port(), net::lan_ip()) {
        if url.contains("127.0.0.1") || url.contains("[::1]") {
            println!("  本机:   {url}");
        } else {
            println!("  局域网: {url}");
        }
    }
    println!("  在线人数上限: {}（Ctrl+C 退出）", config.max_peers);

    info!(%addr, "server listening");

    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP 服务异常退出")?;

    println!("已退出，服务器端未保留任何数据。");
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
