# Let a local Agent set up ARC

**English** | [简体中文](zh-CN/auto-setup.md)

Paste one prompt into a local Codex or Claude Code session on the computer that will run ARC. Provide the project when asked; let the Claude Code cloud session bind its own ID. The Agent should use the installed app's `cli help`, `cli guide`, `cli capabilities`, and `cli schema <operation>` before changing settings. See the [CLI reference](reference/cli.md) for executable paths.

## Codex → Claude

> Set up Agent Remote Control for Claude on this computer. Read https://github.com/whzxc/agent-remote-control/blob/main/docs/getting-started.md and the installed CLI help/guide. Install the current official release if absent, verify its checksum, and preserve existing connections. Add a Claude HTTPS + OAuth ingress; use Cloudflare Temporary unless I provide a fixed domain. Guide me through the Claude custom connector and local consent. Verify from Claude with connector_verify. Check the local Claude Code CLI and help the initiating Claude Code cloud session read its own ID and set notifyClaudeSession; ask me to paste its URL or ID only if that is unavailable. From that session, create one no-tools/no-files Codex task that replies ARC_LOOP_OK with notifyClaudeSession set, then verify the notification and final output. Report any remaining step.

## Codex → ChatGPT

> Set up Agent Remote Control for ChatGPT Chat on this computer. Read https://github.com/whzxc/agent-remote-control/blob/main/docs/guides/chatgpt.md and the installed CLI help/guide. Install the current official release if absent and preserve existing connections. Use OpenAI Secure Tunnel; help me obtain the official Tunnel ID/runtime key and enter them locally without putting secrets in chat. Help me enable Developer Mode and select the tunnel in ChatGPT. Run connector_verify from ChatGPT, then a no-tools/no-files Codex task that replies ARC_ONBOARDING_OK. Retain its IDs and wait in 30-second slices until the final output. Help me select the available Chat Pro option separately from Codex's model.

## Claude Code → Claude

> Configure Agent Remote Control on this computer for my Claude custom connector. Read https://github.com/whzxc/agent-remote-control/blob/main/docs/guides/claude.md and the installed CLI help/guide. Install the official release if needed, verify it, and preserve current connections. Add HTTPS + OAuth, use a temporary Cloudflare address unless I supply a fixed domain, and guide me through local consent. Verify the connector from Claude. Confirm this local Claude Code CLI can use my cloud session. Have the cloud session read and bind its own ID, not the local session ID; ask me to paste its URL or ID only as a fallback. Help that cloud session dispatch a harmless Codex task with notifyClaudeSession and verify both notification and result.

## Claude Code → ChatGPT

> Configure Agent Remote Control for ChatGPT Chat. Read https://github.com/whzxc/agent-remote-control/blob/main/docs/guides/chatgpt.md and the installed CLI help/guide. Install the official release if needed and preserve existing connections. Set up OpenAI Secure Tunnel with credentials entered locally, then guide me through ChatGPT Developer Mode and tunnel selection. Verify connector_verify from ChatGPT and a harmless Codex task returning ARC_ONBOARDING_OK. Keep the original request/task IDs through timeouts. Finish by explaining how to plan in Chat's available Pro model and execute in Codex.

## Limits

Account login, workspace permissions, Tunnel identity creation, and OAuth consent need the relevant account holder. An Agent can prepare settings and explain the next action; a successful local command alone does not verify the remote client's connection. Stop at any step that requires missing credentials or a user decision, and report it precisely.
