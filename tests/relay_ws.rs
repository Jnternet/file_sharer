//! WebSocket 转发集成测试：真实端口 + 真实客户端。
//!
//! 这里最重要的三条：
//!   * 定向：消息只到指定目标，第三者收不到（不广播）
//!   * 被动：服务器不主动推送任何东西（空闲连接收不到消息）
//!   * 透明：二进制帧原样转发，服务器不解析

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use file_sharer::signal::RateLimit;
use file_sharer::{AppState, build_router};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

async fn spawn(max_sessions: usize, rate: RateLimit) -> SocketAddr {
    let app = build_router(AppState::with_rate_limit(max_sessions, rate));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

async fn spawn_default() -> SocketAddr {
    spawn(16, RateLimit::default()).await
}

async fn connect(addr: SocketAddr) -> Ws {
    let (ws, _) = connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("WS 握手失败");
    ws
}

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .expect("发送失败");
}

async fn send_text(ws: &mut Ws, text: &str) {
    ws.send(Message::Text(text.into())).await.expect("发送失败");
}

async fn next_message(ws: &mut Ws) -> Message {
    tokio::time::timeout(WAIT, ws.next())
        .await
        .expect("等待消息超时")
        .expect("连接已关闭")
        .expect("读取失败")
}

async fn next_json(ws: &mut Ws) -> Value {
    match next_message(ws).await {
        Message::Text(text) => serde_json::from_str(text.as_str()).expect("服务端应发送 JSON"),
        other => panic!("意外的消息类型：{other:?}"),
    }
}

async fn join(addr: SocketAddr, name: &str) -> (Ws, String) {
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "hello", "name": name})).await;
    let welcome = next_json(&mut ws).await;
    assert_eq!(welcome["t"], "welcome");
    let id = welcome["self"]["id"].as_str().unwrap().to_string();
    (ws, id)
}

/// 断言在给定时间内没有收到任何消息（"不广播 / 不主动推送"）。
async fn assert_silent(ws: &mut Ws, within: Duration, label: &str) {
    match tokio::time::timeout(within, ws.next()).await {
        Err(_) => {}
        Ok(None) => {}
        Ok(Some(Ok(message))) => panic!("{label}：不应收到任何消息，实际收到 {message:?}"),
        Ok(Some(Err(err))) => panic!("{label}：连接异常 {err}"),
    }
}

async fn expect_close(ws: &mut Ws) -> Option<String> {
    for _ in 0..20 {
        match tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("等待关闭超时")
        {
            Some(Ok(Message::Close(frame))) => return frame.map(|f| f.reason.to_string()),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
    panic!("连接始终没有关闭");
}

#[tokio::test]
async fn welcome_only_carries_your_own_session() {
    let addr = spawn_default().await;
    let (_ws, _id) = join(addr, "Alice").await;
}

#[tokio::test]
async fn joining_does_not_notify_anyone() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;

    let (mut b, b_id) = join(addr, "Bob").await;
    assert!(!b_id.is_empty());

    // A 没有请求任何东西，因此不应该收到任何消息（不广播）
    assert_silent(&mut a, Duration::from_millis(300), "有人加入时").await;

    // B 断开同样不会通知 A
    b.close(None).await.unwrap();
    drop(b);
    assert_silent(&mut a, Duration::from_millis(300), "有人离开时").await;
}

#[tokio::test]
async fn sessions_are_pulled_on_request() {
    let addr = spawn_default().await;
    let (mut a, a_id) = join(addr, "Alice").await;
    let (_b, b_id) = join(addr, "Bob").await;

    send_json(&mut a, json!({"t": "sessions"})).await;
    let sessions = next_json(&mut a).await;
    assert_eq!(sessions["t"], "sessions");
    let ids: Vec<String> = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec![b_id], "只返回别人，不含自己");
    assert!(!ids.contains(&a_id));
    assert_eq!(sessions["sessions"][0]["name"], "Bob");
}

