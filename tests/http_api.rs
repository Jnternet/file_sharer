//! HTTP 集成测试：静态站点、JSON API、404/405、路径穿越、无上传路由。

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use http_body_util::BodyExt;
use tower::ServiceExt;

use file_sharer::{AppState, VERSION, build_router};

fn app() -> Router {
    build_router(AppState::new(16))
}

async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .unwrap_or_else(|| panic!("缺少响应头 {name}"))
        .to_str()
        .unwrap()
}

#[tokio::test]
async fn serves_embedded_index_page() {
    let (status, headers, body) = request(&app(), "GET", "/", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(header(&headers, "content-type").starts_with("text/html"));
    assert_eq!(header(&headers, "cache-control"), "no-cache");
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    assert!(headers.contains_key(header::ETAG));
    let html = String::from_utf8(body).unwrap();
    assert!(html.to_lowercase().contains("<html"), "应当返回 HTML 页面");
}

#[tokio::test]
async fn conditional_request_returns_304() {
    let app = app();
    let (_, headers, _) = request(&app, "GET", "/", &[]).await;
    let etag = header(&headers, "etag").to_string();

    let (status, _, body) = request(&app, "GET", "/", &[("if-none-match", &etag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
}

#[tokio::test]
async fn health_endpoint() {
    let (status, headers, body) = request(&app(), "GET", "/api/health", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(header(&headers, "content-type").starts_with("application/json"));
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn info_endpoint_reports_empty_bucket_and_no_persistence() {
    let (status, _, body) = request(&app(), "GET", "/api/info", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["name"], "file_sharer");
    assert_eq!(json["version"], VERSION);
    assert_eq!(json["sessions"], 0, "刚启动时没有任何在线会话（空桶）");
    assert_eq!(json["persistence"], "none", "服务器端零持久化");
    assert_eq!(
        json["records"], "none",
        "服务器不保存文件内容，也不保存文件清单"
    );
    assert_eq!(json["max_sessions"], 16);
}

#[tokio::test]
async fn info_endpoint_reflects_live_peer_count() {
    let state = AppState::new(16);
    let registry = state.sessions();
    let app = build_router(state);

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let joined = registry.join(Some("Alice"), tx).unwrap();
    let (_, _, body) = request(&app, "GET", "/api/info", &[]).await;
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["sessions"], 1);

    registry.leave(&joined.id);
    let (_, _, body) = request(&app, "GET", "/api/info", &[]).await;
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["sessions"], 0, "会话离开后表清空");
}

#[tokio::test]
async fn unknown_paths_are_404() {
    let app = app();

    let (status, _, _) = request(&app, "GET", "/no-such-file.js", &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, headers, body) = request(&app, "GET", "/api/nope", &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(header(&headers, "content-type").starts_with("application/json"));
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], "not_found");
}

#[tokio::test]
async fn method_not_allowed_on_api() {
    let (status, _, _) = request(&app(), "POST", "/api/health", &[]).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn there_is_no_upload_route_on_the_server() {
    // 需求 R4：文件字节永远不经过服务器，服务器不存在任何接收文件的入口。
    let app = app();
    for (method, uri) in [
        ("POST", "/upload"),
        ("PUT", "/api/upload"),
        ("POST", "/api/files"),
        ("PUT", "/"),
    ] {
        let (status, _, _) = request(&app, method, uri, &[]).await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri} 不应被接受，实际 {status}"
        );
    }
}

#[tokio::test]
async fn path_traversal_is_blocked() {
    let app = app();
    for uri in [
        "/../Cargo.toml",
        "/%2e%2e/Cargo.toml",
        "/assets/../../Cargo.toml",
        "/.git/config",
    ] {
        let (status, _, body) = request(&app, "GET", uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} 必须 404");
        let text = String::from_utf8_lossy(&body);
        assert!(!text.contains("[package]"), "{uri} 泄漏了源码");
        assert!(
            !text.contains("repositoryformatversion"),
            "{uri} 泄漏了 .git"
        );
    }
}

#[tokio::test]
async fn head_request_is_supported_on_index() {
    let (status, headers, body) = request(&app(), "HEAD", "/", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(header(&headers, "content-type").starts_with("text/html"));
    assert!(body.is_empty(), "HEAD 不应返回响应体");
}
