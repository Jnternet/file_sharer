//! WebSocket 信令集成测试：真实监听端口 + 真实 WS 客户端。

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

async fn spawn(max_peers: usize, rate: RateLimit) -> SocketAddr {
    let state = AppState::with_rate_limit(max_peers, vec!["stun:example.org:3478".into()], rate);
    let app = build_router(state);
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
    let (ws, _) = connect_async(format!("ws://{addr}/ws")).await.expect("WS 握手失败");
    ws
}

async fn hello(addr: SocketAddr, name: &str) -> (Ws, Value) {
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "hello", "name": name})).await;
    let welcome = next_json(&mut ws).await;
    assert_eq!(welcome["t"], "welcome");
    (ws, welcome)
}

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .expect("发送失败");
}

async fn send_text(ws: &mut Ws, text: &str) {
    ws.send(Message::Text(text.into())).await.expect("发送失败");
}

/// 读取下一条 JSON 消息；跳过同类型的其它消息由调用方处理。
async fn next_json(ws: &mut Ws) -> Value {
    let msg = tokio::time::timeout(WAIT, ws.next())
        .await
        .expect("等待消息超时")
        .expect("连接已关闭")
        .expect("读取失败");
    match msg {
        Message::Text(text) => serde_json::from_str(text.as_str()).expect("服务端应发送 JSON"),
        other => panic!("意外的消息类型：{other:?}"),
    }
}

/// 一直读到指定类型的消息（跳过其余消息），最多 20 条。
async fn next_of_type(ws: &mut Ws, kind: &str) -> Value {
    for _ in 0..20 {
        let msg = next_json(ws).await;
        if msg["t"] == kind {
            return msg;
        }
    }
    panic!("始终没有收到 {kind} 消息");
}

/// 断言在给定时间内没有收到指定类型的消息。
async fn assert_no_message_of_type(ws: &mut Ws, kind: &str, within: Duration) {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Err(_) => return,
            Ok(None) => return,
            Ok(Some(Err(_))) => return,
            Ok(Some(Ok(Message::Text(text)))) => {
                let msg: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_ne!(msg["t"], kind, "不应收到 {kind} 消息：{msg}");
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
}

/// 一直读到"指定人数的 peers"消息（跳过更早的名单广播）。
async fn next_peers_of_len(ws: &mut Ws, len: usize) -> Value {
    for _ in 0..20 {
        let msg = next_of_type(ws, "peers").await;
        if msg["peers"].as_array().unwrap().len() == len {
            return msg;
        }
    }
    panic!("始终没有收到 {len} 人的名单");
}

/// 等待连接被服务端关闭，返回关闭原因（可能为空）。
async fn expect_close(ws: &mut Ws) -> Option<String> {
    for _ in 0..20 {
        match tokio::time::timeout(WAIT, ws.next()).await.expect("等待关闭超时") {
            Some(Ok(Message::Close(frame))) => return frame.map(|f| f.reason.to_string()),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
    panic!("连接始终没有关闭");
}

#[tokio::test]
async fn welcome_carries_identity_and_ice_config() {
    let addr = spawn_default().await;
    let (_ws, welcome) = hello(addr, "Alice").await;

    assert_eq!(welcome["self"]["name"], "Alice");
    assert!(welcome["self"]["id"].as_str().unwrap().starts_with('p'));
    assert_eq!(welcome["peers"].as_array().unwrap().len(), 0, "第一个用户看不到别人");
    assert_eq!(welcome["ice_servers"][0], "stun:example.org:3478");
    assert_eq!(welcome["max_peers"], 16);
}

#[tokio::test]
async fn joining_peer_is_broadcast_to_everyone() {
    let addr = spawn_default().await;
    let (mut a, a_welcome) = hello(addr, "Alice").await;
    let a_id = a_welcome["self"]["id"].as_str().unwrap().to_string();

    // A 自己收到过一条 peers（名单里不含自己）
    let peers_a = next_of_type(&mut a, "peers").await;
    assert_eq!(peers_a["peers"].as_array().unwrap().len(), 0);

    let (mut b, b_welcome) = hello(addr, "Bob").await;
    let b_id = b_welcome["self"]["id"].as_str().unwrap().to_string();
    assert_ne!(a_id, b_id);
    assert_eq!(b_welcome["peers"].as_array().unwrap().len(), 1, "B 应看到 A");
    assert_eq!(b_welcome["peers"][0]["id"], a_id);

    let peers_a = next_of_type(&mut a, "peers").await;
    assert_eq!(peers_a["peers"].as_array().unwrap().len(), 1, "A 的名单里只有 B");
    assert_eq!(peers_a["peers"][0]["id"], b_id);
}

#[tokio::test]
async fn peer_list_never_contains_yourself() {
    let addr = spawn_default().await;
    let (mut a, a_welcome) = hello(addr, "Alice").await;
    assert_eq!(a_welcome["peers"].as_array().unwrap().len(), 0, "welcome 里不含自己");
    let a_id = a_welcome["self"]["id"].as_str().unwrap().to_string();

    let (mut b, b_welcome) = hello(addr, "Bob").await;
    let b_id = b_welcome["self"]["id"].as_str().unwrap().to_string();
    assert_eq!(b_welcome["peers"][0]["id"], a_id);

    for (ws, self_id, expected) in [
        (&mut a, a_id.clone(), b_id.clone()),
        (&mut b, b_id.clone(), a_id.clone()),
    ] {
        let peers = next_peers_of_len(ws, 1).await;
        let ids: Vec<String> = peers["peers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|peer| peer["id"].as_str().unwrap().to_string())
            .collect();
        assert!(!ids.contains(&self_id), "名单里不应出现自己");
        assert_eq!(ids, vec![expected]);
    }
}

#[tokio::test]
async fn signal_is_relayed_with_sender_id() {
    let addr = spawn_default().await;
    let (mut a, a_welcome) = hello(addr, "Alice").await;
    let a_id = a_welcome["self"]["id"].as_str().unwrap().to_string();
    let (mut b, b_welcome) = hello(addr, "Bob").await;
    let b_id = b_welcome["self"]["id"].as_str().unwrap().to_string();

    send_json(
        &mut a,
        json!({"t": "signal", "to": b_id, "data": {"sdp": "v=0", "kind": "offer"}}),
    )
    .await;

    let relayed = next_of_type(&mut b, "signal").await;
    assert_eq!(relayed["from"], a_id);
    assert_eq!(relayed["data"]["sdp"], "v=0");
    assert_eq!(relayed["data"]["kind"], "offer");

    // 服务器不应把消息回显给发送方
    assert_no_message_of_type(&mut a, "signal", Duration::from_millis(300)).await;
}

#[tokio::test]
async fn signaling_to_unknown_or_self_peer_errors() {
    let addr = spawn_default().await;
    let (mut a, a_welcome) = hello(addr, "Alice").await;
    let a_id = a_welcome["self"]["id"].as_str().unwrap().to_string();

    send_json(&mut a, json!({"t": "signal", "to": "p999", "data": {}})).await;
    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "unknown-peer");

    send_json(&mut a, json!({"t": "signal", "to": a_id, "data": {}})).await;
    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "invalid-target");
}

#[tokio::test]
async fn bad_json_is_reported_but_connection_survives() {
    let addr = spawn_default().await;
    let (mut a, _) = hello(addr, "Alice").await;

    send_text(&mut a, "这不是 JSON").await;
    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "bad-request");

    send_json(&mut a, json!({"t": "list"})).await;
    let peers = next_of_type(&mut a, "peers").await;
    assert_eq!(peers["peers"].as_array().unwrap().len(), 1, "连接应当仍然可用");
}

#[tokio::test]
async fn hello_is_required_as_first_message() {
    let addr = spawn_default().await;
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "list"})).await;

    let err = next_json(&mut ws).await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "hello-required");
    expect_close(&mut ws).await;
}

