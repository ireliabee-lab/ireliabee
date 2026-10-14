fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["local_token", "backend_port", "backend_log_path", "relay_bridge_command", "set_keep_in_tray", "show_reminder", "fit_reminder", "reminder_choice", "open_link_browser", "close_link_browser", "capture_link_text"]),
        ),
    ).expect("failed to build app permissions");
}
