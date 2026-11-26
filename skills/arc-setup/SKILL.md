---
name: arc-setup
description: Install and configure Agent Remote Control (ARC) with the local CLI, guiding the user through choices, credentials, authorization, and a verified Claude Code cloud or ChatGPT remote task. Use when asked to set up ARC, connect Claude or ChatGPT to local Codex, or resume ARC onboarding.
---

# ARC Setup

## 1. Ensure ARC is Installed

Check the supplied CLI path first, then `/Applications/Agent Remote Control.app/Contents/Resources/bin/arc` (macOS) or `arc` on `PATH` (Linux). If missing, run the official installer (do not mount a DMG manually):

```sh
installer=$(mktemp)
curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/whzxc/agent-remote-control/releases/latest/download/install-agent-remote-control.sh -o "$installer" &&
  sh "$installer" && rm -f "$installer"
```

Read the last JSON line: use `cliPath` and set `ARC_STATE_DIR` to `stateDir` for all subsequent commands. Then install control-source skills for your active harness (`cli skill install --target codex` or `--target claude-code`; Antigravity and Pi are executable `agent_*` targets managed natively).

## 2. Configure Main Routes

Reply in the user's language. Discover inputs with `cli schema <operation>` and run `cli call <operation> --stdin` (local management ops, not public MCP tools). Reuse the user's setup authorization; ask only for missing choices or expanded scope. Never trigger real login, deployment, or client install during code-only work.

| Route | Steps |
| --- | --- |
| **On this computer** (local stdio MCP) | Read `local-access.status`, then call `local-access.install` with `{"body":{"target":"code"}}` (Claude Code) or `"desktop"` (Claude Desktop; user must restart Desktop). Preserves unrelated MCP servers. |
| **Create my relay** | Read `relay.list` first (reuse recoverable records). Call `relay.create` → `relay.progress`; let user complete Cloudflare login (`loginUrl` if needed). If account selection is returned, select account and call `relay.redeploy`. |
| **Use a shared relay** | Call `relay.join` with the shared link (only trust deployers who may inspect Cloudflare-relayed traffic; keep invite links out of logs/chat). |
| **Add a control source** | Copy the ready remote link for Claude, ChatGPT, Gemini, Grok, or Copilot via `shared/control-sources.json` (`ingress.presets`), then match the 4-char pairing code in ARC using [playbooks/consent.md](playbooks/consent.md). Verify with the short trial prompt, or [playbooks/loop-test.md](playbooks/loop-test.md) when a full Loop check is requested. |

- Owners manage relays via `relay.share`, `relay.reset-token`, `relay.instances`, `relay.remove`, `relay.redeploy`, `relay.delete` (affects all joined hosts), and `relay.cancel`; members use `relay.leave`. After an ARC upgrade, offer any relay update shown in Settings.
- For ChatGPT, follow the default remote-link + approval flow (try the real setup pages rather than probing local tokens or private APIs; use browser tools when available).

## 3. Advanced Routes

Only when the user chooses **Settings → Remote link → Advanced** (own addresses, OpenAI Secure Tunnel, manual auth, **Send to Codex**), run `cli setup next|apply|wait --locale <zh-CN|en>` and read [playbooks/protocol.md](playbooks/protocol.md) plus only the active step's playbook.

Never output credentials (use Copy + `{"source":"clipboard"}`). Pause on missing login, CAPTCHA, passwords, 2FA, payment, or policy confirmations. Confirm completion from fresh ARC state and remote responses.
