# Setup protocol

Run `cli setup next` and follow its current step until `complete` is true.
`next --goal <goal>` previews without saving; submit choices through
`cli setup apply <stepId> --stdin` with `{"option":"<option-id>"}`.
For auto steps send `{}` unless the step requests input. Re-read next after apply.

Repeat decide explanations and option labels verbatim and identify the recommended
option. Never choose or skip on the user's behalf. If an auto step offers skip
because a prerequisite is missing, explain it and ask for that choice.

For authorize, secret, and remote-ui steps, read the matching playbook and open
the returned URLs. Login, authorization, consent, and secret entry belong to the
user. Secrets stay out of chat, CLI arguments, screenshots, and tool output.
Use browser tools first, computer-use/ARC screen second, or a link plus one
instruction when neither is available. A browser-only agent hands native dialogs
to the user if it has no native-app tool.

Run `cli setup wait --timeout 60` after external actions. Timeouts return the
current step successfully: continue waiting, do not infer completion from the UI.
Use fresh next output when the step changes. Surface returned findings.
For tunnel credentials only, apply accepts the non-secret `{"tunnelId":"..."}`.

The setup agent runs locally. Remote verification and the loop test use the
selected remote connector; a locally created task cannot prove that path.
For the loop test, prepare a prompt for the user to paste into the remote session,
then wait. Follow the loop-test playbook for the goal-specific session and prompt.
