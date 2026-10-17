---
name: arc-setup
description: Configure Agent Remote Control (ARC) with the local CLI, guiding the user through choices, credentials, authorization, and a verified Claude Code cloud or ChatGPT remote task. Use when asked to set up ARC, connect Claude or ChatGPT to local Codex, or resume ARC onboarding.
---

# ARC setup

Use the user's ARC executable (`arc`, or the supplied absolute path). Commands
below follow that executable; installed desktop binaries also accept `cli`.

Run `cli setup next`, act on the returned kind, then read `setup next` again.
Continue until `complete` is true. The CLI owns the sequence; do not reconstruct
it from this skill. Read [protocol](playbooks/protocol.md) for apply/wait details.

| Kind | Action |
| --- | --- |
| `auto` | Execute `apply` with JSON on stdin. |
| `decide` | Repeat `explain` and option labels verbatim, mark the recommended option, and apply the user's choice. |
| `authorize` | Open `openUrl`, tell the user where to act, then wait. |
| `secret` | Open ARC's input and the credential source; the user enters the secret directly in ARC, then wait. |
| `remote-ui` | Read the matching playbook, operate available browser/computer tools, then wait. |

Never request, read, copy, or print secrets in chat or command-line arguments.
Leave login, authorization, and consent buttons to the user. Hand over before
credential entry or revelation; resume observation after secrets are hidden.
Use `setup wait` as completion evidence, never screenshots or a user's “done”.
Screenshots are only for navigation. Timeouts mean continue waiting, not retry
creation. Apply skip options only when the user chooses them.

Read only the current `step.playbook` from `playbooks/<id>.md`, or run
`cli setup playbook <id>` for the same source in `result.markdown`.
Available UI playbooks: [add-connector](playbooks/add-connector.md),
[consent](playbooks/consent.md), [verify-connector](playbooks/verify-connector.md),
[loop-test](playbooks/loop-test.md), [address-secret](playbooks/address-secret.md),
[tunnel-credentials](playbooks/tunnel-credentials.md),
[enable-in-chatgpt](playbooks/enable-in-chatgpt.md),
[codex-ready](playbooks/codex-ready.md), [permissions](playbooks/permissions.md).
Other step IDs use the protocol.
