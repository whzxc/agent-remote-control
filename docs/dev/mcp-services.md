# Experimental MCP services

MUST means a requirement. SHOULD means the default unless a concrete reason justifies an exception. MAY means an option.

## Ownership

The experiment is disabled by default through the `mcp-services` device preference.
Settings → Experimental owns only its enable switch.
Enabling it exposes an independent MCP services workspace in the shared navigation capsule.
Ingresses and the upper connection arc retain their existing control-source ownership.
The context provider, native Agent profiles, and Codex's existing `mcp` operation retain their existing owners.

The device-owned service store contains stdio commands or Streamable HTTP endpoints, credentials, and explicit Agent assignments.
Configuration stays outside the repository.
Local management owns creation, editing, removal, explicit checks, and adoption of selected `agents/mcp.json` entries.
Adoption overlays the selected entry while enabled and preserves the original file.
External changes to an adopted entry require explicit reconciliation.
Native profile name collisions and identical connection configurations MUST fail before prompt submission instead of duplicating or replacing a server.
Checks read declared JSON/JSONC profiles for Claude, OpenCode, Cursor, Gemini, and Qwen.
Other Agent-specific and enterprise-provided sources remain native-owned and require distinct explicit assignments.

## Session contract

ACP v1 Agents receive stdio servers through `session/new` and supported `session/load` requests.
Remote services use an ARC-owned Rust stdio adapter with a launch-time environment snapshot.
The adapter supports JSON and SSE POST responses, negotiated protocol and session headers, and concurrent JSON-RPC requests.
ARC does not require a resident Node bridge.
External stdio executables remain user-owned dependencies.

Changes apply when a new ACP process creates or loads a session.
An existing process retains its launch-time configuration across turns.
Disabling the experiment preserves saved configuration and existing processes.
New processes stop using experimental assignments.
Legacy ACP configuration and the context provider continue to apply independently.
Task readback records applied service names, transports, revisions, and observation time without credentials.

Codex retains native MCP profiles, catalog discovery, and native OAuth login.
Pi retains its native configuration because Pi RPC has no session MCP-server parameter.
The workspace displays this support boundary for every Agent.
This version assigns services to Agents only.

## Connections and discovery

Saving configuration records an unchecked state.
An explicit check starts a real connection, negotiates initialization, and paginates `tools/list`.
The check closes its temporary connection after discovery.
Its result describes that observation rather than a persistent connection.
Edits invalidate the previous check.
Failures retain their stage and actionable recovery instructions.
Connection loss never automatically replays a tool call.

Remote bearer tokens and custom headers use local configuration.
Native OAuth uses the current Codex MCP contract and its returned authorization URL.
ARC does not add an identity platform or infer account validity.
Readback excludes argument values, environment values, header values, and endpoint queries.
Blank credential fields preserve saved values; explicit empty arrays or objects clear them.

`mcp_services` exposes redacted configuration and check results through the existing catalog and guide.
Agent tools remain attached to the Agent session that received them.
The existing native `mcp` operation retains its task association and authorization rules.
The frozen `guide` / `query` / `act` tools and `notification {op,args}` event are unchanged.

## Limits

The HTTP adapter implements the handshake-era Streamable HTTP contract through protocol version `2025-11-25`.
It does not open a standalone GET subscription stream or replay disconnected streams.
Native OAuth credentials remain usable through their native profile; custom HTTP assignments use explicit headers.
Native Agent implementations determine whether session-provided tools become available to their model.
There is no public gateway, multihop routing, workflow engine, marketplace, or website proxy.

## Protocol sources

- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
