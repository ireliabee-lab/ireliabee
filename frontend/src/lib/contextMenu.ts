/**
 * The app runs in a webview, whose own right-click menu (Back, Refresh, Save as,
 * Print, Inspect) belongs to a browser, not to iReliabee, and Refresh reloads the
 * app mid-session. Keep it only where it is useful: in text boxes and editable
 * areas (cut, copy, paste, spelling) and over selected text (copy). Development
 * builds keep it everywhere, for Inspect.
 */
export function keepNativeMenu(target: EventTarget | null, selection: string): boolean {
  if (selection.trim()) return true;
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea, [contenteditable]");
  if (!field) return false;
  if (field instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(field.type);
  }
  return !(field instanceof HTMLElement && field.getAttribute("contenteditable") === "false");
}

export function installContextMenuGuard(dev: boolean = import.meta.env.DEV) {
  if (dev) return;
  document.addEventListener("contextmenu", e => {
    if (!keepNativeMenu(e.target, window.getSelection()?.toString() ?? "")) e.preventDefault();
  });
}
