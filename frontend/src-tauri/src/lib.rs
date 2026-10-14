mod link_browser;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Handle to the spawned backend sidecar, so we can kill it on exit.
struct BackendChild(Mutex<Option<CommandChild>>);

/// Closing the window hides it to the tray instead of quitting, so meeting
/// reminders still arrive (docs/meetings-and-reminders.md, R1). On unless the
/// user turns it off in Settings; "Quit iReliabee" in the tray always quits.
struct KeepInTray(AtomicBool);

#[tauri::command]
fn set_keep_in_tray(state: tauri::State<'_, KeepInTray>, on: bool) {
    state.0.store(on, Ordering::Relaxed);
}

/// Bring the window back from the tray.
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// The reminder window's size, in logical pixels.
const REMINDER_W: f64 = 400.0;
const REMINDER_H: f64 = 236.0;

/// A meeting reminder in its own small window: bottom-right, above everything
/// else, until the user picks Join, Set up or Later. Windows' own notifications
/// leave the screen after a few seconds, and the in-app card is only seen with
/// the app open, so a reminder sent while it sat in the tray was easy to miss.
/// `data` is the page's percent-encoded JSON of the meeting; it is handed back
/// unread with the user's choice.
#[tauri::command]
async fn show_reminder(app: tauri::AppHandle, data: String) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(old) = app.get_webview_window("reminder") {
        let _ = old.destroy();
    }
    let url = format!("index.html?reminder={data}");
    let win = WebviewWindowBuilder::new(&app, "reminder", WebviewUrl::App(url.into()))
        .title("iReliabee reminder")
        .inner_size(REMINDER_W, REMINDER_H)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Never takes the keyboard from the call the user is in.
        .focused(false)
        // Like the main window: kept out of screen shares.
        .content_protected(true)
        // The card's rounded corners show what is behind, not white.
        .transparent(true)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    place_reminder(&win, REMINDER_H);
    win.show().map_err(|e| e.to_string())
}

/// Bottom-right of the main screen, above the taskbar, `height` tall.
fn place_reminder(win: &tauri::WebviewWindow, height: f64) {
    use tauri::{LogicalSize, PhysicalPosition};
    let _ = win.set_size(LogicalSize::new(REMINDER_W, height));
    if let Ok(Some(m)) = win.primary_monitor() {
        let area = m.work_area();
        let scale = m.scale_factor();
        let (w, h, margin) = ((REMINDER_W * scale) as i32, (height * scale) as i32, (16.0 * scale) as i32);
        let x = area.position.x + area.size.width as i32 - w - margin;
        let y = area.position.y + area.size.height as i32 - h - margin;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// The reminder window, made as tall as its card once the card is drawn.
#[tauri::command]
fn fit_reminder(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("reminder") {
        place_reminder(&win, height.clamp(120.0, REMINDER_H));
    }
}

/// The reminder's buttons. Join and Set up bring the main window back and hand
/// it the choice; every choice closes the reminder.
#[tauri::command]
fn reminder_choice(app: tauri::AppHandle, choice: String, data: String) {
    if choice != "later" {
        show_main(&app);
        let _ = app.emit_to("main", "reminder-choice", (choice, data));
    }
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.destroy();
    }
}

/// The token this app and its backend share, made here, fresh every launch
/// (audit 182-H2). The backend gets it in its environment when it is started;
/// the page gets it from `local_token`. The backend never hands it out over
/// HTTP, so nothing else on the machine can learn it by asking, and the page
/// can check that whatever answers really is its backend.
struct LocalToken(String);

/// Where the backend ended up listening — or why it never got that far.
///
/// The backend takes a port from the operating system and tells us which one
/// it got, so the app no longer insists on 8000 and no longer dies when
/// something else has it. The page asks for this before its first request.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum BackendState {
    /// Still starting. The page waits; it has nowhere to send a request yet.
    Waiting,
    Ready { port: u16 },
    /// It will not be starting. Said plainly, so the page can stop waiting and
    /// show the reason rather than counting down ninety seconds to a guess.
    Failed { reason: String },
}

