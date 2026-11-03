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
or `cli skill install --target claude-code` when acting as Claude Code. These are
control-source skill targets. Antigravity and Pi are executable Agent IDs:
install and sign in to them natively, enable them in Agent management, and use
the `agent_*` operations. Continue with the current local management contract.

## Configure

Reply in the user's language. Discover inputs with `cli schema <operation>`;
execute them with `cli call <operation> --stdin`. These are local management
operations, not additional public MCP tools. Preserve the supplied state directory.

The main routes are local access and a remote link. Reuse the user's explicit
setup authorization; ask only for missing choices or an expanded resource scope.
Never initiate real login, deployment, or client installation during code-only work.

- **On this computer:** read `local-access.status`. Call `local-access.install`
  with `{"body":{"target":"code"}}` for an installed Claude Code, or
  `{"body":{"target":"desktop"}}` for Claude Desktop. Code uses `claude mcp add`;
  Desktop merges an entry into its official config and must be restarted by the
  user. Existing unrelated servers are preserved. Both use ARC's local stdio
  control-source protocol without a public address.
- **Create my relay:** read `relay.list` first. With authorization, call
  `relay.create`, then read `relay.progress`. Let the user complete Cloudflare
  login; `loginUrl` opens the same login if the browser did not open. When account
  selection is returned, select the user's account and call `relay.redeploy` for
  the saved relay ID. Reuse recoverable records instead of creating duplicates.
- **Use a shared relay:** call `relay.join` with the supplied shared link. Only
  join a trusted deployer: ARC shows them a computer list, but they can technically
  inspect relayed traffic in Cloudflare. Keep invitation links out of chat/logs.
- **Add a control source:** use the ready remote link for Claude, ChatGPT, Gemini,
  Grok, Copilot, or another compatible client. Copy the link, add it through the
  path in `shared/control-sources.json` (also returned by `ingress.presets`), then
  return to ARC and compare the four-character pairing code before approval.
  Read [consent](playbooks/consent.md). A grant proves authorization completed;
  a real remote tool request proves the client can use it. Offer the App's short
  trial prompt, then use [loop-test](playbooks/loop-test.md) only when a full Loop
  check is requested.

ChatGPT follows the same remote-link and local-approval route by default.
Account/workspace restrictions still apply. Do not infer access from local tokens
or preflight private account APIs. Use available browser tools for client setup;
if unavailable, give the link and one concise instruction.

`relay.cancel` cancels an active job; completed remote effects remain recoverable.
Owners use `relay.share`, `relay.reset-token`, `relay.instances`, `relay.remove`,
`relay.redeploy`, and `relay.delete`; members use `relay.leave`. Read current
schemas before writes. Deletion affects every joined computer. After an ARC
upgrade, offer the relay update shown in Settings.

## Advanced routes

**Settings → Remote link → Advanced** contains own addresses, OpenAI Secure
Tunnel, manual authentication, and **Send to Codex**. Use these only when the user
selects the advanced route. Existing configured connections remain usable.

The advanced Agent wizard retains `cli setup next/apply/wait`. Pass `--locale
zh-CN` or `--locale en`, follow the current step until complete, and read
[protocol](playbooks/protocol.md) and only its current playbook. Its older
`tunnel`/fixed-address sequence is not the main onboarding route.

Never output credentials. On advanced credential pages, use the official Copy
control and `{"source":"clipboard"}`. Pause for missing login, CAPTCHA, passwords,
2FA, payment, or an approval required by policy. Completion must come from fresh
ARC state and remote responses, not screenshots or a user's “done”.
