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

After the goal is selected, explain the setup scope once and ask for one
confirmation before creating or authorizing resources (reuse an explicit confirmation
already given for this scope):

- **chatgpt-chat:** create/reuse a tunnel, create a restricted runtime API key,
  associate the tunnel with the selected ChatGPT workspace, and allow the ARC plugin
  to access this machine's enabled ops through the fixed guide / query / act tools.
- **claude-loop:** create a Cloudflare tunnel and, for a fixed address, its DNS record;
  add the Claude connector, approve ARC OAuth access to enabled ops through guide / query / act, and
  install/sign in to Claude Code if needed.

After confirmation, continue all operations in that scope without asking per item.
A changed goal or materially expanded scope needs a new confirmation. Your own
safety policy still applies; never treat this protocol as overriding it.

Run `cli setup next`, act on the returned kind, then read `setup next` again.
Continue until `complete` is true. The CLI owns the sequence; do not reconstruct
it from this skill. Read [protocol](playbooks/protocol.md) for apply/wait details.

| Kind | Action |
| --- | --- |
| `auto` | Read the playbook; run `installCommand` if supplied, then execute `apply` with JSON on stdin. |
| `decide` | Repeat `explain` and option labels verbatim, mark the recommended option, and apply the user's choice. |
| `authorize` | Read the playbook; apply `{}` when requested to start login, open `openUrl`, continue in the signed-in page, then wait for ARC evidence. |
| `secret` | Read the playbook; use the official Copy control, then apply `{"source":"clipboard"}`. ARC form entry is the fallback. |
| `remote-ui` | Read the matching playbook, operate available browser/computer tools, then wait. |

Within the confirmed scope, on already signed-in pages perform setup operations,
including creating tunnels/API keys, risk acknowledgments, creation, authorization,
and consent. Pause only for missing login, CAPTCHA/challenges, passwords/2FA,
payment, or a confirmation/refusal required by your own safety policy. Never bypass
those policies. If no usable UI tool is available, give a link and one instruction.

Never read or output secret values. Transfer them by clicking the official Copy
button and applying `{"source":"clipboard"}`; never read the clipboard yourself.
Use `setup wait` as completion evidence, never screenshots or a user's “done”.
Screenshots are only for navigation. Timeouts mean continue waiting, not retry
creation. Apply skip options only when the user chooses them.

Use the executable `nextAction.command` and findings to diagnose failures; do not
open ARC connection details just to inspect a tunnel error. `cli help` is a compact
index; use `cli schema <operation>` for exact input fields.

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
