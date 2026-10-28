//! BAKER 桌面端外壳。
//!
//! 这个文件很薄，但它是**整个局域网传输层对前端唯二的接口**：
//! 一组 `net_*` 命令（问状态、要名单、发东西）和一条 `baker://net` 事件流。
//! 除此之外前端拿不到 Rust 里的任何东西 —— 聊天协议的编解码全在 TS 侧，
//! Rust 只做浏览器做不到的那两件事：UDP 组播发现、监听 TCP 端口。

mod net;
mod notify;

use net::node::{Node, NodeConfig, NodeEvent, PeerInfo};
use std::net::SocketAddr;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 前端监听这个事件名取回所有传输层事件。
const EVENT: &str = "baker://net";

struct State {
    node: Mutex<Option<Node>>,
}

impl State {
    fn new() -> Self {
        Self {
            node: Mutex::new(None),
        }
    }
}

/// 起节点。
///
/// 重复调用是**幂等**的：已经起着就直接返回当前端口，不重建。
/// 前端热重载/切面板时很容易多叫一次，重建会把已建立的连接全掐掉。
#[tauri::command]
fn net_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    self_id: String,
    info: serde_json::Value,
    tcp_port: Option<u16>,
    udp_port: Option<u16>,
) -> Result<u16, String> {
    let mut slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    if let Some(n) = slot.as_ref() {
        return Ok(n.tcp_port());
    }

    let sink = {
        let app = app.clone();
        std::sync::Arc::new(move |ev: NodeEvent| {
            // 发不出去（窗口已关）不算错误：这是一个只往前的广播，
            // 没有任何人在等它，失败就失败。
            let _ = app.emit(EVENT, &ev);
        })
    };

    let node = Node::start(
        NodeConfig {
            self_id,
            info,
            tcp_port: tcp_port.unwrap_or(net::DEFAULT_TCP_PORT),
            udp_port: udp_port.unwrap_or(net::DEFAULT_UDP_PORT),
        },
        sink,
    )
    .map_err(|e| e.to_string())?;

    let port = node.tcp_port();
    *slot = Some(node);
    Ok(port)
}

#[tauri::command]
fn net_stop(state: tauri::State<'_, State>) -> Result<(), String> {
    let mut slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    if let Some(n) = slot.take() {
        n.stop();
    }
    Ok(())
}

/// 现在有没有在跑，跑在哪个端口。
#[tauri::command]
fn net_status(state: tauri::State<'_, State>) -> Result<Option<serde_json::Value>, String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    Ok(slot.as_ref().map(|n| {
        serde_json::json!({
            "tcpPort": n.tcp_port(),
            "connected": n.connected(),
        })
    }))
}

#[tauri::command]
fn net_peers(state: tauri::State<'_, State>) -> Result<Vec<PeerInfo>, String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    Ok(slot.as_ref().map(|n| n.peers()).unwrap_or_default())
}

#[tauri::command]
fn net_connected(state: tauri::State<'_, State>) -> Result<Vec<String>, String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    Ok(slot.as_ref().map(|n| n.connected()).unwrap_or_default())
}