struct BackendPort(Mutex<BackendState>);

/// What the backend says about itself on its way up, one line at a time.
///
/// Kept apart from the reading of it so it can be tested: the sidecar's output
/// is mostly ordinary logging, and only these two lines mean anything. A line
/// that merely mentions one of them — a log message quoting an error, say —
/// must not be mistaken for the backend announcing itself.
fn parse_backend_line(line: &str) -> Option<BackendState> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("IRELIABEE_PORT ") {
        // A port of 0 means the bind never happened; anything unparseable is
        // not ours to interpret.
        return match rest.trim().parse::<u16>() {
            Ok(port) if port > 0 => Some(BackendState::Ready { port }),
            _ => None,
        };
    }
    if let Some(rest) = line.strip_prefix("IRELIABEE_BIND_FAILED ") {
        return Some(BackendState::Failed { reason: rest.trim().to_string() });
    }
    None
}

/// Where the backend is, for the page. `Waiting` until it says.
#[tauri::command]
fn backend_port(state: tauri::State<'_, BackendPort>) -> BackendState {
    state.0.lock().unwrap().clone()
}

/// Where the backend writes down what happened, so the page can point at the
/// file by name instead of guessing a path per platform.
#[tauri::command]
fn backend_log_path() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    // Joined the way this platform writes paths: a Windows path with forward
    // slashes in the middle will not open from Explorer, and this string
    // exists to be pasted somewhere.
    std::path::Path::new(&home)
        .join(".config")
        .join("ireliabee")
        .join("backend.log")
        .to_string_lossy()
        .into_owned()
}

/// Record what the backend says about itself.
///
/// The first answer usually stands: a second port line cannot move a backend
/// that is already serving. Death is the exception — the backend announces
/// its port before it finishes starting, so an import that fails afterwards
/// leaves a port recorded for a process that is gone. Without this the app sat
/// on "starting the engine" for two and a half minutes and then blamed the
/// user's antivirus, when the exit code had been known within a second.
fn settle(app: &tauri::AppHandle, next: BackendState) {
    if let Some(state) = app.try_state::<BackendPort>() {
        let mut slot = state.0.lock().unwrap();
        let fresh = matches!(*slot, BackendState::Waiting);
        let died = matches!(next, BackendState::Failed { .. });
        if fresh || died {
            *slot = next;
        }
    }
}

