# Connect another client

**English** | [简体中文](../zh-CN/guides/other-clients.md)

Add the client from ARC's home screen, choose the matching authentication, then copy its MCP URL into the client. Use [HTTPS providers](connections.md) to prepare the endpoint. [Claude](claude.md) and [ChatGPT](chatgpt.md) have dedicated guides.

| Client | Preset transport / auth | ARC preset status | Setup |
| --- | --- | --- | --- |
| Grok (`grok`) | https / oauth | conditional | Plugins → New Connector → Custom; OAuth |
| Microsoft Copilot (`microsoft-copilot`) | https / bearer | conditional | Copilot Studio: Authorization header or registered OAuth client |
| Notion (`notion`) | https / bearer | supported | Custom Agents; workspace access required |
| Slack (`slack`) | https / oauth | conditional | DCR or local OAuth preregistration; no Bearer |
| Cursor (`cursor`) | https / bearer | supported | Remote HTTP MCP with Authorization header |
| GitHub Copilot (`github-copilot`) | https / bearer | supported | Configure MCP in the IDE or CLI host |
| Raycast (`raycast`) | https / bearer | supported | HTTP Headers in AI MCP settings |
| Custom (`custom`) | https / bearer | custom | Match the client transport and authentication |

For a Bearer connection, copy the ingress token into the client's `Authorization: Bearer <token>` header. For OAuth, finish the client's authorization flow and approve in ARC. Run the connection verification prompt from the client afterwards.

Use Custom when your client is not listed. Multiple connections of the same kind are allowed. Use clear display names and separate ports for fixed listeners. `cli ingress presets` returns the current registry, official client documentation links, and supported authentication choices.

## Limits

Supported means ARC has the corresponding transport/auth path; conditional entries need the client's registration, tenant, or header setup. Client plans and administrator policy still apply. Slack identity signatures and arbitrary API-key headers/query tokens are not implemented. Separate connections share the same task namespace.
