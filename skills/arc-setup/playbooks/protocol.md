# Setup protocol

Reply in the language of the user’s request. Pass `--locale zh-CN` for Chinese or `--locale en` for English on every `cli setup next`, `apply`, and `wait` call.

Run `cli setup next` and follow its current step until `complete` is true.
`next --goal <goal>` previews without saving; submit choices through
`cli setup apply <stepId> --stdin` with `{"option":"<option-id>"}`.
For auto steps read the playbook, run `installCommand` if supplied, then send `{}`
unless the step requests input. Re-read next after apply.

Repeat decide explanations and option labels verbatim and identify the recommended
option. Never choose or skip on the user's behalf. Install missing prerequisites
using the playbook; skip only when the user explicitly chooses it.

For authorize, secret, and remote-ui, read the matching playbook. Use browser
tools first, computer-use/ARC screen second. All playbooks follow this rule:

The user delegated setup. On already signed-in pages, perform setup operations,
including creating tunnels/API keys, risk acknowledgments, creation, authorization,
and consent. Pause only for missing login, CAPTCHA/challenges, passwords/2FA,
payment, or a confirmation/refusal required by your own safety policy. Never bypass
those policies. If no usable UI tool is available, give a link and one instruction.

Never read or output secret values. Click the official Copy button and immediately
apply `{"source":"clipboard"}`; never read the clipboard yourself. If no Copy
button exists, ask the user to copy manually; ARC's form remains a fallback.

Run `cli setup wait --timeout 60` after external actions. Timeouts return the
current step successfully: continue waiting, do not infer completion from the UI.
Use fresh next output when the step changes. Surface returned findings.
For tunnel credentials, apply also accepts the non-secret `{"tunnelId":"..."}`.
Secret clipboard apply returns saved flags only; re-read next afterward.
For Cloudflare login and Claude Code readiness, apply `{}` to start the action
described by the playbook. Missing Claude Code returns installation guidance.

The setup agent runs locally. Remote verification and the loop test use the
selected remote connector; a locally created task cannot prove that path.
For the loop test, prepare and send the prompt in the remote session using the
available UI tools, or ask the user to paste it there if none are available; then wait. Follow the loop-test playbook for the goal-specific session and prompt.

Assume ChatGPT access and try the actual setup pages; never inspect local
Codex/ChatGPT credentials or call internal APIs to preflight permissions.
On a visible Platform denial/403 or missing custom-MCP/developer access, apply
`chatgpt-fallback` with `{"reason":"platform-denied"}` or
`{"reason":"chatgpt-denied"}`. This exposes a decide step; relay its explanation
and options. Apply `{"option":"https-oauth"}` or `{"option":"retry"}` as chosen.
A rejected runtime key returns to `tunnel-credentials`; replace it via clipboard,
or report `{"reason":"runtime-key-rejected"}` to offer the same decide step.
The `fallback` object in next also describes this alternative. HTTPS avoids
Platform Tunnel permissions, but cannot bypass ChatGPT workspace restrictions.
