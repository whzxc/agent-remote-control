# Choose an HTTPS connection

**English** | [简体中文](../zh-CN/guides/connections.md)

For Claude, add an HTTPS ingress with OAuth. For ChatGPT, start with [Secure Tunnel](chatgpt.md). Each ingress has its own provider, credentials, URL, and allowed tools.

| Provider | What to enter | Address |
| --- | --- | --- |
| Cloudflare Temporary | Nothing | Generated temporary hostname |
| Cloudflare Fixed | Tunnel token and configured public domain | Fixed hostname |
| ngrok | Authtoken; configured domain for fixed mode | Assigned or fixed hostname |
| Pinggy Temporary | Nothing | Temporary hostname |
| Pinggy Fixed | Token and assigned domain | Fixed hostname |
| LocalXpose | Access token and reserved/custom domain | Fixed hostname |
| Custom | Public MCP URL and local listener address/port | Your reverse proxy |

## Connect

1. Open the control source in ARC and edit its connection.
2. Choose the provider and enter the required fields. Use **Get token** links when offered.
3. Select the client's authentication: OAuth for Claude, or Bearer for clients supporting the `Authorization` header. Keep the Default op list to begin.
4. Save and connect. ARC downloads the provider component when needed and manages its process.
5. Copy the displayed MCP URL into the client and run the connection's verification prompt there.

Provider credentials connect the tunnel; MCP authentication controls access through it. They are separate fields. A fixed domain must already be assigned in your provider account.

## Use a custom reverse proxy

Route the public HTTPS hostname to ARC's loopback listener. Each fixed Cloudflare or custom ingress needs a distinct local port. Forward `/mcp` and every route listed in [OAuth reference](../reference/oauth.md#public-routes) when using OAuth. ARC's management API stays private.

## Keep the connection usable

For daily use, choose a fixed address. If a temporary address changes, update the connector's URL and authorize again. Use the connection details and Records to diagnose provider errors; use [FAQ](../faq.md) for client-side issues.

## Limits

ARC uses Streamable HTTP, not a standalone legacy SSE endpoint. LocalXpose temporary mode is unavailable because the first request is redirected. Provider accounts, domains, quotas, and outbound connectivity remain your responsibility. Choosing None authentication lets anyone who can reach the endpoint use its allowed tools.
