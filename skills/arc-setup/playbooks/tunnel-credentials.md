# OpenAI Tunnel credentials

Open `credentialUrl` (OpenAI Platform → organization settings → Tunnels).
The user needs organization access. Leave login, authorization and consent to
them. The Tunnel ID is not a secret: apply it with `{"tunnelId":"tunnel_..."}`.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Navigate to the
  Tunnel and runtime-key controls. Click the official **Copy** button without
  reading the key, then apply `tunnel-credentials` with `{"source":"clipboard"}`.
- **Computer use / ARC screen:** Navigate while the key is hidden. Click its
  copy control and apply clipboard; do not screenshot a revealed key.
- **Neither:** Give the Platform link and say “Copy this Tunnel's runtime key.”
  Then apply clipboard. Also ask for manual copying if no copy button exists.

Never read clipboard contents or secret DOM values. Core saves the key, clears
the clipboard, and returns only `hasApiKey`. `secretUrl` opens ARC for manual
entry as a fallback. Run `cli setup wait` for both the ID and key to be saved.
