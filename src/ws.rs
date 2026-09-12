//! WebSocket 转发层。
//!
//! 服务器的全部行为：
//!   * 回应 `hello` / `sessions`（拉取，不推送）
//!   * 按 `to` 定向转发文本负载
//!   * 把绑定目标之后收到的二进制帧原样转发
//!
//! 它不解析负载里的内容，不保存任何东西，也不会主动给谁发消息（不广播）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::AppState;
use crate::signal::{
    ClientMessage, MAX_BINARY_BYTES, MAX_TEXT_BYTES, OutMessage, Registry, RouteError,
    ServerMessage, parse_client_message,
};

/// 等待客户端第一条 `hello` 的时间上限。
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// 帧硬上限：超过后由协议层断开（我们的上限更高一层，用于回可读错误）。
const HARD_FRAME_LIMIT: usize = MAX_BINARY_BYTES + 4096;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let registry = state.registry.clone();
    ws.max_message_size(HARD_FRAME_LIMIT)
        .on_upgrade(move |socket| handle_socket(socket, registry))
}

pub async fn handle_socket(socket: WebSocket, registry: Arc<Registry>) {
    let (mut sender, mut receiver) = socket.split();
    let mut limiter = crate::signal::RateLimiter::new(state_rate(&registry));

    // ---- 第一阶段：hello 门禁（服务器不主动打招呼） ----
    let name = match tokio::time::timeout(HELLO_TIMEOUT, receiver.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            if !limiter.check(Instant::now()) {
                fail(&mut sender, "rate-limited", "消息过于频繁").await;
                return;
            }
            if text.len() > MAX_TEXT_BYTES {
                fail(&mut sender, "too-large", "文本消息超过上限").await;
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
            fail(
                &mut sender,
                "hello-required",
                "第一条消息必须是 hello 文本帧",
            )
            .await;
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

    let (tx, mut rx) = mpsc::unbounded_channel::<OutMessage>();
    let me = match registry.join(name.as_deref(), tx) {
        Ok(info) => info,
        Err(err) => {
            warn!(%err, "拒绝连接：{err}");
            fail(&mut sender, "server-full", err.to_string()).await;
            return;
        }
    };

    // 只回给对方自己的会话信息：不附带名单，也不通知任何人（不广播）
    if send_json(&mut sender, &ServerMessage::Welcome { me: me.clone() })
        .await
        .is_err()
    {
        registry.leave(&me.id);
        return;
    }

    // ---- 第二阶段：请求-应答 + 定向转发 ----
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    None | Some(Ok(Message::Close(_))) => break,
                    Some(Err(err)) => {
                        debug!(session = %me.id, %err, "读取出错，断开连接");
                        break;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if !limiter.check(Instant::now()) {
                            fail(&mut sender, "rate-limited", "消息过于频繁").await;
                            break;
                        }
                        if text.len() > MAX_TEXT_BYTES {
                            fail(&mut sender, "too-large", "文本消息超过上限").await;
                            break;
                        }
                        match parse_client_message(text.as_str()) {
                            Ok(ClientMessage::Hello { .. }) => {
                                let _ = send_json(&mut sender, &ServerMessage::error(
                                    "already-joined",
                                    "本连接已经建立会话",
                                )).await;
                            }
                            Ok(ClientMessage::Sessions) => {
                                let _ = send_json(&mut sender, &ServerMessage::Sessions {
                                    sessions: registry.list_except(&me.id),
                                }).await;
                            }
                            Ok(ClientMessage::Relay { to, payload }) => {
                                // 定向转发：只给目标，且不回显给发送方
                                if let Err(err) = registry.send_to(
                                    &to,
                                    ServerMessage::Relay { from: me.id.clone(), payload },
                                ) {
                                    let _ = send_json(&mut sender, &route_error(err, &to)).await;
                                }
                            }
                            Ok(ClientMessage::Bind { to }) => {
                                match registry.bind(&me.id, &to) {
                                    Ok(()) => {
                                        let _ = send_json(&mut sender, &ServerMessage::Bound { to }).await;
                                    }
                                    Err(err) => {
                                        let _ = send_json(&mut sender, &route_error(err, &to)).await;
                                    }
                                }
                            }
                            Ok(ClientMessage::Unbind) => registry.unbind(&me.id),
                            Err(err) => {
                                let _ = send_json(&mut sender, &ServerMessage::error(
                                    "bad-request",
                                    format!("消息格式错误：{err}"),
                                )).await;
                            }
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if bytes.len() > MAX_BINARY_BYTES {
                            fail(&mut sender, "too-large", "二进制帧超过上限").await;
                            break;
                        }
                        match registry.forward_binary(&me.id, bytes.to_vec()) {
                            Ok(_) => {}
                            Err(RouteError::Unbound) => {
                                let _ = send_json(&mut sender, &ServerMessage::error(
                                    "unbound",
                                    "发送二进制帧前请先 bind 目标",
                                )).await;
                            }
                            Err(err) => {
                                let _ = send_json(&mut sender, &route_error(err, "")).await;
                            }
                        }
                    }
                    // ping/pong 由底层自动处理
                    Some(Ok(_)) => {}
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(OutMessage::Json(message)) => {
                        if send_json(&mut sender, &message).await.is_err() {
                            break;
                        }
                    }
                    Some(OutMessage::Bytes(bytes)) => {
                        if sender.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // 离开时同样不广播（不通知任何人）
    registry.leave(&me.id);
}

fn state_rate(registry: &Arc<Registry>) -> crate::signal::RateLimit {
    registry.rate_limit()
}

fn route_error(err: RouteError, to: &str) -> ServerMessage {
    let code = match err {
        RouteError::UnknownSession => "unknown-session",
        RouteError::Unbound => "unbound",
        RouteError::Closed => "target-closed",
    };
    let message = if to.is_empty() {
        err.to_string()
    } else {
        format!("{to}：{err}")
    };
    ServerMessage::error(code, message)
}

async fn send_json(
    sender: &mut SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(message).unwrap_or_else(|_| {
        r#"{"t":"error","code":"encode-failed","message":"内部错误"}"#.to_string()
    });
    sender.send(Message::Text(text.into())).await
}

async fn fail(
    sender: &mut SplitSink<WebSocket, Message>,
    code: &'static str,
    message: impl Into<String>,
) {
    let _ = send_json(sender, &ServerMessage::error(code, message)).await;
    let _ = sender.close().await;
}
