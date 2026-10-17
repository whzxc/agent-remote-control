# Enable ARC in ChatGPT

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`
  (Plugins). Choose + → Add custom MCP server, then Tunnel and the tunnel matching
  `onboarding.tunnelId` (or enter that ID). Configure the connection for ARC's
  tunnel, which has no additional connector authentication. Hand login, risk
  acknowledgments, authorization, and final consent to the user. After creation,
  select the plugin in a conversation (for example with @).
- **Computer use / ARC screen only:** Navigate the same controls from screenshots;
  the user handles login and consent. Do not select a different tunnel.
- **Neither:** Give `openUrl` and say: “Add a custom MCP server using this Tunnel
  ID, complete the consent yourself, then enable the ARC plugin in a conversation.”

If the entry is unavailable, the user needs the workspace's custom MCP/developer
access. Run `cli setup wait`; ARC advances only after an authenticated MCP request
arrives through this ingress.

[Official ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
