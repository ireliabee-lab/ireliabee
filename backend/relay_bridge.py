#!/usr/bin/env python3
"""
backend/relay_bridge.py - Restart-proof stdio bridge for iReliabee Notebook Relay.

Acts as an MCP stdio server that assistants (Claude Code, Antigravity) launch.
It dynamically reads the active backend port and pairing key from
~/.config/ireliabee/relay.json, forwarding JSON-RPC messages to the backend.

If iReliabee restarts on a new port, this bridge automatically discovers the
new port and reconnects seamlessly without requiring configuration changes.
"""
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

RELAY_CONFIG_PATH = Path.home() / ".config" / "ireliabee" / "relay.json"


def read_relay_info() -> tuple[int, str]:
    """The backend's port and pairing key: from IRB_RELAY_PORT / IRB_RELAY_KEY when the app that
    started this bridge passed them (one-click runs), else from ~/.config/ireliabee/relay.json."""
    env_port, env_key = os.environ.get("IRB_RELAY_PORT", ""), os.environ.get("IRB_RELAY_KEY", "")
    if env_port.isdigit() and env_key:
        return int(env_port), env_key
    if not RELAY_CONFIG_PATH.exists():
        return 0, ""
    try:
        data = json.loads(RELAY_CONFIG_PATH.read_text(encoding="utf-8"))
        port = int(data.get("port", 0))
        key = str(data.get("pairing_key", ""))
        return port, key
    except Exception:
        return 0, ""


def send_to_backend(payload: dict, retries: int = 4) -> dict | None:
    """Send JSON-RPC payload to iReliabee backend, retrying across restarts."""
    for attempt in range(retries):
        port, key = read_relay_info()
        if not port or not key:
            if attempt < retries - 1:
                time.sleep(0.5)
                continue
            return {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {
                    "code": -32000,
                    "message": "iReliabee desktop is not running or relay.json is missing.",
                },
            }

        url = f"http://127.0.0.1:{port}/mcp/messages?session_id=stdio&k={key}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "x-irb-relay-key": key,
                **({"x-irb-relay-client": "one-click"} if os.environ.get("IRB_RELAY_CLIENT") == "one-click" else {}),
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=65.0) as resp:
                body = resp.read().decode("utf-8")
                if not body:
                    return None
                return json.loads(body)
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8")
                return json.loads(err_body)
            except Exception:
                return {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "error": {"code": -32603, "message": f"HTTP {e.code}: {e.reason}"},
                }
        except (urllib.error.URLError, ConnectionError, OSError):
            # Port might have changed if app restarted
            if attempt < retries - 1:
                time.sleep(0.6)
                continue
            return {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {
                    "code": -32000,
                    "message": "Could not connect to iReliabee backend (is the app running?).",
                },
            }
    return None


def main() -> None:
    """Read newline-delimited JSON-RPC from stdin, forward to backend, write to stdout."""
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            sys.stdout.write(json.dumps(err) + chr(10))
            sys.stdout.flush()
            continue

        resp = send_to_backend(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + chr(10))
            sys.stdout.flush()


if __name__ == "__main__":
    main()