/// The command an assistant runs to reach the app's relay: this install's own
/// sidecar with `--relay-bridge`. Taken from where *this* executable runs, not
/// from a fixed folder, so a Store (MSIX) install and a plain .exe install each
/// get their own path. Installed users have no Python to run a script with.
fn is_windows_apps_path(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy().to_ascii_lowercase();
    s.contains(r"\windowsapps\") || s.contains("/windowsapps/")
}

/// The command an assistant runs to reach the app's relay: this install's own
/// sidecar with `--relay-bridge`. Taken from where *this* executable runs, not
/// from a fixed folder, so a Store (MSIX) install and a plain .exe install each
/// get their own path. Installed users have no Python to run a script with.
///
/// On Windows Store (MSIX) installs under `\WindowsApps\`, Windows may block
/// external processes (like Claude Code or Antigravity) from launching an exe
/// inside that directory. The Store package includes an AppExecutionAlias
/// `ireliabee-relay.exe`, so we return the alias name instead.
#[tauri::command]
fn relay_bridge_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if is_windows_apps_path(&exe) {
        return Ok("ireliabee-relay.exe".to_string());
    }
    let dir = exe.parent().ok_or_else(|| "the app has no folder".to_string())?;
    let name = if cfg!(windows) { "interview-coach-backend.exe" } else { "interview-coach-backend" };
    let sidecar = dir.join(name);
    if !sidecar.exists() {
        return Err(format!("the engine was not found at {}", sidecar.display()));
    }
    Ok(sidecar.to_string_lossy().into_owned())
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the OS random source is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The page's copy of the token. Only this app's own webview can call it.
#[tauri::command]
fn local_token(state: tauri::State<'_, LocalToken>) -> String {
    state.0.clone()
}

/// Installed from the Microsoft Store (MSIX packages live under WindowsApps).
/// The Store updates those itself, and our updater's installer can't replace them.
fn is_store_install() -> bool {
    std::env::current_exe().map(|p| is_windows_apps_path(&p)).unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // First, so a second launch hands over to the running copy before it
        // starts a backend of its own on the same port.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            } else {
                // A second launch arrived with no window to raise, so this copy
                // is on its way out. Deliberately nothing but a log line: the
                // second process has already handed over and exits whatever we
                // do here, and there is nothing safe to open — the sidecar was
                // killed on ExitRequested and setup() does not run twice, so a
                // window built here would load the page only to report that the
                // engine never started, in a process that is already exiting.
                // The click is lost; at least it stops being invisible.
                eprintln!("[app] a second launch arrived while shutting down; nothing to raise");
            }
        }))
        .manage(BackendChild(Mutex::new(None)))
        .manage(LocalToken(new_token()))
        .manage(BackendPort(Mutex::new(BackendState::Waiting)))
        .manage(KeepInTray(AtomicBool::new(true)))
        .manage(link_browser::CaptureState::default())
        .invoke_handler(tauri::generate_handler![local_token, backend_port, backend_log_path, relay_bridge_command, set_keep_in_tray, show_reminder, fit_reminder, reminder_choice, link_browser::open_link_browser, link_browser::close_link_browser, link_browser::capture_link_text])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Start at login (off until turned on in Settings), with --hidden so
        // iReliabee opens straight into the tray and only its reminders show.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .on_window_event(|window, event| {
            // Closing the window keeps iReliabee running in the tray, so the
            // meeting reminders still come; the page is told, to say so once.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let keep = window.app_handle().state::<KeepInTray>().0.load(Ordering::Relaxed);
                if keep && window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("hidden-to-tray", ());
                }
            }
        });
    // Without the plugin the app's update check fails quietly (UpdatePrompt).
    if !is_store_install() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }

            // Screen-capture protection: exclude the window from screenshots and
            // screen-share / recording software. Honoured on Windows and macOS;
            // the Wayland compositor may ignore it on Linux. Protection starts
            // ON; the titlebar toggle can turn it off at runtime.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_content_protected(true);
            }

            // Started at login: stay in the tray until the user opens the window.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            // The tray icon: open the window again, or quit for real.
            let open = MenuItem::with_id(app, "open", "Open iReliabee", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit iReliabee", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("iReliabee")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Spawn the packaged backend sidecar unless the developer opted out
            // (set INTERVIEW_COACH_SKIP_SIDECAR when running the backend from source).
            if std::env::var("INTERVIEW_COACH_SKIP_SIDECAR").is_ok() {
                // Running the backend by hand: it is on the port the developer
                // gave it, or the one `make dev-backend` uses.
                let port = std::env::var("INTERVIEW_COACH_PORT")
                    .ok()
                    .and_then(|p| p.trim().parse::<u16>().ok())
                    .unwrap_or(8000);
                settle(app.handle(), BackendState::Ready { port });
            } else {
                match app.shell().sidecar("interview-coach-backend") {
                    Ok(cmd) => {
                        // The backend exits when this process does (see main_bundled.py).
                        let parent_pid = std::process::id().to_string();
                        let version = app.package_info().version.to_string();
                        let token = app.state::<LocalToken>().0.clone();
                        match cmd
                            .args(["--parent-pid", parent_pid.as_str()])
                            .env("IRELIABEE_VERSION", version)
                            .env("IRELIABEE_LOCAL_TOKEN", token)
                            .spawn()
                        {
                            Ok((mut rx, child)) => {
                                if let Some(state) = app.try_state::<BackendChild>() {
                                    *state.0.lock().unwrap() = Some(child);
                                }
                                let handle = app.handle().clone();
                                tauri::async_runtime::spawn(async move {
                                    while let Some(event) = rx.recv().await {
                                        match event {
                                            CommandEvent::Stdout(line) => {
                                                let text = String::from_utf8_lossy(&line);
                                                eprintln!("[backend] {}", text);
                                                if let Some(next) = parse_backend_line(&text) {
                                                    settle(&handle, next);
                                                }
                                            }
                                            CommandEvent::Stderr(line) => {
                                                eprintln!("[backend!] {}", String::from_utf8_lossy(&line));
                                            }
                                            CommandEvent::Terminated(payload) => {
                                                eprintln!("[backend] terminated: {:?}", payload);
                                                // If it never said where it was
                                                // listening, it never got there.
                                                settle(&handle, BackendState::Failed {
                                                    reason: match payload.code {
                                                        Some(code) => format!("the engine stopped while starting (exit code {code})"),
                                                        None => "the engine was stopped while starting".to_string(),
                                                    },
                                                });
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("[backend] spawn failed: {e}");
                                settle(app.handle(), BackendState::Failed {
                                    reason: format!("the engine could not be started: {e}"),
                                });
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[backend] sidecar not bundled: {e}");
                        settle(app.handle(), BackendState::Failed {
                            reason: format!("the engine is missing from this install: {e}"),
                        });
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<BackendChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port_of(line: &str) -> Option<u16> {
        match parse_backend_line(line) {
            Some(BackendState::Ready { port }) => Some(port),
            _ => None,
        }
    }

    #[test]
    fn it_reads_the_port_the_backend_took() {
        assert_eq!(port_of("IRELIABEE_PORT 49812"), Some(49812));
        assert_eq!(port_of("IRELIABEE_PORT 8000\n"), Some(8000));
    }

    #[test]
    fn a_port_that_cannot_be_one_is_not_believed() {
        // 0 means the bind never happened; the rest are not ports at all.
        assert_eq!(port_of("IRELIABEE_PORT 0"), None);
        assert_eq!(port_of("IRELIABEE_PORT 99999"), None);
        assert_eq!(port_of("IRELIABEE_PORT eight"), None);
        assert_eq!(port_of("IRELIABEE_PORT"), None);
    }

    #[test]
    fn ordinary_logging_is_not_an_announcement() {
        // The backend's own log goes down this same pipe. A line that merely
        // mentions the marker must not be taken for the backend announcing
        // itself, or the app would dial a port out of an error message.
        assert!(parse_backend_line("INFO: waiting for IRELIABEE_PORT 1234").is_none());
        assert!(parse_backend_line("Started server process [396]").is_none());
        assert!(parse_backend_line("").is_none());
    }

    #[test]
    fn a_bind_failure_says_why() {
        match parse_backend_line("IRELIABEE_BIND_FAILED 10048 127.0.0.1:8000 already in use") {
            Some(BackendState::Failed { reason }) => {
                assert!(reason.contains("10048"), "{reason}");
                assert!(reason.contains("8000"), "{reason}");
            }
            other => panic!("expected a failure, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn the_first_word_only_counts_at_the_start_of_the_line() {
        assert!(parse_backend_line("x IRELIABEE_BIND_FAILED 10048 nope").is_none());
    }

    #[test]
    fn windows_apps_path_detection() {
        assert!(is_windows_apps_path(std::path::Path::new(r"C:\Program Files\WindowsApps\iReliabeeLab.iReliabee_0.4.0.0_x64__12345\interview-coach.exe")));
        assert!(is_windows_apps_path(std::path::Path::new("C:/Program Files/WindowsApps/iReliabeeLab.iReliabee/interview-coach.exe")));
        assert!(!is_windows_apps_path(std::path::Path::new(r"C:\Program Files\iReliabee\interview-coach.exe")));
        assert!(!is_windows_apps_path(std::path::Path::new(r"C:\Users\User\AppData\Local\Programs\interview-coach.exe")));
    }
}