/// 发给某一个人。
///
/// 失败（对方不在线）会带着中文原因返回给前端，**由前端决定怎么告诉用户** ——
/// 是显示「待送达」还是弹错误条，取决于这条消息是什么类型。Rust 不做这个判断。
#[tauri::command]
fn net_send(state: tauri::State<'_, State>, peer_id: String, payload: Vec<u8>) -> Result<(), String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    let n = slot.as_ref().ok_or("节点还没起来")?;
    n.send(&peer_id, &payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn net_broadcast(state: tauri::State<'_, State>, payload: Vec<u8>) -> Result<usize, String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    let n = slot.as_ref().ok_or("节点还没起来")?;
    Ok(n.broadcast(&payload))
}

/// 改自我介绍（名字/头像）。下一次信标就会用新的。
#[tauri::command]
fn net_set_info(state: tauri::State<'_, State>, info: serde_json::Value) -> Result<(), String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    if let Some(n) = slot.as_ref() {
        n.set_info(info);
    }
    Ok(())
}

/// 马上再播一轮信标，不等下一个 3 秒周期。用户点了「刷新」时用。
#[tauri::command]
fn net_announce(state: tauri::State<'_, State>) -> Result<(), String> {
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    if let Some(n) = slot.as_ref() {
        n.announce_now();
    }
    Ok(())
}

/// 手填地址直连。用于「组播被网络挡住了，但我知道对面 IP」的情况。
#[tauri::command]
fn net_connect(state: tauri::State<'_, State>, addr: String) -> Result<(), String> {
    let parsed: SocketAddr = addr
        .parse()
        .map_err(|_| format!("「{addr}」不是 ip:端口 的形式"))?;
    let slot = state.node.lock().map_err(|_| "状态锁坏了".to_string())?;
    let n = slot.as_ref().ok_or("节点还没起来")?;
    n.connect_to(parsed).map_err(|e| e.to_string())
}

/// 事件日志的落盘位置：应用数据目录下的 `events.log`。
///
/// 为什么不放前端侧：整个事件日志是**唯一**一份需要跨重启活下来的数据
/// （会话、消息、好友、公告全在它里面，状态是每次折出来的）。放
/// `localStorage` 会在几万条时撞上 5～10MB 的配额，而配额满了的报错是
/// 静默丢数据。放文件没有这个上限，而且追加是 O(1)。
///
/// `BAKER_DATA_DIR` 环境变量可以覆盖这个位置。存在的理由是两件具体的事：
///
/// - **同一台机器上开两个实例**：Windows 上 `app_data_dir()` 走的是
///   `SHGetKnownFolderPath`，**不看 `APPDATA` 环境变量**。于是双开时两个进程
///   读同一份 `events.log`，第二个实例启动就「已经拥有」第一个的全部事件，
///   同步逻辑等于没被测到。这是实测踩出来的，不是猜的。
/// - **装 U 盘里带走**：绿色包希望所有状态跟着 exe 走，而不是留在 `%APPDATA%`。
///
/// 不设这个变量时行为完全不变。
fn log_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = match std::env::var_os("BAKER_DATA_DIR") {
        Some(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("拿不到应用数据目录：{e}"))?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了目录：{e}"))?;
    Ok(dir.join("events.log"))
}

/// 读全量事件日志。文件不存在返回空 —— 第一次启动就是这样，不是错误。
#[tauri::command]
fn log_read(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = log_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text.lines().map(str::to_string).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 追加若干行。**批量**而不是一行一次：每行一次 IPC 在同步几千条事件时
/// 会把开销全花在往返上，而不是写盘上。
#[tauri::command]
fn log_append(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    if lines.is_empty() {
        return Ok(());
    }
    let path = log_file(&app)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打不开事件日志：{e}"))?;
    let mut buf = String::new();
    for line in &lines {
        // 一行一条事件（JSON，内部换行已被转义）。裸换行会把这行劈成两条
        // 谁也读不懂的记录，所以宁可把它压成空格 —— 丢一个字符比丢整条好。
        buf.push_str(&line.replace(['\n', '\r'], " "));
        buf.push('\n');
    }
    file.write_all(buf.as_bytes()).map_err(|e| e.to_string())
}

/// 整份重写。只在压缩（`EventLog.compact()`）时用 —— 那是罕见的操作，
/// 「写临时文件再改名」的原子性不值得为它加一次依赖。
#[tauri::command]
fn log_rewrite(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    let path = log_file(&app)?;
    let mut buf = String::new();
    for line in &lines {
        buf.push_str(&line.replace(['\n', '\r'], " "));
        buf.push('\n');
    }
    std::fs::write(&path, buf).map_err(|e| e.to_string())
}

/// 让 WebView2 放行「网页通知」。
///
/// 为什么需要这一步：前端的 `useNotifications` 用的是标准 `new Notification(...)`，
/// 而 WebView2 默认对 `Notification.requestPermission()` 回 **denied** ——
/// 宿主（也就是我们）不处理 `PermissionRequested` 事件，Chromium 就按拒绝处理。
/// 实测在 `tauri.localhost` 里 `Notification.permission` 一开始是 `default`，
/// 请求一次之后变成 `denied`，于是右下角什么都不弹，而且不报错。
///
/// 这里挂一个 `PermissionRequested` 处理器，只对 `NOTIFICATIONS` 回 Allow，
/// 别的权限（摄像头、剪贴板、地理位置……）一概不动 —— 这个产品不需要它们，
/// 顺手全放行等于给一个纯局域网聊天软件开了它根本用不到的权限面。
///
/// 放行之后 `new Notification(...)` 出来的就是 Windows 自己的通知横幅，
/// 归到本应用名下，点一下能把主窗口叫回来（点击处理在前端）。
#[cfg(windows)]
fn allow_notifications(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    // SAFETY: 全在这一个函数里，且只在 WebView2 已经建好之后调用
    // （setup 阶段窗口已创建）。`controller()` 是 Tauri 给的、指向当前 webview
    // 的 COM 指针，生命周期由窗口持有，这里只借用、不释放。
    unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                log::warn!("[notify] 拿不到 CoreWebView2，系统通知会退化成没反应：{e}");
                return;
            }
        };

        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));

        // token 不需要保留：这个处理器活到进程结束，从来不摘。
        let mut token = 0i64;
        match core.add_PermissionRequested(&handler, &mut token) {
            Ok(()) => log::info!("[notify] 已放行 WebView2 通知权限（token={token}）"),
            Err(e) => log::warn!("[notify] 挂 PermissionRequested 失败，系统通知不会有：{e}"),
        }
    }
}

