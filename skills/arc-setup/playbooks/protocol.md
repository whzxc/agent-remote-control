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

For authorize, secret, and remote-ui steps, read the matching playbook and open
the returned URLs. Login, authorization, consent, and manual secret entry belong to the
user. Official Copy buttons can be clicked without reading the value; immediately
apply the secret step with `{"source":"clipboard"}`. Never read the clipboard. Secrets stay out of chat, CLI arguments, screenshots, and tool output.
Use browser tools first, computer-use/ARC screen second, or a link plus one
instruction when neither is available. A browser-only agent hands native dialogs
to the user if it has no native-app tool.

Run `cli setup wait --timeout 60` after external actions. Timeouts return the
current step successfully: continue waiting, do not infer completion from the UI.
Use fresh next output when the step changes. Surface returned findings.
For tunnel credentials, apply also accepts the non-secret `{"tunnelId":"..."}`.
Secret clipboard apply returns saved flags only; re-read next afterward.
For Cloudflare login and Claude Code readiness, apply `{}` to start the action
described by the playbook. Missing Claude Code returns installation guidance.

The setup agent runs locally. Remote verification and the loop test use the
selected remote connector; a locally created task cannot prove that path.
For the loop test, prepare a prompt for the user to paste into the remote session,
then wait. Follow the loop-test playbook for the goal-specific session and prompt.
