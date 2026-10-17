# Claude + Codex: close the Loop

**English** | [简体中文](../zh-CN/guides/claude.md)

Let Claude inspect the project, agree on a plan with you, and delegate implementation to local Codex. ARC brings the result back to the initiating Claude Code cloud session, so Claude can review it and continue.

## Prepare

- Install ARC and sign in to Codex Desktop on the execution computer.
- Install and sign in to Claude Code CLI on that computer. Its cloud messaging command delivers follow-ups.
- Use a Claude account/workspace that can add custom connectors.
- Open a Claude Code cloud session on claude.ai. Claude can read its own session ID from its environment, for example the `cse_…` value in `CLAUDE_CODE_REMOTE_SDK_URL`, and bind itself as the notification target.

If Claude cannot read its own ID, paste the cloud session URL or ID instead.

Claude on the web, mobile, and desktop can use the remote connector. Start with [Getting started](../getting-started.md) if ARC is not installed.

## Connect through HTTPS and OAuth

1. In ARC, add **Claude**. Keep **HTTPS** and **OAuth** selected.
2. Select a [provider](connections.md). Start with Cloudflare Temporary, or use a fixed HTTPS address for ongoing work.
3. Save and connect. Copy the resulting `/mcp` URL.
4. Add a custom connector in Claude with that URL and start OAuth authorization.
5. Keep the web authorization page open. Select **Open ARC**, review the target connection and callback, then allow the request in the local app. Return to the authorization tab to complete the redirect.
6. Enable the connector in Claude and run the connection's verification prompt.

If the browser is on another device, approve in ARC on the execution computer. A local Agent can also use the authenticated [OAuth CLI](../reference/oauth.md#local-management). For a custom reverse proxy, forward OAuth routes as well as `/mcp`.

Claude's [connector documentation](https://claude.com/docs/connectors/building) describes its remote MCP and registration flow. ARC supplies the OAuth server and local consent; no authorization password is needed.

## Start with current facts

> Use ARC to inspect this project's files, Git state, and recent Codex tasks. Explain the current implementation, propose the smallest complete change, and agree on the acceptance criteria with me before dispatching work.

Give a project name or absolute directory. Then dispatch one concrete round:

> Ask Codex to implement the agreed change in this project and run its existing checks. Use a fresh requestId. Set notifyClaudeSession to your own Claude Code cloud session. Keep the returned threadId and turnId. When notified, read the task and inspect its changes against our acceptance criteria.

The corresponding tool call is `codex_create` with `project`, `prompt`, `requestId`, and `notifyClaudeSession`. Retain the receipt and task IDs. Use `codex_wait` for an immediate check; after a timeout, continue with the same IDs and the returned snapshotHash as expectedHash.

## Receive, review, continue

After dispatching, Claude can end its turn. When Codex finishes, the notification wakes the same Claude Code cloud session to review the changes and continue.

ARC sends a fixed status message when a bound turn completes, fails, is interrupted, or needs approval/input. The message identifies the project, task, and turn. Claude then reads the actual output through `codex_read` / `codex_items`, and the changes through `codex_changes` or `git`.

Ask Claude to compare the result with the acceptance criteria, explain any remaining issue, and use `codex_send` for the next round. Include `notifyClaudeSession` on each new round. An input added to the current round retains its binding when the field is omitted. Set it to `null` to unbind. An immediately following continuation of an interrupted round can inherit the binding; explicit binding or unbinding takes precedence.

Read `claudeNotification` in the task result for delivery status. A binding failure appears as `bind-failed` in the dispatch receipt. Check **Records** if delivery fails. On macOS, ARC also attempts a system notification.

## A useful working agreement

Agree on scope, existing checks, and which actions need your decision. Let Claude read the repository before planning, give Codex one clear round at a time, and review the diff before continuing. Keep approvals and questions visible; answer them through the original task's interaction flow. You can follow the conversation from your phone while the computer remains available.

## Limits

Automatic follow-ups require a Claude Code cloud session and the local CLI's cloud messaging support/login. An ordinary `claude.ai/chat/…` URL is not a target. ARC attempts each status delivery once; it does not retry uncertain sends. A notification carries status, not the full diff. Claude must read and review the result, and its cloud session must be able to continue. Keep ARC, its connection, and the computer running.
