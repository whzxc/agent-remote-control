# OpenAI Tunnel credentials

Use [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)
to reuse or create a tunnel associated with the intended Platform organization
and ChatGPT workspace. Apply its non-secret ID with `{"tunnelId":"tunnel_..."}`.
Use [Runtime API keys](https://platform.openai.com/settings/organization/api-keys)
to create a **restricted runtime API key**, with **Tunnels Read + Use** for the
target tunnel. Tunnel creation needs **Read + Manage** on the organization;
ChatGPT custom-MCP access is separate. Do not use an Admin API key, Tunnel ID,
ChatGPT session token, or locally stored Codex credentials as the runtime key.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** In the signed-in
  pages, create/reuse the tunnel and create the restricted key. Click the key's
  official **Copy** button, then apply `tunnel-credentials` with
  `{"source":"clipboard"}`. Follow the protocol's safety-policy exceptions.
- **Computer use / ARC screen:** Navigate to the same controls while credentials
  are hidden; use Copy and the same apply action without capturing the key.
- **Neither:** Give the Runtime API keys link: “Copy the runtime key with Tunnels
  Read + Use.” Apply clipboard after copying. Also use manual copying if no
  Copy control exists; `secretUrl` opens ARC's fallback form.

ARC checks the key's minimum shape, saves it, and only then clears the clipboard.
A rejected copy leaves the clipboard untouched. On 401/403, replace the runtime
key or report `runtime-key-rejected` via `chatgpt-fallback`; on a Platform access
block report `platform-denied`. Do not ask about permissions before trying.
Run `cli setup wait`; a saved key alone does not prove control-plane authentication.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
· [Official onboarding / key sources](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
