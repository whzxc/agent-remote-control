# Use the MCP hub

Add your MCP servers to ARC once. Every connected control source, such as Claude or
ChatGPT, then uses them through its existing ARC connection.

## Turn it on

Open Settings → About → Experimental and enable **MCP hub**. The hub appears in the
bottom-left navigation capsule.

## Add servers through an Agent

Ask any connected control source to configure the hub:

> Import my existing Codex MCP servers into the ARC MCP hub and list their tools.

> Add the MCP server at https://example.com/mcp to the ARC MCP hub with my API key in the Authorization header.

The Agent uses `mcp_configure`. Import reads your Codex, Claude, Cursor or Gemini
profile and keeps servers that already exist in the hub. After adding a server, ARC
connects it and reports its tools or the reason it failed.

## Use the tools

Ask for the work directly. The control source lists hub tools with `mcp_tools` and
calls them with `mcp_call`. You do not need to add the same server to each control
source.

## Manage servers

The hub page lists each server with its state, transport and tools. Use the switch
to turn a server off, the reconnect button to retry it, and the delete button to
remove it. Ask an Agent to change commands, URLs or credentials.

## Limits

- The hub is experimental and off by default.
- Servers run on this device with your permissions. Add only servers you trust.
- stdio and Streamable HTTP servers are supported. Legacy SSE servers are not.
- OAuth-only servers need an explicit Authorization header.
- Agents that ARC dispatches keep their own MCP configuration.
