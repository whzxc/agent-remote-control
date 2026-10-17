# OpenAI Secure Tunnel credentials

Use `credentialUrl` for Platform and `secretUrl` for this ingress's ARC editor.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open Platform →
  Organization settings → Tunnels. Guide the user to create a tunnel in the
  organization linked to the intended ChatGPT workspace. User handles login,
  permissions, and runtime-key creation/revelation. Read only the non-secret
  Tunnel ID when the key is hidden, then submit
  `cli setup apply tunnel-credentials --stdin` with `{"tunnelId":"..."}`.
  Open `secretUrl`; the user pastes the runtime key into ARC and saves.
- **Computer use / ARC screen only:** Navigate the same pages from screenshots;
  hand over before any key is revealed. Read/apply the Tunnel ID only while no
  key is visible, or let the user enter both fields in ARC.
- **Neither:** Give both URLs and say: “Create a tunnel for your ChatGPT workspace,
  then enter its Tunnel ID and runtime key directly in ARC and save.”

Creation needs tunnel Read + Manage; runtime use needs Read + Use. Missing access
requires the user's organization administrator. ARC manages the tunnel client;
do not start another client. Never inspect a revealed key. Run `cli setup wait`.

[Official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
