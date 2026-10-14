#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Wayland doesn't let clients keep themselves above other windows, so
    // "Pin on top" is a no-op there. XWayland honours it. Respect an explicit
    // GDK_BACKEND so users can opt back into native Wayland.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    interview_coach_lib::run();
}
