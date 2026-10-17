# Add an HTTPS connector

Use `onboarding.url` from next; never substitute a local probe URL.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`.
  For Claude, Customize → Connectors → Add → Custom → Web. For ChatGPT, Plugins
  → + → Add custom MCP server → HTTPS/URL. Fill ARC's name and connection URL,
  select OAuth / automatic registration, complete the risk acknowledgment and
  create/connect. Follow the protocol's login and safety-policy exceptions.
  Approve ARC's pending request using the consent playbook's authenticated CLI.
- **Computer use / ARC screen:** Navigate the same controls from screenshots.
- **Neither:** Give the link and ARC URL: “Add this custom MCP connection with OAuth.”

On ChatGPT custom-MCP access denial, report `chatgpt-denied` as described in the
protocol; HTTPS cannot bypass a workspace restriction. Run `cli setup wait`.
