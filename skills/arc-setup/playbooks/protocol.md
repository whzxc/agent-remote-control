# Advanced Setup Protocol

Use this sequence only for the explicitly selected wizard under **Settings → Remote link → Advanced** (local mode and shared relays use `arc-setup`; ChatGPT uses a remote link by default).

Reply in the user's language and pass `--locale zh-CN` or `--locale en` to every `cli setup next`, `apply`, and `wait` call.

1. Loop `cli setup next` until `complete` is `true` (`next --goal <goal>` previews without saving):
   - **Choice (`decide`)**: repeat the explanation and option labels verbatim, highlight the recommended option, and submit `cli setup apply <stepId> --stdin` with `{"option":"<option-id>"}`.
   - **Auto steps**: run `installCommand` if supplied, then apply `{}` unless input is requested, and re-read `next`.
   - **`authorize` / `secret` / `remote-ui`**: read only the current step's playbook (browser tools first, computer-use/ARC screen second).
2. **Scope confirmation**: after goal selection, explain the scope and get one confirmation (unless already given) and reuse it across the flow:
   - `chatgpt-chat`: tunnel creation, restricted runtime API key, target ChatGPT workspace association, and plugin access to enabled tools.
   - `claude-loop`: Cloudflare tunnel/DNS (for fixed addresses), Claude connector, ARC OAuth consent, and Claude Code installation/sign-in.
3. **Browser & secret hygiene**:
   - On already signed-in pages within confirmed scope, complete tunnel/API-key/connector creation, risk acknowledgments, and OAuth consent. Pause on missing login, CAPTCHA/challenges, passwords/2FA, payment, or safety-policy confirmations.
   - Never read or print secrets (click the official **Copy** button and apply `{"source":"clipboard"}`; use manual copy only if no Copy control exists).
4. **Waiting & findings**:
   - Run `cli setup wait --timeout 60` after external actions; timeouts return successfully—keep waiting rather than inferring completion from UI state.
   - Re-read `next` on step changes and run any returned `nextAction.command` (ARC ensures Tunnel Client >= 0.0.16 before OpenAI ingress; version findings take precedence over key replacement).
   - `tunnel-credentials` also accepts non-secret `{"tunnelId":"..."}`; `cloudflare-login` and `claude-code-ready` apply `{}` to start.
5. **Remote verification & ChatGPT fallback**:
   - Send the loop-test prompt in the remote session (a local task does not test remote delivery).
   - Never preflight ChatGPT permissions via local tokens or private APIs. On an explicit Platform 403/denial or missing ChatGPT custom-MCP/developer access, apply `chatgpt-fallback` with `{"reason":"platform-denied"}` or `{"reason":"chatgpt-denied"}` (or `{"reason":"runtime-key-rejected"}` on rejected runtime keys) and relay the returned options (`{"option":"https-oauth"}` or `{"option":"retry"}`).