#[tokio::test]
async fn relay_is_targeted_and_not_echoed() {
    let addr = spawn_default().await;
    let (mut a, a_id) = join(addr, "Alice").await;
    let (mut b, b_id) = join(addr, "Bob").await;
    let (mut c, _c_id) = join(addr, "Carol").await;

    let payload = json!({"k": "index-request"});
    send_json(
        &mut a,
        json!({"t": "relay", "to": b_id, "payload": payload}),
    )
    .await;

    let relayed = next_json(&mut b).await;
    assert_eq!(relayed["t"], "relay");
    assert_eq!(relayed["from"], a_id);
    assert_eq!(relayed["payload"], payload);

    // 发送方不应收到回显，第三者也不应收到任何东西
    assert_silent(&mut a, Duration::from_millis(250), "转发后发送方").await;
    assert_silent(&mut c, Duration::from_millis(250), "转发后第三者").await;
}

#[tokio::test]
async fn relay_to_unknown_session_errors() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;

    send_json(
        &mut a,
        json!({"t": "relay", "to": "s999", "payload": {"k": "x"}}),
    )
    .await;
    let err = next_json(&mut a).await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "unknown-session");
}

#[tokio::test]
async fn relay_payload_is_opaque() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;
    let (mut b, b_id) = join(addr, "Bob").await;

    // 故意放入服务器完全无法理解的内容（服务器不得解析、不得改写）
    let payload = json!({
        "k": "manifest",
        "files": [{"path": "相册/照片.bin", "size": 4096, "sha256": "ab".repeat(32)}],
        "chunkSize": 1048576,
        "nested": {"deep": [1, 2, {"x": "汉字"}]}
    });
    send_json(
        &mut a,
        json!({"t": "relay", "to": b_id, "payload": payload}),
    )
    .await;
    let relayed = next_json(&mut b).await;
    assert_eq!(relayed["payload"], payload);
}

#[tokio::test]
async fn binary_frames_are_forwarded_verbatim_to_the_bound_target() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;
    let (mut b, b_id) = join(addr, "Bob").await;
    let (mut c, _c_id) = join(addr, "Carol").await;

    send_json(&mut a, json!({"t": "bind", "to": b_id})).await;
    let bound = next_json(&mut a).await;
    assert_eq!(bound["t"], "bound");
    assert_eq!(bound["to"], b_id);

    // 任意字节（含非法 JSON）都应原样到达
    let frame: Vec<u8> = (0..=255u8).chain([0, 255, 7, 42]).collect();
    a.send(Message::Binary(frame.clone().into())).await.unwrap();

    match next_message(&mut b).await {
        Message::Binary(bytes) => assert_eq!(bytes.as_ref(), frame.as_slice()),
        other => panic!("期望二进制帧，实际 {other:?}"),
    }
    assert_silent(&mut c, Duration::from_millis(250), "二进制转发后第三者").await;
    assert_silent(&mut a, Duration::from_millis(250), "二进制转发后发送方").await;
}

#[tokio::test]
async fn binary_without_binding_is_rejected() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;

    a.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "unbound");
}

#[tokio::test]
async fn binding_to_unknown_session_errors_and_unbind_stops_forwarding() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;
    let (mut b, b_id) = join(addr, "Bob").await;

    send_json(&mut a, json!({"t": "bind", "to": "s999"})).await;
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "unknown-session");

    send_json(&mut a, json!({"t": "bind", "to": b_id})).await;
    let _ = next_json(&mut a).await;
    send_json(&mut a, json!({"t": "unbind"})).await;
    a.send(Message::Binary(vec![9].into())).await.unwrap();
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "unbound");
    assert_silent(&mut b, Duration::from_millis(200), "解绑后").await;
}

