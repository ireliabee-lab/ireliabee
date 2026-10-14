/** Open a web or mailto link in the user's browser or mail app (the system ones in the desktop app). */
export async function openExternal(url: string) {
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch { /* fall through to the webview */ }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
