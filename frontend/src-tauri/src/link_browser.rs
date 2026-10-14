//! The remote browser owns no app credentials and has one IPC permission.
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

pub const LABEL: &str = "link-capture";
#[derive(Default)]
pub struct CaptureState(pub Mutex<Option<(String, Instant)>>);

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified()
                || v.is_broadcast() || v.is_multicast() || a == 0 || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(v) => {
            if let Some(mapped) = v.to_ipv4_mapped() { return public_ip(IpAddr::V4(mapped)); }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast()
                || s[0] & 0xfe00 == 0xfc00 || s[0] & 0xffc0 == 0xfe80
                || (s[0] == 0x2001 && s[1] == 0x0db8))
        }
    }
}

fn public_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443)) { return false; }
    let Some(host) = url.host_str() else { return false; };
    let host = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
        || host.ends_with(".internal") { return false; }
    if let Ok(ip) = host.parse::<IpAddr>() { return public_ip(ip); }
    host.contains('.')
}

fn navigation_allowed(url: &Url) -> bool {
    if !public_url(url) { return false; }
    let Some(host) = url.host_str() else { return false; };
    let host = host.trim_matches(['[', ']']);
    let port = url.port_or_known_default().unwrap_or(443);
    match (host, port).to_socket_addrs() {
        Ok(addrs) => {
            let addrs: Vec<_> = addrs.collect();
            !addrs.is_empty() && addrs.iter().all(|a| public_ip(a.ip()))
        }
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn open_link_browser(app: tauri::AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the app can open this browser".into()); }
    let url = Url::parse(&url).map_err(|_| "Paste a public http or https link")?;
    if url.as_str().len() > 4096 || !navigation_allowed(&url) { return Err("This browser opens only public web addresses".into()); }
    if let Some(old) = app.get_webview_window(LABEL) { old.destroy().map_err(|e| e.to_string())?; }
    *app.state::<CaptureState>().0.lock().map_err(|_| "Capture state unavailable")? = None;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("link-browser");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    // Native menu: the remote page cannot hide, spoof or trigger this app action.
    let save = MenuItem::with_id(&app, "link-save", "Save to notebook", true, Some("CmdOrCtrl+Shift+S"))
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&save]).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("iReliabee — use Save to notebook above, then review in the app")
        .inner_size(1000.0, 760.0)
        .data_directory(directory)
        .menu(menu)
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_menu_event(|window, event| {
            if event.id().as_ref() != "link-save" { return; }
            let app = window.app_handle();
            let nonce = crate::new_token();
            let state = app.state::<CaptureState>();
            if let Ok(mut pending) = state.0.lock() { *pending = Some((nonce.clone(), Instant::now())); }
            if let Some(webview) = app.get_webview_window(LABEL) {
                let script = include_str!("capture-visible.js").replace("__CAPTURE_NONCE__", &serde_json::to_string(&nonce).unwrap());
                if let Err(e) = webview.eval(&script) {
                    if let Ok(mut pending) = state.0.lock() { *pending = None; }
                    let _ = app.emit_to("main", "link-capture-error", e.to_string());
                }
            }
        })
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct CapturedText { url: String, title: String, text: String, author: String, method: &'static str }

#[tauri::command]
pub fn capture_link_text(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<'_, CaptureState>, nonce: String, text: String, title: String, author: String) -> Result<(), String> {
    if window.label() != LABEL { return Err("Only the capture browser may submit text".into()); }
    let url = window.url().map_err(|e| e.to_string())?;
    if !public_url(&url) { return Err("This page cannot be captured".into()); }
    let mut pending = state.0.lock().map_err(|_| "Capture state unavailable")?;
    match pending.as_ref() {
        Some((expected, at)) if expected == &nonce && at.elapsed() < Duration::from_secs(15) => {}
        _ => return Err("Click Save to notebook in the browser menu first".into()),
    }
    *pending = None; // One use, armed only by the native menu click; never on page load.
    drop(pending);
    if text.len() > 10 * 1024 * 1024 || text.chars().count() > 5_000_000 {
        return Err("Capture a smaller passage".into());
    }
    let payload = CapturedText {
        url: url.to_string(), title: title.chars().take(200).collect(), text,
        author: author.chars().take(200).collect(), method: "browser",
    };
    app.emit_to("main", "link-captured", payload).map_err(|e| e.to_string())?;
    crate::show_main(&app);
    Ok(())
}

#[tauri::command]
pub fn close_link_browser(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the app can close this browser".into()); }
    *app.state::<CaptureState>().0.lock().map_err(|_| "Capture state unavailable")? = None;
    if let Some(browser) = app.get_webview_window(LABEL) { browser.destroy().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_private_navigation_and_app_protocols() {
        for address in ["http://127.0.0.1", "http://127.1", "http://2130706433", "http://localhost", "http://localhost.", "http://10.0.0.1", "http://172.16.0.1", "http://192.168.1.1", "http://100.64.0.1", "http://169.254.169.254", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fc00::1]", "http://[fe80::1]", "file:///tmp/file", "tauri://localhost", "https://user:pass@example.com", "http://example.com:8000"] {
            assert!(!public_url(&Url::parse(address).unwrap()), "{address}");
        }
        assert!(public_url(&Url::parse("https://www.instagram.com/p/abc").unwrap()));
        assert!(public_url(&Url::parse("https://8.8.8.8").unwrap()));
    }
}