#[tokio::test]
async fn oversized_binary_frame_is_rejected() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;
    let (_b, b_id) = join(addr, "Bob").await;
    send_json(&mut a, json!({"t": "bind", "to": b_id})).await;
    let _ = next_json(&mut a).await;

    let huge = vec![0u8; file_sharer::signal::MAX_BINARY_BYTES + 1];
    a.send(Message::Binary(huge.into())).await.unwrap();
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "too-large");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn bad_json_is_reported_but_connection_survives() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;

    send_text(&mut a, "这不是 JSON").await;
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "bad-request");

    send_json(&mut a, json!({"t": "sessions"})).await;
    let sessions = next_json(&mut a).await;
    assert_eq!(sessions["t"], "sessions");
}

#[tokio::test]
async fn hello_is_required_as_first_message() {
    let addr = spawn_default().await;
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "sessions"})).await;

    let err = next_json(&mut ws).await;
    assert_eq!(err["code"], "hello-required");
    expect_close(&mut ws).await;
}

#[tokio::test]
async fn oversized_text_is_rejected_and_closed() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;

    let big = json!({"t": "relay", "to": "s2", "payload": {"pad": "x".repeat(70 * 1024)}});
    send_text(&mut a, &big.to_string()).await;

    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "too-large");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn rate_limit_kicks_in_and_closes() {
    let addr = spawn(16, RateLimit::new(3, Duration::from_secs(60))).await;
    let (mut a, _) = join(addr, "Alice").await; // hello 计 1 次

    send_json(&mut a, json!({"t": "sessions"})).await;
    let _ = next_json(&mut a).await;
    send_json(&mut a, json!({"t": "sessions"})).await;
    let _ = next_json(&mut a).await;
    send_json(&mut a, json!({"t": "sessions"})).await;

    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "rate-limited");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn server_full_is_reported() {
    let addr = spawn(1, RateLimit::default()).await;
    let (_a, _) = join(addr, "Alice").await;

    let mut b = connect(addr).await;
    send_json(&mut b, json!({"t": "hello", "name": "Bob"})).await;
    let err = next_json(&mut b).await;
    assert_eq!(err["code"], "server-full");
    expect_close(&mut b).await;
}

#[tokio::test]
async fn disconnect_removes_session_from_registry() {
    let addr = spawn_default().await;
    let (mut a, _) = join(addr, "Alice").await;
    let (b, b_id) = join(addr, "Bob").await;

    let mut b = b;
    b.close(None).await.unwrap();
    drop(b);
    // 等服务器处理完断开
    tokio::time::sleep(Duration::from_millis(200)).await;

    send_json(&mut a, json!({"t": "sessions"})).await;
    let sessions = next_json(&mut a).await;
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 0);

    // 给已经离开的会话发消息 → 明确报错
    send_json(&mut a, json!({"t": "relay", "to": b_id, "payload": {}})).await;
    let err = next_json(&mut a).await;
    assert_eq!(err["code"], "unknown-session");
}

#[tokio::test]
async fn session_ids_and_names_are_sane() {
    let addr = spawn_default().await;
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "hello"})).await;
    let welcome = next_json(&mut ws).await;
    let id = welcome["self"]["id"].as_str().unwrap();
    assert!(id.starts_with('s'));
    assert_eq!(welcome["self"]["name"], format!("访客-{id}"));
}

#[tokio::test]
async fn channel_is_usable_for_relay_and_bind_after_reconnect() {
    // 服务器端不保存任何状态：断开重连后绑定关系也归零
    let addr = spawn_default().await;
    let (mut a, a_id) = join(addr, "Alice").await;
    let (_b, b_id) = join(addr, "Bob").await;
    send_json(&mut a, json!({"t": "bind", "to": b_id})).await;
    let _ = next_json(&mut a).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let (mut a2, a_id2) = join(addr, "Alice2").await;
    assert_ne!(a_id, a_id2);
    a2.send(Message::Binary(vec![1].into())).await.unwrap();
    let err = next_json(&mut a2).await;
    assert_eq!(err["code"], "unbound", "重连后不应残留任何绑定");
}
