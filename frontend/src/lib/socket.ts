/**
 * Close a socket the app is walking away from: tell the backend to stop, shut
 * it, and detach every handler so nothing reacts to its closing. Used when a
 * screen unmounts mid-stream, where an open socket keeps billing live time
 * with nothing on screen (audit 180-C4).
 */
/** WebSocket.OPEN, by value: the global is missing in some runtimes (older Node in CI). */
export const SOCKET_OPEN = 1;

export function abandonSocket(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  try { if (ws.readyState === SOCKET_OPEN) ws.send(JSON.stringify({ action: "stop" })); } catch { /* closing anyway */ }
  try { ws.close(); } catch { /* already closed */ }
}
