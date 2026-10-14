"""
backend/routers/mcp.py - MCP Server (SSE & JSON-RPC) and Relay Status endpoints.

Allows external AI assistants (Claude Code, Antigravity, Claude Desktop) to connect
over the Model Context Protocol (MCP) using Server-Sent Events (SSE). Exposes the
relay tools: next_request, submit_answer, and relay_status.

Protected by local_guard.py (loopback host, x-irb-token header or ?t= query parameter).
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Any, Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from .. import relay

logger = logging.getLogger(__name__)

router = APIRouter()

# Active SSE sessions: session_id -> asyncio.Queue[str]
_sse_sessions: dict[str, asyncio.Queue[str]] = {}

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {
    "name": "ireliabee-relay",
    "version": "0.1.0",
}
SERVER_INSTRUCTIONS = (
    "iReliabee Notebook AI Relay.\n"
    "When the user says 'start iReliabee' or similar (or picks the ireliabee-listen prompt):\n"
    "1. Call next_request() in a loop to wait for incoming notebook requests.\n"
    "2. On each request, follow the request's instructions and source context exactly, "
    "grounded strictly in the provided text.\n"
    "3. Reply with submit_answer(id=..., answer=...). If next_request() returns {\"kind\": \"none\"} "
    "(timeout), immediately call next_request() again without messaging the user.\n"
    "4. Keep looping until the user says stop."
)

PROMPTS = [
    {
        "name": "ireliabee-listen",
        "description": "Start listening for iReliabee notebook requests and answering them in a loop until told to stop.",
        "arguments": [],
    }
]

PROMPT_LISTEN_TEXT = (
    "Start listening for iReliabee requests: call next_request() in a loop, "
    "follow each request's instructions exactly, reply with submit_answer, "
    "and keep looping until I say stop."
)

TOOLS = [
    {
        "name": "next_request",
        "description": (
            "Wait for the next request from iReliabee's notebook (e.g. Explain words or a passage). "
            "Returns {id, kind, instructions, context} or {'kind': 'none'} on timeout: then call it again. "
            "This is how notebook requests reach you."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "wait_s": {
                    "type": "number",
                    "description": "Seconds to wait (default 50). Keep the default.",
                    "default": 50,
                },
            },
        },
    },
    {
        "name": "submit_answer",
        "description": (
            "Submit your answer to a request received from next_request. "
            "id: the request id from next_request. "
            "answer: the JSON answer object {meaning, example, from, pages, unsure} matching the instructions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "The request id from next_request",
                },
                "answer": {
                    "description": "The JSON object or JSON string containing meaning, example, from, pages, unsure",
                },
                "markdown": {
                    "type": "string",
                    "description": "Optional markdown string answer",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "answer",
        "description": "Show your answer for a notebook request. Alias for submit_answer.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "The request id from next_request",
                },
                "markdown": {
                    "type": "string",
                    "description": "The markdown or JSON answer",
                },
                "answer": {
                    "description": "The answer object",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "relay_status",
        "description": "Report the status of the iReliabee notebook relay.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
]


@router.get("/relay/status")
def relay_status(request: Request):
    """Status endpoint for the desktop app to inspect whether an assistant is listening."""
    if request.url.port:
        relay.record_port(request.url.port)
    from ..core import local_guard
    token_given = (
        request.headers.get("x-irb-token") or
        request.query_params.get("t")
    )
    include_key = local_guard._token_ok(token_given)
    return relay.status(include_key=include_key)


@router.get("/relay/assistant")
def relay_assistant_status():
    """Whether the app starts the user's Claude Code by itself, and how that's going."""
    from .. import assistant_runner
    return assistant_runner.status()


@router.post("/relay/assistant")
async def relay_assistant_set(request: Request):
    """The one click: {"enabled": true} turns on the relay and lets the app start Claude Code
    when a feature needs it; {"enabled": false} turns that off and stops a run in progress."""
    from .. import assistant_runner
    try:
        body = await request.json()
    except Exception:
        body = {}
    assistant_runner.set_enabled(bool(body.get("enabled")))
    return assistant_runner.status()


@router.get("/mcp/sse")
async def mcp_sse(request: Request):
    """
    MCP Server-Sent Events endpoint.
    The assistant connects here. The server responds with the endpoint event
    giving the URI for POST requests, then pushes JSON-RPC messages down the stream.
    """
    if request.url.port:
        relay.record_port(request.url.port)
    session_id = secrets.token_hex(16)
    queue: asyncio.Queue[str] = asyncio.Queue()
    _sse_sessions[session_id] = queue

    key = (
        request.query_params.get("k") or
        request.query_params.get("key") or
        request.query_params.get("pairing_key") or
        request.query_params.get("t") or
        request.headers.get("x-irb-relay-key") or
        request.headers.get("x-irb-token") or
        ""
    )
    key_param = f"&k={key}" if key else ""
    endpoint_uri = f"/mcp/messages?session_id={session_id}{key_param}"

    async def event_generator():
        # First event: tell client where to post messages
        yield f"event: endpoint\ndata: {endpoint_uri}\n\n"

        try:
            while True:
                # Wait for messages to send or send keepalive every 15s
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: message\ndata: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                if await request.is_disconnected():
                    break
        except asyncio.CancelledError:
            pass
        finally:
            _sse_sessions.pop(session_id, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/mcp/messages")
async def mcp_messages(request: Request):
    """
    MCP message receiver: receives JSON-RPC 2.0 requests from the client.
    Sends responses back through the client's SSE session, or directly in HTTP response.
    """
    session_id = request.query_params.get("session_id")

    try:
        payload = await request.json()
    except Exception as e:
        err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {e}"}}
        return JSONResponse(err, status_code=400)

    # Handle batch or single message
    messages = payload if isinstance(payload, list) else [payload]
    responses = []

    for msg in messages:
        resp = await _handle_jsonrpc(msg, one_click=request.headers.get("x-irb-relay-client") == "one-click")
        if resp is not None:
            responses.append(resp)

    if not responses:
        return Response(status_code=202)

    # If connected to an active SSE session, send responses over SSE stream
    sse_queue = _sse_sessions.get(session_id) if session_id else None
    if sse_queue:
        for resp in responses:
            await sse_queue.put(json.dumps(resp))
        return Response(status_code=202)

    # Otherwise return response directly in HTTP response
    out = responses if isinstance(payload, list) else responses[0]
    return JSONResponse(out)


async def _handle_jsonrpc(msg: dict[str, Any], one_click: bool = False) -> Optional[dict[str, Any]]:
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}

    req_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    # Notifications have no id and expect no response
    is_notification = (req_id is None)

    if method == "initialize":
        client_info = params.get("clientInfo") or {}
        client_name = client_info.get("name")
        relay.set_client(client_name)
        result = {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {
                "tools": {"listChanged": False},
                "prompts": {"listChanged": False},
            },
            "serverInfo": SERVER_INFO,
            "instructions": SERVER_INSTRUCTIONS,
        }
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    elif method == "notifications/initialized":
        return None

    elif method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}

        if tool_name == "next_request":
            wait_s = float(arguments.get("wait_s", relay.DEFAULT_WAIT_S))
            req = await relay.next_request(wait_s=wait_s)
            if req.get("kind") == "none":
                # An app-started run ends here (the app starts another when work arrives);
                # a hand-started assistant keeps listening until the user says stop.
                text = (
                    f'{json.dumps({"kind": "none"})}\n'
                    + ("No more requests. End your turn now." if one_click
                       else "Nothing yet. Call next_request() again now, without a word to the user.")
                )
            else:
                text = (
                    f"{json.dumps(req, indent=2)}\n\n"
                    f"Follow the instructions and source context above. Then call submit_answer(id=\"{req['id']}\", answer=...). "
                    "Then call next_request() again."
                )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": text}],
                },
            }

        elif tool_name in ("submit_answer", "answer"):
            req_id_arg = arguments.get("id")
            answer_val = arguments.get("answer") if "answer" in arguments else arguments.get("markdown")
            if not req_id_arg:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": "Missing 'id' parameter"}],
                        "isError": True,
                    },
                }
            ok = relay.submit_answer(str(req_id_arg), answer_val)
            if ok:
                msg_text = f"Answer accepted for request {req_id_arg}. Now call next_request() again."
            else:
                msg_text = f"Request {req_id_arg} was not found, was already answered, or timed out. Call next_request() now."
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": msg_text}],
                },
            }

        elif tool_name == "relay_status":
            st = relay.status(include_key=False)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(st, indent=2)}],
                },
            }

        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
                    "isError": True,
                },
            }

    elif method == "prompts/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": PROMPTS}}

    elif method == "prompts/get":
        prompt_name = params.get("name")
        if prompt_name == "ireliabee-listen":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "description": "Start listening for iReliabee notebook requests and answering them in a loop.",
                    "messages": [
                        {
                            "role": "user",
                            "content": {
                                "type": "text",
                                "text": PROMPT_LISTEN_TEXT,
                            },
                        }
                    ],
                },
            }
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32602, "message": f"Prompt not found: {prompt_name}"},
        }

    elif method == "resources/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": []}}

    else:
        if is_notification:
            return None
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method {method} not found"},
        }
