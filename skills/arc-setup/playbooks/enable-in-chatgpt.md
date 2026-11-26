# Enable ARC in ChatGPT

- **Browser tools / ARC screen**: open `openUrl` (Plugins) in the **ChatGPT workspace associated with the tunnel**. If the tunnel is missing, check its workspace association in Platform Tunnels and add the workspace instead of creating a duplicate tunnel. Choose **+ → Add custom MCP server → Tunnel**, select `onboarding.tunnelId`, complete the risk acknowledgment, create the plugin, and select ARC in a conversation (e.g. `@`).
- **Neither**: share the link and Tunnel ID (`"Add this Tunnel as a custom MCP server, then select ARC in a conversation in its associated workspace."`).

Follow `protocol.md` for login/safety pauses. Report `chatgpt-denied` via `chatgpt-fallback` if custom-MCP/developer access is denied (after confirming tunnel workspace association), or `platform-denied` if Platform Tunnel access is denied. Run `cli setup wait` (verified only by an authenticated remote MCP request).

[Official guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
