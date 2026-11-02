# Claude + Codex: close the Loop

**English** | [简体中文](../zh-CN/guides/claude.md)

Let Claude inspect the project, agree on a plan with you, and delegate implementation to local Codex. ARC brings the result back to the initiating Claude Code cloud session, so Claude can review it and continue.

Call `guide` first for this connection’s workflow, enabled ops, and examples. Use `guide({"op":"codex_create"})` for the full schema. Invoke operations through `query({"op":"…","args":{…}})` or `act({"op":"…","args":{…}})`; reread `guide` when a result’s `arcVersion` changes.

## Prepare

- Install ARC and sign in to Codex Desktop on the execution computer.
- Install and sign in to Claude Code CLI on that computer. Its cloud messaging command delivers follow-ups.
- Use a Claude account/workspace that can add custom connectors.
- Open a Claude Code cloud session on claude.ai. Claude can read its own session ID from its environment, for example the `cse_…` value in `CLAUDE_CODE_REMOTE_SDK_URL`, and bind itself as the notification target.

If Claude cannot read its own ID, paste the cloud session URL or ID instead.

Claude on the web, mobile, and desktop can use the remote connector. Start with [Getting started](../getting-started.md) if ARC is not installed.

## Use multiple Claude accounts

Open **Settings → Claude accounts**. Choose a browser beside **Sign in to Claude** and authorize each additional account. ARC keeps each login in a separate directory. ARC also retains the existing system CLI login in an isolated profile. **System default** marks the profile matching the current system login. If you switch the system CLI to another account, use **Import system login** to retain that account too. Existing notification routes keep their selected profiles.

Choose **Notifications** on the intended account. Enter the receiving conversation's `cse_…` or `session_…` ID and choose **Save account route**. This saves the host assignment for manual notifications and new source bindings. Existing control sources use their own saved routes. **Send notification** sends your message once and also saves an unassigned route; an existing different assignment must be changed explicitly. Check the receiving conversation before retrying an uncertain send.

Claude can bind its own notification target with `notify_control({action:"bind",target})`. For an unrouted target, ARC records the only profile confirmed to see that session. If `ACCOUNT_SELECTION_REQUIRED` is returned, Claude can inspect `notify_control({action:"route",target})` and choose `accountId` with the same action. The profile list contains only identity information. Route selection never signs in or changes the system Claude account. A changed route requires a new verification code and acknowledgement in the receiving conversation.

A normal Claude Chat can receive CLI notifications when it has a workspace session. Use its `workspace_session_id`, not the UUID in its `/chat/…` URL. A newly created Chat may not have a workspace yet; using Claude's cloud code execution can initialize it. Confirm the resulting ID before routing.

## Connect with a remote link

On Welcome, choose **Phone and web**, then **Claude**. Later, use **Remote link → Add control source**. Select a connection, or open **Add connection** and finish its Method → Configure → Ready flow. ARC returns with that connection selected.

In Configure, copy the address into Claude's **Settings → Connectors → Add custom connector** and connect. In Approval, compare the four-character codes, check the client and permissions, and enter an account name. If offered, choose **Reauthorize** to retain an existing source's history. Approve, return to Claude, then finish the ARC success screen.

For local use, choose **This computer** on Welcome, then **Claude Code** or **Claude Desktop**. Select its local connection or install it through Add connection. Restart the client; no pairing-code approval is needed.

To move an existing source, open its detail and choose **Change connection**. Select the target in ARC, then delete the old ARC connector in Claude and add it again with the new address. If the client supports editing the URL, editing also works. Return to ARC, compare the code, check **Claim as <account name>**, and approve. ARC retains the source's name, history and notification settings and revokes the old grant after the new authorization completes.

Open **Remote link → Connections** for addresses, sources using each connection, and removal. Relay owners enable **Relay hosting** under **Settings → About → Experimental**, then use its capsule entry to manage invites and devices. See [Connections](connections.md) for methods and relay trust boundaries.

## Start with current facts

