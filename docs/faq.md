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

## Check permissions and readiness

Before remote use, open ARC **Settings → Permissions & readiness** locally and choose **Check again**. Use **Grant access** where needed. Returning from System Settings refreshes the page.

Accessibility enables screen tree / press / show / key / raise. Screen recording enables capture and windows titles; macOS may require reopening ARC. Use Full Disk Access for file tools: projects in Documents, Desktop, Downloads, external disks or network volumes can otherwise prompt or fail. Core uses a read-only heuristic with granted / missing / unknown results; unknown is not permission. command checks FDA through its executor only when cwd is in a protected location.

Notification permission is checked in ARC Desktop for closed-loop fallback delivery; without Desktop only a log is recorded. Login readiness checks registration and disabled state. Codex, Claude and ingress verification appear on the same page. Inapplicable Windows/Linux permissions do not require action.

### Why does an update ask for permissions again?

macOS grants are tied to the app's code-signing identity. Official macOS builds use a fixed personal self-signed certificate and stable bundle identifiers to preserve that identity across updates. Switching from an older ad-hoc build to this certificate may require granting access once more. Replacing the certificate, even with the same name, can invalidate existing grants. Open **Settings → Permissions & readiness** after updating; do not repeatedly remove and re-add permissions when the signing identity has not been checked.

### Why does a remote tool return PERMISSION_REQUIRED?

Tools never request system consent. The error includes permissionId; use the local permissions page and retry. A terminal's grants do not establish permissions for Core, screen helper or the Codex executor. The FDA heuristic does not guarantee access to every volume.

For the bundled Desktop launch chain, grant Full Disk Access to ARC App: Core and its Codex app-server children inherit that responsible application. A standalone Core launched by a terminal can instead inherit that terminal's identity; its probe does not prove the App is ready.

Paths referenced in command arguments are not inspected; enabling Full Disk Access can prevent permission dialogs during calls.

### Why does screen recording still show “Not authorized” after I enable it?

Reopen ARC, then choose **Check again**. ARC checks the access available to its screen helper; an enabled switch in System Settings alone does not establish that the running app has access.

After an application identity change, macOS can display an old authorization under the same app name. Current ARC uses `com.whzxc.agent-remote-control`; older builds used `com.whzxc.local-connector.desktop`. If removing and granting again has no effect, stop repeating it and check the identity receiving the authorization. Old application copies registered with LaunchServices and a long-running system authorization prompt process can retain the old identity.

Troubleshooting should unregister only confirmed old copies, register the current installation, fully quit System Settings, and, when logs identify it as the source, restart the system authorization prompt process. Keep backups and existing authorization records. Grant access again only after checking that the stale registrations and processes are gone, then verify ARC's status. ARC does not reset the permission database or manage these system processes automatically.
