//! Windows 原生通知（右下角那条横幅）。
//!
//! ## 为什么不用网页的 `new Notification(...)`
//!
//! 一开始我确实只打开了 WebView2 的 `PermissionRequested`（见 `lib.rs` 的
//! `allow_notifications`），`Notification.permission` 也确实变成了 `granted`。
//! 但**实际什么都没弹**：实测在真机上是这么确认的 ——
//!
//!   * 网页里 `new Notification(...)` 之后，Windows 的通知数据库
//!     `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db-wal`
//!     **一个字节都没动**；
//!   * 同一条 Powershell 用 `ToastNotificationManager` 发的通知，那个文件的
//!     修改时间立刻就变了，`Notifications\Settings` 下还多出了对应的 AUMID 键。
//!
//! 也就是说 WebView2 这条路上，通知在 Chromium 内部就被丢掉了，**不会**到
//! Windows 通知中心，而且不报错。所以改成自己在 Rust 里发。
//!
//! ## 为什么不需要注册 AUMID / 创建快捷方式
//!
//! 常见说法是「未打包的 Win32 程序必须有带 AppUserModelID 的开始菜单快捷方式」。
//! 实测**不必**：`CreateToastNotifierWithId("BAKER.Chat")` 用任意字符串就能送去，
//! 通知平台会给它建一条设置记录。省掉了在用户开始菜单里塞快捷方式这种事
//! —— 这个客户端的卖点恰恰是「一个 exe，拷过去就能跑」。
//!
//! ## 点击
//!
//! `ToastNotification::Activated` 是应用自己在跑的时候的回调（我们的进程一直活着）。
//! 点一下就发一条 `baker://notify-click` 给前端，前端负责把窗口叫回来并跳到那条消息。

use std::cell::RefCell;

use tauri::{AppHandle, Emitter, Manager};

/// 本应用在 Windows 通知平台里的身份。改它会让用户之前设定的免打扰/横幅偏好失效。
const AUMID: &str = "BAKER.Chat";

/// 前端监听这个事件名来响应「用户点了通知」。
pub const CLICK_EVENT: &str = "baker://notify-click";

/// 最多留几条活着的通知对象。
///
/// 留它们不是为了好看：`Activated` 回调挂在 `ToastNotification` 这个 COM 对象上，
/// 对象被释放了（并且通知中心里那条也被清掉之后）回调就没了。留最近几条足够，
/// 无限留会一直涨。
const MAX_LIVE_TOASTS: usize = 16;

// 只能在本线程用：WinRT 的 COM 指针不保证可跨线程随意搬，而 `show()` 全部
// 在主线程上执行（见 `show_blocking`）。
thread_local! {
    static LIVE: RefCell<Vec<windows::UI::Notifications::ToastNotification>> = const { RefCell::new(Vec::new()) };
}


#[derive(Clone, serde::Serialize)]
pub struct Click {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

/// 把一条通知送进 Windows 通知中心。
///
/// 必须从主线程调用 —— 见 `show_blocking` 的说明。
pub fn show_blocking(app: &AppHandle, click: Click, title: &str, body: &str) -> Result<(), String> {
    use windows::core::{IInspectable, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let xml = format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(title),
        escape_xml(body),
    );

    let doc = XmlDocument::new().map_err(|e| format!("建不了通知 XML：{e}"))?;
    doc.LoadXml(&HSTRING::from(xml))
        .map_err(|e| format!("通知 XML 解析失败：{e}"))?;

    let toast = ToastNotification::CreateToastNotification(&doc)
        .map_err(|e| format!("建不了 ToastNotification：{e}"))?;

    // 点通知 → 把「跳到哪条消息」记下来，并叫窗口回来。
    // 这个回调可能在任意线程上跑，所以只做两件与 UI 无关的事：存数据、发事件。
    let app_for_click = app.clone();
    let click_for_handler = click.clone();
    let handler = TypedEventHandler::<ToastNotification, IInspectable>::new(move |_sender, _args| {

        focus_main(&app_for_click);
        let _ = app_for_click.emit(CLICK_EVENT, click_for_handler.clone());
        Ok(())
    });
    toast
        .Activated(&handler)
        .map_err(|e| format!("挂不上通知点击回调：{e}"))?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
        .map_err(|e| format!("拿不到通知通道（AUMID={AUMID}）：{e}"))?;
    notifier
        .Show(&toast)
        .map_err(|e| format!("通知没送出去：{e}"))?;

    LIVE.with(|live| {
        let mut live = live.borrow_mut();
        live.push(toast);
        if live.len() > MAX_LIVE_TOASTS {
            // 丢最老的 —— 它的回调最不可能还会被点到。
            live.remove(0);
        }
    });
    Ok(())
}


/// 把主窗口叫回前台。`show` / `unminimize` / `set_focus` 三个都要：
/// 少一个就会出现「点了通知，任务栏图标动了一下，窗口没上来」。
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // 控制字符会让 XML 直接解析失败，而通知正文来自对端，不能假设干净。
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape_xml;

    #[test]
    fn 通知正文里的xml元字符被转义() {
        // 消息是**对端**给的，`<` 原样塞进 XML 会让整条通知解析失败 ——
        // 而失败的表现是「什么都没有」，最难查。
        assert_eq!(escape_xml("a&b"), "a&amp;b");
        assert_eq!(escape_xml("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
        assert_eq!(escape_xml("\"'"), "&quot;&apos;");
    }

    #[test]
    fn 中文和换行原样保留() {
        assert_eq!(escape_xml("新消息：你好"), "新消息：你好");
        assert_eq!(escape_xml("第一行\n第二行"), "第一行\n第二行");
    }

    #[test]
    fn 控制字符被换成空格而不是让xml解析失败() {
        assert_eq!(escape_xml("a\u{7}b"), "a b");
        assert_eq!(escape_xml("a\u{0}b"), "a b");
    }
}
