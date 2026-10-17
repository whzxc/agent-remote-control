# ARC setup protocol

Run `cli setup next`. If no goal is saved, ask the user to choose and submit
`cli setup apply choose-goal --stdin` with `{"option":"claude-loop"}` or
`{"option":"chatgpt-chat"}`. `next --goal` previews a goal without saving it.

Repeat until `complete` is true:

- `auto`: execute `apply`, passing `{}` on stdin unless the step asks for input.
- `decide`: repeat `explain` and option labels verbatim, identify the recommended
  option, then submit the user's choice as `{"option":"<id>"}`.
- `authorize`: open `openUrl`; let the user perform login or consent, then wait.
- `secret`: open `openUrl` and `credentialUrl`; the user enters credentials in ARC.
- `remote-ui`: use browser or computer tools if available, otherwise give the URL
  and the step explanation. Leave login, authorization and consent to the user.

Never ask for secrets in chat or place them in command-line arguments. Use
`cli setup wait --timeout 60` to observe progress. A timeout returns the current
step and is not an error. For tunnel credentials, the non-secret Tunnel ID may
be submitted as `{"tunnelId":"..."}`; the runtime key goes only into ARC.
Optional readiness steps accept `{"option":"skip"}` only after the user chooses
that option. Skipping Claude Code disables notification acceptance; the loop
then checks the completed `ARC_ONBOARDING_OK` task and reports that limitation.

Read `onboarding.verificationPrompt` and `onboarding.executionPrompt` for the
current ingress. For the Claude loop include `notifyClaudeSession` with the
user's Claude Code cloud session when creating the task. A local probe does not
replace remote challenge verification. Step-specific browser playbooks are
placeholders until the skill content is delivered.
