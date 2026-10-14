import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpUrl, getBridgeLaunch, claudeAddCommand, antigravityConfig, codexConfig, relayReady, relayIssueCopy } from "./relay";
import * as api from "./api";

describe("relay client helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getMcpUrl formats SSE URL with pairing key", async () => {
    vi.spyOn(api, "fetchApi").mockResolvedValueOnce(
      new Response(JSON.stringify({ pairing_key: "pair-12345" }), { status: 200 })
    );
    vi.spyOn(api, "getApiBaseUrl").mockReturnValueOnce("http://127.0.0.1:8000");

    const url = await getMcpUrl();
    expect(url).toBe("http://127.0.0.1:8000/mcp/sse?k=pair-12345");
  });

  it("outside the desktop app the bridge is the python dev fallback", async () => {
    vi.spyOn(api, "isTauri").mockReturnValue(false);
    vi.spyOn(api, "fetchApi").mockResolvedValueOnce(
      new Response(JSON.stringify({ repo_dir: "C:\\Users\\User\\myenvironment\\ireliabee-relay" }), { status: 200 })
    );
    const b = await getBridgeLaunch();
    expect(b).toEqual({
      command: "python",
      args: ["-m", "backend.relay_bridge"],
      dev: true,
      repo_dir: "C:\\Users\\User\\myenvironment\\ireliabee-relay",
    });
  });

  it("claude and antigravity commands use the installed sidecar path, quoted when it has spaces", () => {
    const b = { command: "C:\\Program Files\\iReliabee\\interview-coach-backend.exe", args: ["--relay-bridge"], dev: false };
    expect(claudeAddCommand(b)).toBe('claude mcp add --scope user ireliabee -- "C:\\Program Files\\iReliabee\\interview-coach-backend.exe" --relay-bridge');
    expect(JSON.parse(antigravityConfig(b)).mcpServers.ireliabee).toEqual({ command: b.command, args: ["--relay-bridge"] });
    expect(claudeAddCommand({ command: "/opt/ib/engine", args: ["--relay-bridge"], dev: false })).toBe("claude mcp add --scope user ireliabee -- /opt/ib/engine --relay-bridge");
  });

  it("when using the app execution alias, args are empty and commands format cleanly", () => {
    const b = { command: "ireliabee-relay.exe", args: [], dev: false };
    expect(claudeAddCommand(b)).toBe("claude mcp add --scope user ireliabee -- ireliabee-relay.exe");
    expect(JSON.parse(antigravityConfig(b)).mcpServers.ireliabee).toEqual({ command: "ireliabee-relay.exe", args: [] });
  });

  it("codexConfig formats TOML block with single-quoted Windows paths, Store alias, and dev env table", () => {
    // 1. Installed sidecar path with spaces and Windows backslashes
    const bSidecar = {
      command: "C:\\Program Files\\iReliabee\\interview-coach-backend.exe",
      args: ["--relay-bridge"],
      dev: false,
    };
    expect(codexConfig(bSidecar)).toBe(
      "[mcp_servers.ireliabee]\n" +
      "command = 'C:\\Program Files\\iReliabee\\interview-coach-backend.exe'\n" +
      'args = ["--relay-bridge"]\n' +
      'default_tools_approval_mode = "auto"'
    );

    // 2. Store app execution alias
    const bAlias = { command: "ireliabee-relay.exe", args: [], dev: false };
    expect(codexConfig(bAlias)).toBe(
      "[mcp_servers.ireliabee]\n" +
      'command = "ireliabee-relay.exe"\n' +
      "args = []\n" +
      'default_tools_approval_mode = "auto"'
    );

    // 3. Dev mode fallback with repo's absolute path from backend
    const bDev = {
      command: "python",
      args: ["-m", "backend.relay_bridge"],
      dev: true,
      repo_dir: "C:\\Users\\User\\myenvironment\\ireliabee-relay",
    };
    expect(codexConfig(bDev)).toBe(
      "[mcp_servers.ireliabee]\n" +
      'command = "python"\n' +
      'args = ["-m", "backend.relay_bridge"]\n' +
      'default_tools_approval_mode = "auto"\n\n' +
      "[mcp_servers.ireliabee.env]\n" +
      "PYTHONPATH = 'C:\\Users\\User\\myenvironment\\ireliabee-relay'"
    );

    // 3b. Dev mode fallback with repoDir argument override
    expect(codexConfig({ command: "python", args: ["-m", "backend.relay_bridge"], dev: true }, "/home/user/dev/ireliabee-relay")).toBe(
      "[mcp_servers.ireliabee]\n" +
      'command = "python"\n' +
      'args = ["-m", "backend.relay_bridge"]\n' +
      'default_tools_approval_mode = "auto"\n\n' +
      "[mcp_servers.ireliabee.env]\n" +
      "PYTHONPATH = '/home/user/dev/ireliabee-relay'"
    );

    // 4. POSIX path sidecar
    const bPosix = { command: "/opt/ib/interview-coach-backend", args: ["--relay-bridge"], dev: false };
    expect(codexConfig(bPosix)).toBe(
      "[mcp_servers.ireliabee]\n" +
      "command = '/opt/ib/interview-coach-backend'\n" +
      'args = ["--relay-bridge"]\n' +
      'default_tools_approval_mode = "auto"'
    );
  });

  it("notifyError with credits_fallback and onRetryCredits calls toast.custom", async () => {
    const toastMod = await import("react-hot-toast");
    const { notifyError, AppError } = await import("./errors");
    const spy = vi.spyOn(toastMod.default, "custom");
    const onRetry = vi.fn();

    notifyError(
      new AppError({
        code: "relay_not_listening",
        title: "Your assistant isn't listening",
        message: "Say start iReliabee in your assistant, or use credits instead.",
        action: "credits_fallback",
      }),
      onRetry
    );

    expect(spy).toHaveBeenCalled();
  });
});

