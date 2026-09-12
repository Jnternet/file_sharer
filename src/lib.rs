//! 服务器装配：内嵌静态站点 + JSON API + WebSocket 信令（HTTP 部分可被测试直接调用）。

pub mod assets;
pub mod config;
pub mod net;
pub mod signal;
pub mod ws;

use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router as AxumRouter};
use serde::Serialize;

use assets::Asset;
use signal::{Hub, PeerRegistry, RateLimit};

pub const APP_NAME: &str = "file_sharer";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub started: Arc<Instant>,
}

impl AppState {
    pub fn new(max_peers: usize, ice_servers: Vec<String>) -> Self {
        Self::with_rate_limit(max_peers, ice_servers, RateLimit::default())
    }

    pub fn with_rate_limit(max_peers: usize, ice_servers: Vec<String>, rate: RateLimit) -> Self {
        Self {
            hub: Arc::new(Hub::new(max_peers, rate, ice_servers)),
            started: Arc::new(Instant::now()),
        }
    }

    pub fn registry(&self) -> Arc<PeerRegistry> {
        self.hub.registry().clone()
    }

    pub fn max_peers(&self) -> usize {
        // 注册表内部会把 0 收敛为 1，这里对外暴露同样的语义
        self.hub.max_peers()
    }
}

#[derive(Serialize)]
struct InfoResponse {
    name: &'static str,
    version: &'static str,
    peers: usize,
    max_peers: usize,
    uptime_ms: u64,
    /// 明确告知客户端：服务器端没有任何持久化（每次启动都是空桶）
    persistence: &'static str,
    ice_servers: Vec<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

pub fn build_router(state: AppState) -> Router {
    AxumRouter::new()
        .route("/", get(serve_index))
        .route("/api/health", get(health))
        .route("/api/info", get(info))
        .route("/ws", get(ws::ws_handler))
        .fallback(get(serve_static_or_404))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

async fn info(State(state): State<AppState>) -> impl IntoResponse {
    Json(InfoResponse {
        name: APP_NAME,
        version: VERSION,
        peers: state.hub.count(),
        max_peers: state.max_peers(),
        uptime_ms: state.started.elapsed().as_millis() as u64,
        persistence: "none",
        ice_servers: state.hub.ice_servers().to_vec(),
    })
}

async fn serve_index(headers: HeaderMap) -> Response {
    respond_with(headers, &assets::index_html(), "no-cache")
}

async fn serve_static_or_404(OriginalUri(uri): OriginalUri, headers: HeaderMap) -> Response {
    let url_path = uri.path().to_string();
    if url_path.starts_with("/api/") || url_path == "/ws" {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "not_found" }),
        )
            .into_response();
    }
    match assets::resolve(&url_path) {
        Some(asset) => respond_with(headers, &asset, "no-cache"),
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}

/// 统一处理 ETag 条件请求与缓存头。
fn respond_with(headers: HeaderMap, asset: &Asset, cache_control: &str) -> Response {
    let etag = asset.etag();
    let inm = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if inm.split(',').any(|candidate| candidate.trim() == etag) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, asset.mime.to_string()),
            (header::CACHE_CONTROL, cache_control.to_string()),
            (header::ETAG, etag),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        asset.bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_starts_with_no_peers() {
        let state = AppState::new(4, vec![]);
        assert_eq!(state.registry().count(), 0);
        assert_eq!(state.max_peers(), 4);
    }
}
