# Experimental MCP hub

MUST means a requirement. SHOULD means the default unless a concrete reason justifies an exception. MAY means an option.

## Purpose

The hub lets every control source reach the user's downstream MCP servers through ARC.
A control source connects only ARC; ARC holds one set of downstream sessions for all of them.
Agents configure the hub through catalog ops; the desktop workspace observes it and offers only enable, disable, reconnect and remove.

## Ownership

The experiment is disabled by default through the `mcp-services` device preference.
Settings → About → Experimental owns only its enable switch.
Enabling it exposes the hub workspace in the shared navigation capsule and the hub ops in guide.
Disabled hub ops are absent from guide and the tool catalog and return `OP_UNAVAILABLE`.

`mcp_hub` owns the device store `mcp-hub.json` in the ARC state directory.
Each server has a unique name, a transport, connection fields, an enabled flag, a revision and `addedBy` attribution.
Configuration stays outside the repository.
The first read migrates the per-Agent store `mcp-services.json` once, drops its Agent assignments and deletes the old file.

The context provider, `agents/mcp.json` ACP servers, native Agent profiles and Codex's native `mcp` op keep their existing owners.
The hub does not mount servers into dispatched Agent sessions.

## Catalog ops

`query mcp_tools` lists servers with state and compact tool descriptions.
`server` returns that server's full tool definitions, including `inputSchema`.
`server` with `tool` returns one definition.
Listing connects enabled servers that have no tool list yet; `refresh:true` re-lists the selected servers.

`act mcp_call` sends one `tools/call`.
The result keeps downstream `content`, `structuredContent`, `_meta` and `isError`.
`isError:true` is a downstream tool failure and not an ARC failure.
An unknown tool triggers one re-list before `MCP_TOOL_UNKNOWN`.
A timeout sends `notifications/cancelled` and returns `MCP_TIMEOUT`; ARC never replays a call.

`act mcp_configure` takes `add`, `update`, `remove`, `enable`, `disable` and `import`.
`add` and `update` save first, then connect and list tools; a connection failure keeps the configuration and returns the failure in `next.hint`.
`update` replaces only supplied fields, and a transport change clears the previous connection fields.
`expectedRevision` is optional optimistic concurrency.
`import` copies servers from the Codex, Claude, Cursor or Gemini user profile and never replaces an existing hub name.
Codex `bearer_token_env_var` and `env_http_headers` resolve from ARC's environment at import time; missing variables skip that server with a reason.
Legacy SSE entries are skipped.

Readback reports env and header names, never their values.
Failures use `{state:"failed",error:{code,message},next}` with a schema-valid read `next`.
Hub ops use read-back retry semantics; the outer act `requestId` adds no replay protection.

## Sessions

Sessions start lazily and stay warm for ten minutes after their last use.
The cached tool list survives idle shutdown, so listing does not restart idle servers.
A revision change closes the old session before the next use.
stdio servers resolve bare commands through ARC's Agent search path and receive that path as `PATH`.
Server requests receive `ping` replies or method-not-found; `notifications/tools/list_changed` marks the cached list stale.
A closed stdio process, lost HTTP stream or HTTP 404 drops the session; the next request reconnects.
Startup failures include up to 800 characters of server stderr.

HTTP uses Streamable HTTP with JSON and SSE POST responses, `Mcp-Session-Id` and `MCP-Protocol-Version` headers, ARC proxy settings and no redirects.
Supported protocol versions are `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`.

## Limits

There is no standalone GET event stream, resource or prompt forwarding, sampling, elicitation or roots support.
OAuth-only servers need explicit headers; native OAuth stays with the owning Agent profile.
Downstream tools run with the user's local permissions; adding a stdio server is equivalent to the `command` op.
There is no marketplace, multihop routing or public gateway.

## Protocol sources

- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
