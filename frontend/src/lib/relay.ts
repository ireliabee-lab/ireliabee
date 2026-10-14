/**
 * Frontend client helpers for the Notebook MCP Relay.
 */
import { useEffect, useState } from "react";
import { fetchApi, getApiBaseUrl, isTauri } from "./api";

export interface RelayStatus {
  enabled: boolean;
  listening: boolean;
  active: boolean;
  last_poll_at: string | null;
  queued: number;
  working: string[];
  client: string | null;
  port?: number;
  pairing_key?: string;
  repo_dir?: string;
  auto?: AssistantAuto;
}

/** "Use my Claude subscription": the app starts Claude Code itself when a feature needs it. */
export interface AssistantAuto {
  enabled: boolean;
  /** Claude Code is installed where the app can find it. */
  available: boolean;
  path: string | null;
  /** A run is answering (or waiting for) requests right now. */
  running: boolean;
  started_at: number | null;
  last_error: string | null;
  last_run: { exit?: number; answered?: number; seconds?: number };
}

export async function getAssistantAuto(): Promise<AssistantAuto> {
  const r = await fetchApi("/relay/assistant");
  if (!r.ok) throw new Error(`assistant status ${r.status}`);
  return r.json();
}

/** The one click: on also turns on "Use my own AI assistant". */
export async function setAssistantAuto(enabled: boolean): Promise<AssistantAuto> {
  const r = await fetchApi("/relay/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`assistant switch ${r.status}`);
  return r.json();
}

export const CLAUDE_CODE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/**
 * Whether a request sent now will be answered: an assistant is listening, or "Use my Claude
 * subscription" is on and Claude Code is installed, so the app starts it when the request comes.
 * Not `listening` alone: in that mode nothing listens between requests, by design.
 */
export function relayReady(st: Pick<RelayStatus, "listening" | "auto">): boolean {
  return Boolean(st.listening || (st.auto?.enabled && st.auto?.available));
}

export async function getRelayStatus(): Promise<RelayStatus> {
  const r = await fetchApi("/relay/status");
  if (!r.ok) throw new Error(`relay status ${r.status}`);
  return r.json();
}

/** The relay's own failures: the user's assistant didn't take the request, or didn't answer it in time. */
export function isRelayFailure(code: string | undefined | null): boolean {
  return code === "relay_not_listening" || code === "relay_timeout";
}

/**
 * What to tell the user when their own assistant failed a request.
 *
 * With "Use my Claude subscription" on, the app starts Claude Code itself, so
 * there is nothing for the user to type anywhere: say it was Claude Code, say
 * why when the app knows (auto.last_error), and offer Try again or credits.
 * "Type start iReliabee" is only for an assistant the user started by hand.
 * And a timeout is never "isn't listening": something took it and said nothing.
 */
export function relayIssueCopy(
  code: string | undefined | null,
  auto: Pick<AssistantAuto, "enabled" | "last_error"> | null | undefined,
): { title: string; message: string } | null {
  if (!isRelayFailure(code)) return null;
  const retry = "Try again, or use credits instead.";
  if (auto?.enabled) {
    if (code === "relay_timeout") return { title: "Claude Code didn't answer in time", message: retry };
    const why = (auto.last_error ?? "").trim();
    return { title: "Claude Code couldn't answer", message: why ? `${why} ${retry}` : `It didn't start. ${retry}` };
  }
  if (code === "relay_timeout") return { title: "Your assistant didn't answer in time", message: retry };
  return { title: "Your assistant isn't listening", message: "Type “start iReliabee” in it, or use credits instead." };
}

/** The same, as one line, for the places that show a single sentence. */
export function relayIssueLine(code: string | undefined | null, auto: Pick<AssistantAuto, "enabled" | "last_error"> | null | undefined): string {
  const c = relayIssueCopy(code, auto);
  return c ? `${c.title}. ${c.message}` : "";
}

const ONCE = Symbol("once");

/**
 * Whether "Use my Claude subscription" is on, and why Claude Code last failed:
 * what relay error text depends on. Pass the error being shown: it is asked
 * each time there is one (so a new failure reads the latest last_error), and
 * not while there is none. With no argument, asked once.
 * Null until known, or when the engine can't say.
 */
export function useAssistantAuto(refresh: unknown = ONCE): AssistantAuto | null {
  const [auto, setAuto] = useState<AssistantAuto | null>(null);
  const wanted = Boolean(refresh);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    getRelayStatus().then(s => { if (alive) setAuto(s.auto ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [refresh]);
  return auto;
}

/** The cost line for work done by the user's own assistant: no iReliabee credits. */
export const OWN_ASSISTANT_COST = "Done by your own AI assistant: no credits used";

/** Whether text AI work goes to the user's own assistant (Settings switch). Off until known. */
export function useOwnAssistant(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    getRelayStatus().then(s => { if (alive) setOn(!!s.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return on;
}

export async function regenerateRelayKey(): Promise<string> {
  const r = await fetchApi("/config/relay/regenerate-key", { method: "POST" });
  if (!r.ok) throw new Error(`regenerate relay key ${r.status}`);
  const data = await r.json();
  return data.pairing_key;
}

export async function getMcpUrl(): Promise<string> {
  const st = await getRelayStatus().catch(() => null);
  const base = getApiBaseUrl();
  const key = st?.pairing_key || "";
  return key ? `${base}/mcp/sse?k=${encodeURIComponent(key)}` : `${base}/mcp/sse`;
}

/** What an assistant launches to reach the relay: a command and its arguments. */
export interface BridgeLaunch { command: string; args: string[]; dev: boolean; repo_dir?: string }

/**
 * Installed users have no Python: the bridge is the installed engine itself,
 * started with --relay-bridge, and its path is asked of the app (a Store install
 * lives in a different folder from a plain .exe install). Python is only the
 * fallback when running from source, or when the app cannot say where it is.
 */
export async function getBridgeLaunch(): Promise<BridgeLaunch> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string>("relay_bridge_command");
      const isAlias = path.toLowerCase().endsWith("ireliabee-relay.exe");
      return { command: path, args: isAlias ? [] : ["--relay-bridge"], dev: false };
    } catch {
      // fall through to the source command
    }
  }
  let repo_dir: string | undefined;
  try {
    const st = await getRelayStatus();
    repo_dir = st.repo_dir;
  } catch {
    // offline or not ready
  }
  return { command: "python", args: ["-m", "backend.relay_bridge"], dev: true, repo_dir };
}

const quoted = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/** The line to paste into a terminal for Claude Code. */
export function claudeAddCommand(b: BridgeLaunch): string {
  const parts = [quoted(b.command), ...b.args].filter(Boolean);
  // --scope user: Claude Code's default ("local") registers it for the current folder only.
  return `claude mcp add --scope user ireliabee -- ${parts.join(" ")}`;
}

/** The mcpServers block for Antigravity's mcp_config.json. */
export function antigravityConfig(b: BridgeLaunch): string {
  return JSON.stringify({ mcpServers: { ireliabee: { command: b.command, args: b.args } } }, null, 2);
}

/** The mcp_servers block for Codex's ~/.codex/config.toml. */
export function codexConfig(b: BridgeLaunch, repoDir?: string): string {
  if (b.dev) {
    const pythonPath = repoDir || b.repo_dir || ".";
    const pathStr =
      pythonPath.includes("\\") || pythonPath.includes("/")
        ? `'${pythonPath}'`
        : JSON.stringify(pythonPath);
    return [
      "[mcp_servers.ireliabee]",
      'command = "python"',
      'args = ["-m", "backend.relay_bridge"]',
      // The relay's tools only wait for and return requests: no approval prompt for each one.
      'default_tools_approval_mode = "auto"',
      "",
      "[mcp_servers.ireliabee.env]",
      `PYTHONPATH = ${pathStr}`,
    ].join("\n");
  }

  const cmdStr =
    b.command.includes("\\") || b.command.includes("/")
      ? `'${b.command}'`
      : JSON.stringify(b.command);
  const argsStr = JSON.stringify(b.args).replace(/,/g, ", ");
  return [
    "[mcp_servers.ireliabee]",
    `command = ${cmdStr}`,
    `args = ${argsStr}`,
    'default_tools_approval_mode = "auto"',
  ].join("\n");
}
