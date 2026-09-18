//! 服务器装配：内嵌静态站点 + JSON API + WebSocket 定向转发。
//!
//! 服务器不记录文件、不留存数据：内存里只有"谁在线"和"这条连接往哪转发"。

pub mod assets;
pub mod config;
pub mod net;
pub mod signal;
pub mod tls;
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
use signal::{RateLimit, Registry};

pub const APP_NAME: &str = "file_sharer";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    pub started: Arc<Instant>,
}

impl AppState {
    pub fn new(max_sessions: usize) -> Self {
        Self::with_rate_limit(max_sessions, RateLimit::default())
    }

    pub fn with_rate_limit(max_sessions: usize, rate: RateLimit) -> Self {
        Self {
            registry: Arc::new(Registry::with_rate_limit(max_sessions, rate)),
            started: Arc::new(Instant::now()),
        }
    }

    pub fn sessions(&self) -> Arc<Registry> {
        self.registry.clone()
    }

    pub fn max_sessions(&self) -> usize {
        self.registry.max_sessions()
    }
}

#[derive(Serialize)]
struct InfoResponse {
    name: &'static str,
    version: &'static str,
    sessions: usize,
    max_sessions: usize,
    uptime_ms: u64,
    /// 不落盘：每次启动都是空桶
    persistence: &'static str,
    /// 不保存文件内容，也不保存文件清单
    records: &'static str,
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
        sessions: state.registry.count(),
        max_sessions: state.max_sessions(),
        uptime_ms: state.started.elapsed().as_millis() as u64,
        persistence: "none",
        records: "none",
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
    fn state_starts_with_no_sessions() {
        let state = AppState::new(4);
        assert_eq!(state.registry.count(), 0);
        assert_eq!(state.max_sessions(), 4);
        assert_eq!(state.sessions().list().len(), 0);
    }
}