#[tokio::test]
async fn oversized_signal_is_rejected_and_closed() {
    let addr = spawn_default().await;
    let (mut a, _) = hello(addr, "Alice").await;

    let big = json!({"t": "signal", "to": "p2", "data": {"pad": "x".repeat(70 * 1024)}});
    send_text(&mut a, &big.to_string()).await;

    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "too-large");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn binary_frames_are_rejected_on_signaling_socket() {
    let addr = spawn_default().await;
    let (mut a, _) = hello(addr, "Alice").await;

    a.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "unexpected-binary");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn rate_limit_kicks_in_and_closes() {
    // 3 条/60 秒：hello(1) + list(2) + list(3) 通过，第 4 条被拒
    let addr = spawn(16, RateLimit::new(3, Duration::from_secs(60))).await;
    let (mut a, _) = hello(addr, "Alice").await;

    send_json(&mut a, json!({"t": "list"})).await;
    let _ = next_of_type(&mut a, "peers").await;
    send_json(&mut a, json!({"t": "list"})).await;
    let _ = next_of_type(&mut a, "peers").await;
    send_json(&mut a, json!({"t": "list"})).await;

    let err = next_of_type(&mut a, "error").await;
    assert_eq!(err["code"], "rate-limited");
    expect_close(&mut a).await;
}

#[tokio::test]
async fn server_full_is_reported() {
    let addr = spawn(1, RateLimit::default()).await;
    let (_a, _) = hello(addr, "Alice").await;

    let mut b = connect(addr).await;
    send_json(&mut b, json!({"t": "hello", "name": "Bob"})).await;
    let err = next_json(&mut b).await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "server-full");
    expect_close(&mut b).await;
}

#[tokio::test]
async fn disconnect_removes_peer_from_directory() {
    let addr = spawn_default().await;
    let (mut a, a_welcome) = hello(addr, "Alice").await;
    let a_id = a_welcome["self"]["id"].as_str().unwrap().to_string();
    let (mut b, _) = hello(addr, "Bob").await;
    let _ = next_peers_of_len(&mut a, 1).await;

    b.close(None).await.unwrap();
    drop(b);

    let peers = next_peers_of_len(&mut a, 0).await;
    assert_eq!(peers["peers"].as_array().unwrap().len(), 0, "B 断开后 A 的名单为空");

    // 新用户进来时也不应看到已离开的 B
    let (_c, c_welcome) = hello(addr, "Carol").await;
    let ids: Vec<String> = c_welcome["peers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec![a_id], "新用户应只看到 A（不含自己，也不含已离开的 B）");
}

#[tokio::test]
async fn default_name_is_generated_when_absent() {
    let addr = spawn_default().await;
    let mut ws = connect(addr).await;
    send_json(&mut ws, json!({"t": "hello"})).await;
    let welcome = next_json(&mut ws).await;
    let name = welcome["self"]["name"].as_str().unwrap();
    assert!(name.starts_with("访客-"), "缺省名应当自动生成，实际 {name}");
}