> Use ARC to inspect this project's files, Git state, and recent Codex tasks. Explain the current implementation, propose the smallest complete change, and agree on the acceptance criteria with me before dispatching work.

Give a project name or absolute directory. Then dispatch one concrete round:

> Ask Codex to implement the agreed change in this project and run its existing checks. Use a fresh requestId. Set notify to {channel: "claude-session", target: your own Claude Code cloud session ID or URL}. Keep the returned threadId and turnId. When notified, read the task and inspect its changes against our acceptance criteria.

Call `act` with op `codex_create`, place `project`, `prompt`, and `notify` in args, and supply requestId at the outer level. Retain the receipt and task IDs. Use `query codex_wait` for an immediate check; after a timeout, continue with the same IDs and the returned snapshotHash as expectedHash.

## Receive, review, continue

Check `notify_status({target})` after binding a new session. `unverified` means receipt has not been confirmed; `failed` means a delivery failed or a handshake expired. Subscription status and available tokens do not prove reachability.

Call `notify_control({action:"verify",target})`. ARC sends a one-time code to that session; after receiving it, Claude calls `notification_ack({target,code})` within five minutes. Only `verified` with available delivery allows ending the turn to wait for a notification. The local Claude Code login must be able to reach that cloud session.

If unverified, failed or unbound, use the receipt's wait arguments. If Claude can schedule a return to the same conversation, use `next.revisitAfterMinutes` from matching historical duration samples; no samples means no minute recommendation. Only short tasks use segmented waits within the turn. Each Claude wait is at most 170000 ms; after timeout follow `next`.

ARC sends a fixed status message when a bound turn completes, fails, is interrupted, or needs approval/input. The message identifies the project, task, and turn. Claude then reads the actual output through `query codex_read` / `query codex_items`, and the changes through `query codex_changes` or `query git`.

Ask Claude to compare the result with the acceptance criteria, explain any remaining issue, and use `act codex_send` for the next round. Include `notify` on each new round. An input added to the current round retains its binding when the field is omitted. Set it to `null` to unbind. A confirmed native Codex retry immediately after a failed/interrupted round can inherit the binding within ten minutes; explicit binding or unbinding takes precedence. ARC records that retry for review. New Desktop messages and retries with unknown provenance do not inherit.

Read `notification` in the task result for delivery status. A binding failure appears as `bind-failed` in the dispatch receipt. Check **Records** if delivery fails. ARC retries with backoff and attempts one system notification for breaker or sustained token-starvation episodes.

## A useful working agreement

Agree on scope, existing checks, and which actions need your decision. Let Claude read the repository before planning, give Codex one clear round at a time, and review the diff before continuing. Keep approvals and questions visible; answer them through the original task's interaction flow. You can follow the conversation from your phone while the computer remains available.

The notification health line reports counts, without deciding whether a task is looping. Inspect `query notify_status` for buckets, backlog, recent batches and thread ownership. If needed, use `codex_send` to ask the Agent to combine questions or decide within its existing authority. `act notify_control` can mute a thread, enable hourly digests, rebind/unbind it, or trip a target breaker; each control is reversible. See the [tool reference](../reference/tools.md#control-source-notifications).

## Limits

- Import copies the existing OAuth authorization; separate storage does not create a new authorization. If the provider revokes or rotates it, log in again for that profile.

Automatic follow-ups require a cloud session or a Claude Chat with a workspace session, and the local CLI's cloud messaging support/login. An ordinary `claude.ai/chat/…` URL is not a target. ARC retains pending deliveries across restart and retries uncertain sends with the same eventId; ignore duplicate IDs. A needs-input event includes the question, options or approval details. Use the notification’s `respond` parameters directly with a result; refresh `codex_pending` only if the callback is missing or stale; asynchronous questions use `result: {answer: "your answer"}`. Follow `canRespond` and `next`; unsupported interactions require Desktop. A completion notification includes the last message verbatim and a full-text query when truncated. Read the diff when needed for review, and its cloud session must be able to continue. Keep ARC, its connection, and the computer running.
