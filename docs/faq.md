# FAQ and troubleshooting

**English** | [简体中文](zh-CN/faq.md)

## macOS says the app is damaged

Verify the release checksum, move the app into Applications, and use the Gatekeeper steps in [Installation](installation.md#macos). Run the quarantine command only for that downloaded app.

## The client cannot connect

Open its ARC connection details and read the error. Check the public URL or Tunnel ID, then run the verification prompt from that client. For HTTPS, test the configured hostname and forward OAuth routes too. For Secure Tunnel, check Platform tunnel permissions separately from ChatGPT Developer Mode. `cli ingress doctor <id>` gives connection-specific diagnostics.

## OAuth opens ARC on the wrong computer

A deep link opens the app on the browser's device. Approve the pending request on the computer hosting the connection, then return to the original authorization page. The authenticated CLI can also approve it. See [OAuth](reference/oauth.md).

## New tools do not appear

Save the connection's tool list, then refresh MCP tools or reconnect that client. Select a preset again to adopt its current tools; saved custom allowlists stay exact. Additional Agent tools appear only when a non-Codex Agent is installed, available, and enabled.

## Where did Codex run the task?

Read `executionOwner` in the receipt/result. Desktop owns new tasks by default. Turning off **Automatically open Codex tasks** changes only future tasks to ARC's background executor. Reuse the original task ID to continue. See [Concepts](concepts.md).

## A wait timed out. Should I send the task again?

Call `codex_wait` / `agent_wait` again with the original task and turn IDs, using the returned snapshotHash as expectedHash. Read the original receipt if dispatch is uncertain. A wait timeout does not stop the task.

## Claude did not receive a follow-up

Check that notifyClaudeSession names a Claude Code cloud session, the local Claude Code CLI is logged in, and ARC remained running. Read `claudeNotification` and Records. Delivery is attempted once; review the task directly after a failed notification. See [Claude](guides/claude.md).

## Can I close the window or leave the computer?

Closing the ARC window keeps its menu-bar/tray process running. Keep the computer awake and connected. Sleep or loss of network interrupts remote access. Quitting the final Core client stops its background Agents; Codex Desktop-owned tasks follow Desktop's lifecycle.

## Why is quota information missing or stale?

Open the Agent in ARC and refresh its usage. Check the reported source error and the provider's native login. Some sources expose a plan without quota data. Cached readings are marked stale. See [Subscriptions](reference/subscriptions.md).

## Limits

Temporary tunnel URLs can change. Initial consent and task interactions may need your input. Ordinary Chat sessions need an active wait or another message to check progress; automatic Claude follow-ups use the cloud-session setup described above.