/// 弹一条 Windows 通知（右下角那条横幅）。
///
/// 前端在收到新消息、且窗口不在前台时调它。文案由前端拼好（它知道是谁发的、
/// 是不是贴纸/图片），Rust 只负责把它变成系统通知 —— 和 `net_*` 的分工一致。
#[tauri::command]
fn notify_toast(
    app: tauri::AppHandle,
    session_id: String,
    message_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    let click = notify::Click {
        session_id,
        message_id,
    };
    // WinRT 的对象要在主线程上建（`show_blocking` 里把它放在 `LIVE` 里存活，
    // 而那个 thread_local 是主线程的）。命令本身跑在 worker 线程上，
    // 所以这里排一次主线程任务，并用 channel 把结果等回来。
    let (tx, rx) = std::sync::mpsc::channel();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(notify::show_blocking(&app_for_main, click, &title, &body));
    })
    .map_err(|e| format!("排不进主线程：{e}"))?;
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(result) => result,
        Err(_) => Err("主线程 3 秒没回应，通知没发出去".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(State::new())
        .invoke_handler(tauri::generate_handler![
            net_start,
            net_stop,
            net_status,
            net_peers,
            net_connected,
            net_send,
            net_broadcast,
            net_set_info,
            net_announce,
            net_connect,
            log_read,
            log_append,
            log_rewrite,
            notify_toast,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 窗口关掉时把节点停掉，否则组播还在往外发，同一个网络里
            // 别人会隔一会儿又看到这个已经关了的程序。
            let handle = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                // 通知权限只能挂在已经建好的 webview 上，所以放在 setup 里。
                // 失败不影响主流程 —— 大不了退回「只有任务栏闪烁」。
                #[cfg(windows)]
                {
                    if let Err(e) = win.with_webview(allow_notifications) {
                        log::warn!("[notify] with_webview 失败：{e}");
                    }
                }

                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        if let Some(state) = handle.try_state::<State>() {
                            if let Ok(mut slot) = state.node.lock() {
                                if let Some(n) = slot.take() {
                                    n.stop();
                                }
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
