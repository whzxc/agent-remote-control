# Enable ARC in ChatGPT

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`
  (Plugins) in the **same ChatGPT workspace associated with the tunnel**. If the
  tunnel is absent, open Platform Tunnels, select the existing tunnel, and add
  this ChatGPT workspace to its associations; do not create a duplicate tunnel.
  Return to that workspace's Plugins page. Choose + → Add custom MCP server → Tunnel. Select the tunnel matching
  `onboarding.tunnelId` (or enter the ID). ARC's tunnel needs no additional
  connector authentication. Complete the risk acknowledgment and Create as a
  plugin, then select ARC in a conversation (for example with @).
- **Computer use / ARC screen:** Navigate the same controls from screenshots.
- **Neither:** Give the link and Tunnel ID: “Add this Tunnel as a custom MCP server,
  then select ARC in a conversation in its associated workspace.”

Follow the protocol's login and safety-policy exceptions. If custom MCP/developer
access is explicitly unavailable, report `chatgpt-denied` through `chatgpt-fallback`.
A missing tunnel listing alone is not an access denial: check its workspace
association first. If the page explicitly denies Tunnel access, report
`platform-denied`. ARC cannot independently read the Platform workspace association;
control-plane authentication alone does not prove it. Run `cli setup wait`;
only an authenticated MCP request proves this step completed.

[Official guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
