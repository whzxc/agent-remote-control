# Control source support

Nine curated presets plus Custom. Other MCP clients use Custom. Presets describe client capabilities, not completed client verification or separate protocols/services. Multiple entries of the same type are allowed; ingress.id is the identity.

| Control source | Remote MCP | Recommended transport | Recommended auth | Agent Remote Control（ARC） availability | Caveat / official docs |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | Supported | openai-tunnel | openai | supported | Prefer Secure Tunnel. HTTPS also supports OAuth with local app consent via clc:// or authenticated CLI consent. Tunnel access and client developer-mode permissions are separate. [Official 1](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) / [Official 2](https://developers.openai.com/api/docs/guides/developer-mode) |
| Claude | Supported | https | oauth | conditional | OAuth uses local app consent via clc:// or authenticated CLI consent and DCR or preregistered client credentials. Organization static-header beta can still use Bearer. Verify the client registration flow. [Official 1](https://claude.com/docs/connectors/building) / [Official 2](https://claude.com/docs/connectors/building/authentication) |
| Grok | Supported | https | oauth | conditional | Plugins → New Connector → Custom; enter the public MCP URL and complete OAuth with local app consent. Forward OAuth discovery and authorization routes as well as /mcp. Grok Bot uses Custom. [Official](https://docs.x.ai/grok/connectors) |
| Microsoft Copilot | Supported | https | bearer | conditional | Copilot Studio can use Authorization: Bearer <token> through API-key headers, or OAuth with registered client credentials. Verify actual tenant compatibility. Other API-key headers are not implemented. [Official 1](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent) / [Official 2](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-create-new-server) / [Official 3](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-fundamentals-publish-channels) |
| Notion | Supported | https | bearer | supported | Notion Custom Agents support header authentication via Authorization: Bearer <token>. Notion requires an eligible plan and workspace permissions. [Official 1](https://www.notion.com/help/mcp-connections-for-custom-agents) |
| Slack | Supported | https | oauth | conditional | OAuth supports dynamic or local preregistration and local app consent via clc:// or authenticated CLI consent. Verify the Slack client flow. Signed Slack identity is not implemented; Bearer is not compatible. [Official 1](https://docs.slack.dev/ai/slackbot-mcp-client/) |
| Cursor | Supported | https | bearer | supported | Configure a remote MCP URL and Authorization: Bearer <token>. Use a client version that forwards configured headers; verify the actual request. [Official 1](https://cursor.com/docs/context/mcp) / [Official 2](https://prod.cursor.com/help/customization/mcp) |
| GitHub Copilot | Supported | https | bearer | supported | Available in supported VS Code, JetBrains and CLI surfaces; use each host’s HTTP MCP configuration and Authorization: Bearer <token>. Host capabilities and organization policy differ. [Official 1](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp) / [Official 2](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) |
| Raycast | Supported | https | bearer | supported | AI Chat, Quick AI and AI Commands use HTTP MCP. Set Authorization: Bearer <token> in HTTP Headers; Raycast AI plan availability applies. [Official 1](https://manual.raycast.com/ai/model-context-protocol) |

HTTPS uses Streamable HTTP; ARC does not implement legacy standalone SSE transport. Microsoft Copilot means the Copilot Studio integration, publishable to Teams / Microsoft 365 Copilot; Teams is not a separate preset. GitHub Copilot is distinct, with VS Code/JetBrains/CLI as hosts.

## Authentication intersection

Notion, Cursor, GitHub Copilot and Raycast can reuse generic HTTPS with `Authorization: Bearer <token>`. Claude organization-admin static headers beta can use the same path; OAuth is also available with local app consent via clc:// or authenticated CLI consent. For Copilot Studio, configure API-key Header named Authorization with the complete value `Bearer <token>`. This is a compatibility inference from the documented Header mechanism, requiring actual tenant forwarding verification, not a claim of client acceptance.

Slackbot documents none, Slack identity, DCR and manual OAuth. Its custom headers concern identity lookup, not MCP requests. ARC supports none and OAuth with DCR or local preregistration. Do not present bearer as supported by Slackbot or silently downgrade to no-auth; the UI requires an explicit choice. Use OAuth for authenticated HTTPS connections. ChatGPT Secure Tunnel remains a separate supported path; mixed per-tool authentication is not implemented.

ARC accepts only `openai` / `none` / `bearer` / `oauth`. OAuth provides PKCE, DCR, local app or authenticated CLI consent, refresh and revocation; see [OAuth](oauth.md). Arbitrary static key headers, query tokens and Slack signature verification are not implemented. Existing Authorization headers cover multiple clients, so no new static-header abstraction is needed. No-auth exposes allowed tools to network-reachable callers; select it only for intentionally public tools. Auth and toolPolicy are per ingress; tasks remain shared.

## CLI / Codex

Run `cli ingress presets` offline for IDs, recommendations, client auth capabilities and limitations. Help includes presets; ingress list and onboarding attach each entry’s preset metadata. `supportedAuth` describes the client/ARC intersection; `recommendedAuth` describes a preference rather than completed client verification, while `httpsAuth` is a safe UI initial value, not connection proof. Custom has no brand allowlist.

Natural-language requests map to:

- “Add Cursor” → cursor + https + bearer.
- “Add another work Notion with bearer” → new notion + https + bearer entry with a custom name; preserve existing entries.
- “Configure Raycast HTTPS” → raycast + https + bearer.
- “What is missing for Copilot Studio?” → microsoft-copilot; explain conditional API-key Header compatibility and OAuth client registration and local app or authenticated CLI consent when OAuth is required.

Omitted names use the first available Notion, Notion 2, Notion 3, etc. Explicit names are preserved. Saved/ready does not mean connected: follow [Codex setup](codex-setup.md), verify connector_verify from the actual client, then perform harmless task acceptance when required.

## Tool list

The connection editor ends with **Tool list: All / Default / Read-only / Custom**. Default stores an explicit allowlist. All explicitly enables the full registry, including advanced tools; Custom enables selected tools. The field shows the current tool count and View all opens a second dialog. Presets show their selected tools there; Custom allows grouped or individual selection, with Done applying changes to the connection form and Cancel discarding them. Selecting operations retains required receipt, status, wait and output readers; it does not automatically enable optional write operations. `connector_verify` stays available in policies generated by the editor: it writes only connection verification records and is the maintenance exception to Read-only.

Default includes 23 always-available tools for project reads, text edit/write, commands, logs, daily Codex tasks and receipts. Another 12 non-Codex tools appear only when a local non-Codex agent is available and enabled. The 12 advanced tools cover low-frequency native interfaces, process, mcp, fs, fuzzy file search and git_write. The UI marks advanced and unavailable tools and counts available selections. See the [tool inventory](tools.md). Read-only excludes receipt, text writes, commands and other mutating tools.

These are top-level MCP exposure policies, enforced on both `tools/list` and `tools/call`. They do not filter actions or native methods within an allowed tool, isolate task ownership, or make the OS sandbox read-only. Tasks still use their own execution permissions. The local authenticated management catalog always contains the full registered inventory.

An existing allowlist is shown as a preset only when its complete set matches that preset; otherwise it is Custom. Opening or saving other fields preserves it. Explicit tool changes normalize dependencies, remove duplicates and use registry order. New tools do not expand saved allowlists; select a preset again to adopt its current definition. Saving reconnects only the edited connection. Policy changes preserve its verification identity; a changed public URL or authentication still follows the usual identity reset rules. Clients may cache tool discovery: refresh their MCP tools or reconnect that client after saving. ARC does not promise an automatic client refresh.
