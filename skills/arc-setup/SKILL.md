---
name: arc-setup
description: Install and configure Agent Remote Control (ARC) with the local CLI, guiding the user through choices, credentials, authorization, and a verified Claude Code cloud or ChatGPT remote task. Use when asked to set up ARC, connect Claude or ChatGPT to local Codex, or resume ARC onboarding.
---

# ARC setup

## ARC not installed

Check the supplied CLI path first, then `/Applications/Agent Remote Control.app/Contents/Resources/bin/arc`
on macOS or `arc` on PATH on Linux. If absent, use the published installer:

```sh
installer=$(mktemp)
curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/whzxc/agent-remote-control/releases/latest/download/install-agent-remote-control.sh -o "$installer" &&
  sh "$installer" && rm -f "$installer"
```

On macOS it verifies and installs the App tarball, opens ARC, and waits for Core.
Read the last JSON line: use `cliPath` and set `ARC_STATE_DIR` to `stateDir` for
all following commands. Do not download or mount a DMG. Linux installs `arc` in
`~/.local/bin` (or `ARC_INSTALL_DIR`); Windows uses the official installer.

With ARC available, run `cli skill install --target codex` when acting as Codex,
or `cli skill install --target claude-code` when acting as Claude Code. Other
local Agents can read `cli setup playbook protocol` directly. Continue with the
installed protocol and `cli setup`; ask the user to choose the goal.

## Configure

Reply in the language of the user’s request. Pass `--locale zh-CN` for Chinese or `--locale en` for English on every `cli setup next`, `apply`, and `wait` call.

Use the user's ARC executable (`arc`, or the supplied absolute path). Commands
below follow that executable; installed desktop binaries also accept `cli`.

Run `cli setup next`, act on the returned kind, then read `setup next` again.
Continue until `complete` is true. The CLI owns the sequence; do not reconstruct
it from this skill. Read [protocol](playbooks/protocol.md) for apply/wait details.

| Kind | Action |
| --- | --- |
| `auto` | Read the playbook; run `installCommand` if supplied, then execute `apply` with JSON on stdin. |
| `decide` | Repeat `explain` and option labels verbatim, mark the recommended option, and apply the user's choice. |
| `authorize` | Read the playbook; apply `{}` when requested to start login, open `openUrl`, then wait for the user. |
| `secret` | Read the playbook; use the official Copy control, then apply `{"source":"clipboard"}`. ARC form entry is the fallback. |
| `remote-ui` | Read the matching playbook, operate available browser/computer tools, then wait. |

Never request, read, or print secrets in chat or command-line arguments.
You may click an official Copy button without reading its value, then ask ARC
to receive it from the clipboard. Never read the clipboard yourself.
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
[codex-ready](playbooks/codex-ready.md), [permissions](playbooks/permissions.md),
[cloudflare-login](playbooks/cloudflare-login.md),
[claude-code-ready](playbooks/claude-code-ready.md).
Other step IDs use the protocol.