describe("relayReady: whether a request sent now will be answered", () => {
  const auto = (enabled: boolean, available: boolean) =>
    ({ enabled, available, path: null, running: false, started_at: null, last_error: null, last_run: {} });
  it("an assistant listening is ready", () => {
    expect(relayReady({ listening: true })).toBe(true);
  });
  it("one-click Claude Code on and installed is ready though nothing listens between requests", () => {
    expect(relayReady({ listening: false, auto: auto(true, true) })).toBe(true);
  });
  it("one-click on but Claude Code not installed is not ready", () => {
    expect(relayReady({ listening: false, auto: auto(true, false) })).toBe(false);
  });
  it("nothing listening and one-click off is not ready", () => {
    expect(relayReady({ listening: false, auto: auto(false, true) })).toBe(false);
    expect(relayReady({ listening: false })).toBe(false);
  });
});

describe("what a relay failure says (relayIssueCopy)", () => {
  const auto = (enabled: boolean, last_error: string | null = null) => ({ enabled, last_error });

  it("is nothing for an error that is not the relay's", () => {
    expect(relayIssueCopy("out_of_credits", auto(true))).toBeNull();
    expect(relayIssueCopy(undefined, null)).toBeNull();
  });

  it("with one-click on, says Claude Code didn't answer and never asks the user to type anything", () => {
    const timeout = relayIssueCopy("relay_timeout", auto(true))!;
    expect(`${timeout.title}. ${timeout.message}`).toMatch(/Claude Code didn.t answer in time/);
    expect(timeout.message).toMatch(/Try again, or use credits/);
    const notListening = relayIssueCopy("relay_not_listening", auto(true, "Claude Code isn't installed on this computer."))!;
    expect(notListening.title).toMatch(/Claude Code/);
    expect(notListening.message).toMatch(/isn't installed/);
    for (const c of [timeout, notListening]) expect(`${c.title} ${c.message}`).not.toMatch(/start iReliabee|isn.t listening/i);
  });

  it("a timeout is never called 'isn't listening'", () => {
    const c = relayIssueCopy("relay_timeout", auto(false))!;
    expect(`${c.title} ${c.message}`).not.toMatch(/isn.t listening|start iReliabee/i);
    expect(c.title).toMatch(/didn.t answer in time/);
  });

  it("started by hand, not listening still says how to start it", () => {
    const c = relayIssueCopy("relay_not_listening", auto(false))!;
    expect(`${c.title} ${c.message}`).toMatch(/start iReliabee/);
    expect(relayIssueCopy("relay_not_listening", null)!.message).toMatch(/start iReliabee/);
  });
});
