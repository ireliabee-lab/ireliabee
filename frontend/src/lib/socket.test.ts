import { describe, expect, it, vi } from "vitest";
import { SOCKET_OPEN, abandonSocket } from "./socket";

const CONNECTING = 0;

function fakeSocket(readyState: number) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => {},
  } as unknown as WebSocket;
}

describe("abandonSocket (audit 180-C4)", () => {
  it("tells the backend to stop, closes, and silences an open socket", () => {
    const ws = fakeSocket(SOCKET_OPEN);
    abandonSocket(ws);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ action: "stop" }));
    expect(ws.close).toHaveBeenCalled();
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
  });

  it("still closes a socket that is only connecting", () => {
    const ws = fakeSocket(CONNECTING);
    abandonSocket(ws);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
  });

  it("does nothing when there is no socket", () => {
    expect(() => abandonSocket(null)).not.toThrow();
  });
});
