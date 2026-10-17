# Enable ARC in ChatGPT

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`
  (Plugins). Choose + → Add custom MCP server → Tunnel. Select the tunnel matching
  `onboarding.tunnelId` (or enter the ID). ARC's tunnel needs no additional
  connector authentication. Complete the risk acknowledgment and Create as a
  plugin, then select ARC in a conversation (for example with @).
- **Computer use / ARC screen:** Navigate the same controls from screenshots.
- **Neither:** Give the link and Tunnel ID: “Add this Tunnel as a custom MCP server,
  then select ARC in a conversation.”

Follow the protocol's login and safety-policy exceptions. If custom MCP/developer
access is explicitly unavailable, report `chatgpt-denied` through `chatgpt-fallback`.
If only Tunnel access is denied, report `platform-denied`. Run `cli setup wait`;
only an authenticated MCP request proves this step completed.

[Official guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
