//! WebSocket 信令的 axum 粘合层。
//!
//! 服务器在这里只做两件事：维护在线名单、把 SDP/ICE 消息透明转发给目标 peer。
//! 文件字节永远不会出现在这条链路上（需求 R4）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::AppState;
use crate::signal::{ClientMessage, Hub, MAX_SIGNAL_BYTES, ServerMessage, parse_client_message};

/// 等待客户端第一条 hello 的时间上限。
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// 帧硬上限：超过这个长度由协议层直接断开，避免内存被撑爆。
const HARD_FRAME_LIMIT: usize = MAX_SIGNAL_BYTES * 2;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let hub = state.hub.clone();
    ws.max_message_size(HARD_FRAME_LIMIT)
        .on_upgrade(move |socket| handle_socket(socket, hub))
}

pub async fn handle_socket(socket: WebSocket, hub: Arc<Hub>) {
    let (mut sender, mut receiver) = socket.split();
    let mut limiter = hub.limiter();

    // ---- 第一阶段：必须先用 hello 加入名单 ----
    let first = tokio::time::timeout(HELLO_TIMEOUT, receiver.next()).await;
    let name = match first {
        Ok(Some(Ok(Message::Text(text)))) => {
            if !limiter.check(Instant::now()) {
                fail(&mut sender, "rate-limited", "信令发送过于频繁").await;
                return;
            }
            if text.len() > MAX_SIGNAL_BYTES {
                fail(&mut sender, "too-large", "信令消息超过 64 KiB").await;
                return;
            }
            match parse_client_message(text.as_str()) {
                Ok(ClientMessage::Hello { name }) => name,
                Ok(_) => {
                    fail(&mut sender, "hello-required", "第一条消息必须是 hello").await;
                    return;
                }
                Err(err) => {
                    fail(&mut sender, "bad-request", format!("消息格式错误：{err}")).await;
                    return;
                }
            }
        }
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) => return,
        Ok(Some(Ok(_))) => {
            fail(&mut sender, "hello-required", "第一条消息必须是 hello 文本帧").await;
            return;
        }
        Ok(Some(Err(err))) => {
            debug!(%err, "握手后读取出错");
            return;
        }
        Err(_) => {
            fail(&mut sender, "hello-timeout", "等待 hello 超时").await;
            return;
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    let (me, others) = match hub.join(name.as_deref(), tx) {
        Ok(joined) => joined,
        Err(err) => {
            warn!(%err, "拒绝连接：{err}");
            fail(&mut sender, "server-full", err.to_string()).await;
            return;
        }
    };
    info!(peer = %me.id, name = %me.name, peers = hub.count(), "peer joined");

    let welcome = hub.welcome(me.clone(), others);
    if send_json(&mut sender, &welcome).await.is_err() {
        hub.leave(&me.id);
        return;
    }
    hub.broadcast_peers();

    // ---- 第二阶段：转发信令，直到断开 ----
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    None | Some(Ok(Message::Close(_))) => break,
                    Some(Err(err)) => {
                        debug!(peer = %me.id, %err, "读取出错，断开连接");
                        break;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if !limiter.check(Instant::now()) {
                            fail(&mut sender, "rate-limited", "信令发送过于频繁").await;
                            break;
                        }
                        if text.len() > MAX_SIGNAL_BYTES {
                            fail(&mut sender, "too-large", "信令消息超过 64 KiB").await;
                            break;
                        }
                        match parse_client_message(text.as_str()) {
                            Ok(ClientMessage::Signal { to, data }) => {
                                if to == me.id {
                                    let _ = send_json(&mut sender, &ServerMessage::error(
                                        "invalid-target",
                                        "不能给自己发信令",
                                    )).await;
                                } else if !hub.send_to(&to, ServerMessage::Signal { from: me.id.clone(), data }) {
                                    let _ = send_json(&mut sender, &ServerMessage::error(
                                        "unknown-peer",
                                        format!("目标 {to} 不在线"),
                                    )).await;
                                }
                            }
                            Ok(ClientMessage::List) => {
                                let _ = send_json(&mut sender, &ServerMessage::Peers { peers: hub.peers() }).await;
                            }
                            // 重复 hello 不改变身份，忽略即可
                            Ok(ClientMessage::Hello { .. }) => {}
                            Err(err) => {
                                let _ = send_json(&mut sender, &ServerMessage::error(
                                    "bad-request",
                                    format!("消息格式错误：{err}"),
                                )).await;
                            }
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        fail(&mut sender, "unexpected-binary", "信令通道不接受二进制帧").await;
                        break;
                    }
                    // ping/pong 由底层自动处理
                    Some(Ok(_)) => {}
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(message) => {
                        if send_json(&mut sender, &message).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    let remaining = hub.leave(&me.id);
    info!(peer = %me.id, peers = remaining.len(), "peer left");
    hub.broadcast_peers();
}

async fn send_json(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(message).unwrap_or_else(|_| {
        r#"{"t":"error","code":"encode-failed","message":"内部错误"}"#.to_string()
    });
    sender.send(Message::Text(text.into())).await
}

/// 发送错误后优雅关闭（客户端能收到错误码再断开）。
async fn fail(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: &'static str,
    message: impl Into<String>,
) {
    let _ = send_json(sender, &ServerMessage::error(code, message)).await;
    let _ = sender.close().await;
}
