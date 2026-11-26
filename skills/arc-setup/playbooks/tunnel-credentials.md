# OpenAI Tunnel Credentials

1. **Tunnel**: on [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), reuse or create a tunnel linked to **both** the Platform organization and the target ChatGPT workspace (org-only association hides the tunnel in ChatGPT), then apply `{"tunnelId":"tunnel_..."}`.
2. **Restricted runtime key**: on [Runtime API keys](https://platform.openai.com/settings/organization/api-keys), create a key with **Tunnels Read + Use** for that tunnel (requires org **Read + Manage** to create tunnels). Name it `arc-<tunnel-id>-runtime-<timestamp>` and record only the key name, never its value (do not use Admin keys, Tunnel IDs, ChatGPT tokens, or local Codex credentials).
   - **Browser / screen**: click the key's official **Copy** button while hidden, then apply `tunnel-credentials` with `{"source":"clipboard"}` (if no Copy control exists, ask the user to copy manually or use `secretUrl`).
3. **Verify & revoke old key**:
   - Read `setup next` / `cli ingress doctor <ingressId>` and run any Tunnel Client upgrade `nextAction` first. Execute `create-ingress` when returned, then `cli setup wait`.
   - On confirmed runtime 401/403, replace the runtime key or report `runtime-key-rejected` via `chatgpt-fallback`; on explicit Platform denial, report `platform-denied`.
   - Once `controlPlane.state: authenticated` is reported, revoke **only** the exact previously replaced ARC-created key name on Platform API keys if known from this setup's history; leave uncertain keys untouched and note them.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) · [Official onboarding / key sources](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
