# Unified macOS updates and local replacement

MUST means a requirement. SHOULD means the default. MAY means an option.

Use `arc cli app replace /absolute/path/Agent\ Remote\ Control.app` to install a local build while ARC owns the calling task. The operation is a local alias for the unified update pipeline. Release downloads also use this worker after updater signature verification. Control sources use query `update_status` and act `update_request` on the existing frozen tools. Windows and Linux return `NOT_SUPPORTED`.

## Install

Validate without changing the installation or starting a helper:

```sh
NEW_APP="/absolute/path/Agent Remote Control.app"
"$NEW_APP/Contents/Resources/bin/arc" cli app replace "$NEW_APP" --check
```

Start replacement as the final command of the task:

```sh
"$NEW_APP/Contents/Resources/bin/arc" cli app replace "$NEW_APP" --now
```

The candidate CLI supports the first upgrade from an installed version without `app replace`. It discovers the running Desktop through authenticated local management instead of treating its own bundle as the installed target. Set `ARC_STATE_DIR` when using a nondefault instance. The target is always the bundle of that instance's running Desktop. Source and target MUST be separate bundles. For an isolated acceptance instance, use its reported state directory and a separate candidate copy with the exact same acceptance bundle ID. The selected state must retain its matching `acceptance-instance.json` marker. `--check` validates that pair without launching a worker or creating a backup; it cannot target the installed production or ordinary Dev identity through isolated state.

Use `--now` for an explicit user request to build and replace the local installation immediately. It skips task-idle checks and the scheduled countdown; active ARC-owned tasks are recorded before interruption and eligible Codex turns continue after verified recovery. Receipt acknowledgment, package validation, owner identity, process exit and rollback remain required. Without `--now`, the helper waits for blockers, validates the prepared packages, then announces a ten-second restart countdown. `--check`, `--now` and `--stdin` may be combined in any order. JSON callers set `immediate:true`.

The caller MUST save the returned `id`, `statusPath`, and `logPath`.
The calling turn MUST end after receiving the receipt.
The turn MUST NOT continue work depending on ARC or poll for replacement completion.
New ARC dispatches are durably held while the job is settling or later. Held receipts retain the original request ID and say they are waiting for an update. They are released after the terminal outcome.
The source bundle MAY be removed after the receipt because staging is complete.
Keep the candidate CLI available if rollback could restore an older version without the replacement status command.

After reconnecting, query from a new turn or independent terminal:

```sh
arc cli app replace --status
arc cli app status
arc cli status
```

`app replace --status` reads local durable state even if Core cannot start. An acceptance receipt means the worker is ready, not that installation succeeded. `succeeded` requires matching Desktop and Core build hashes from authenticated health readback. `rolled-back` means the original bundle was restored and its health verified. `cancelled` means the new bundle was not installed. `failed` includes recovery errors; inspect the recorded backup and log before another attempt. Connection recovery and provider acceptance are separate checks. Terminal receipts replace the handoff instruction in `next` with the outcome and recovery action. Desktop shows cancellation, failure, or rollback after reconnecting, retains the reason in Settings, and offers a validated retry from the original candidate. A missing candidate is reported as a retry error. A cancelled receipt whose intended Desktop build is already installed does not show an obsolete failure alert.

After rollback to an older version, use `"$NEW_APP/Contents/Resources/bin/arc" cli app replace --status`.

## Local management contract

| Operation | HTTP route | Arguments |
| --- | --- | --- |
| `app.replace` | `POST /api/app/replace` | `{"body":{"path":"/absolute/candidate.app","check":false,"immediate":false}}` |
| `app.replace.snapshot` | `GET /api/app/replace/snapshot` | `{}` |
| `app.replace.status` | `GET /api/app/replace/status` | `{}` |
| `app.replace.ack` | `POST /api/app/replace/ack` | `{"body":{"id":"receipt UUID"}}` |

HTTP sends the contents of `body`, as with other local operations. CLI `call` and local management MCP use the complete argument object. CLI and local management MCP acknowledge only after flushing the response. A raw HTTP caller MUST read the replacement receipt before sending `app.replace.ack`. No acknowledgment within 60 seconds cancels without shutdown. A disconnected caller MUST read status before retrying. Unacknowledged and active jobs prevent duplicate replacements.

While waiting, `waiting` contains `blockingTurns` with `agent`, `taskId` (the Codex thread ID for Codex), `turnId`, `executionOwner`, and `reason`, plus `activeWrites`, `pendingInteractions`, `unknownActivity`, `ownershipError`, `observedAt`, and `idle`. `executionOwner` is `connector` or `unknown` for blockers. Unknown ownership reports `reason: "ownership-unknown"` and prevents shutdown. Missing activity reports `activity-unavailable` or `unknownActivity: true`. Unobserved turn IDs and Core counts are `null`; unknown Core counts also prevent shutdown. `cli app replace --status` returns this persisted snapshot without acknowledgment or other writes, including the last observation after a busy cancellation.

The receipt includes `replacementReceipt`, `id`, `state`, source/target/staged/backup paths, expected package hashes, original process IDs, timestamps, `statusPath`, `logPath`, and an actionable `next`. Errors add `error`. State progresses through `preparing`, `awaiting-receipt`, `waiting-for-turns`, `verifying`, `countdown`, `stopping`, `installing`, `starting`, and `succeeded`, or to `rolling-back` and a terminal failure/recovery result. Records live under `ARC_STATE_DIR/app-replacements`. `immediate` records the selected mode; `waitDeadline` bounds idle waiting, `restartAt` provides the actual countdown deadline, and `phaseStartedAt` identifies each phase. Other phases have no estimated completion time. Desktop shows active progress and terminal outcomes. The independent helper posts native phase notifications, including while Desktop is stopped; OS notification settings can suppress banners, and `notificationError` records delivery errors without aborting installation.

## Worker and validation

ARC submits a one-shot `RunAtLoad` job using `launchctl bootstrap gui/<uid>`. The worker is a copied native Core executable outside both app bundles. A launchd-owned supervisor starts it with `setsid` before exec, giving the worker a separate POSIX session and process group. launchd jobs alone can share session 1; the supervisor closes that remaining lifecycle boundary. Its input and logs are independent of ARC, Codex, the command executor, and MCP clients. This avoids the process-tree cleanup that defeats `nohup`, subshells, and background forks. The plist lives in the job directory, not `~/Library/LaunchAgents`; it is not a login item. The worker writes its terminal result before booting out its supervisor job. See [Apple's launchd lifecycle documentation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

Before executing candidate code, ARC verifies the bundle ID and signatures. Production bundles require the pinned local self-signed certificate used by `check:package`; ad-hoc production signatures are rejected. Dev bundles require valid signatures and the same Dev bundle ID. Isolated state admits only `com.whzxc.agent-remote-control.dev.acceptance-<instanceId>` matching its selected 8-32 character lowercase alphanumeric instance ID; ordinary state does not admit acceptance IDs. Production certificate checks remain unchanged. The candidate Core verifies its own version, Desktop/Core version agreement, packaged skill bytes against its compiled sources, native icon appearances and ICNS, absence of Node/npm runtime resources, and signatures of the bundle, Core, and screen helper. Links and special files are rejected. The package is ditto-copied to a unique sibling staging bundle and validated again before the receipt. The installed copy is validated again before launch. These are the native equivalents of `npm run check:package`; local Xcode tools including `assetutil` are required.

After acknowledgment in normal mode, the worker waits for three consecutive quiet samples, for up to five minutes. It completes package checks before starting a ten-second visible restart countdown. Immediate mode bypasses idle waits and the countdown, but still captures interrupted work and pending interactions. Only work ARC would interrupt is considered for the turn drain: Codex turns with `executionOwner: "connector"` and live non-Codex `arc-task` processes. Codex `executionOwner: "desktop"` and external `transcript` sessions do not block. Ownership comes from the existing task records used by the task UI and the activity source that distinguishes owned processes from transcript observations; titles and `origin` are not ownership evidence. Unknown ownership blocks and is identified in `waiting.blockingTurns`. A temporary Desktop/Core endpoint loss remains in the bounded waiting phase. If Desktop exits, the helper can relaunch the validated original package. It reconnects to restarted owners only when the Core and Desktop build hashes and installed bundle path still match the original package. Different running code cancels the handoff. Normal mode excludes exactly matched, eligible Codex continuations from turn blockers. Active writes, pending interactions, other agents and unknown ownership still block. Immediate mode is an explicit instruction to interrupt ARC-owned work through graceful application shutdown. In normal mode, Core active writes and pending interactions must be zero and missing observations fail closed. The helper reads `tasks`, `agents/activity` and `app.replace.snapshot`. An older Core without snapshot support can upgrade when idle; busy work cancels before shutdown with `REPLACE_SNAPSHOT_UNAVAILABLE`. Live activity supplies the current turn ID; older Core responses use the newest matching task receipt when available. The new Core holds new task dispatches and pauses durable queued sends while replacement is settling or later; defer releases admission until settling resumes. A first upgrade from an older Core cannot enforce that admission gate; the control source MUST keep dispatch paused during that handoff.

During preparation, the helper copies the old app into the private `ARC_STATE_DIR/app-replacements/backups/<id>` directory and verifies its signature and binary fingerprints. The receipt records `backupDirectory`, `backup`, and `backupReady`. No backup is created beside the installed app. Staging the new app still uses a unique sibling `.replacement-<id>.app` so the final move stays on one filesystem.

The worker requests `app quit`, waits for the captured Desktop and Core PIDs to exit, and acquires the Core lifecycle lock before changing files. Long-lived `arc stdio` and `cli mcp` forwarding processes are not owners and do not block replacement. `cli local-mcp` holds a Core lease; close that leased client first or replacement will cancel when Core cannot exit. The worker journals `backupMoved:true` before removing the old installed bundle, then renames the validated staging bundle into place. This field means the installation has been touched and backup recovery may be necessary. It verifies installed signatures and binary hashes, releases the lock, and relaunches with the same state directory. Success requires matching live Desktop and Core hashes.

On installation or startup failure, the worker stops the failed build, waits for process exit, copies it to `failed.app` in the private backup directory, restores the verified backup, and checks the old build after relaunch. Copies support a state directory on another filesystem. If graceful termination or recovery fails, the backup remains available and the receipt reports recovery failure. After verified success or rollback, ARC retains the last three receipt-owned backups for the same installed target. Rollback retains `failed.app` for diagnosis. Cancellation removes its unused backup. Failed restore preserves all recovery material. Failed recovery preserves its backup. Cleanup also removes authenticated legacy `<installed-app>.backup-*` sibling bundles after success or recovery. It never deletes another target's backups or active recovery copies. `backupCleanup` reports the retained path, removed directories and cleanup errors without rolling back a healthy app. Older temporary-directory receipts remain eligible for this cleanup. User data is never deleted or rolled back over newer data, and application rollback cannot undo a state migration.

## Limits

ARC-owned Codex app-server processes use parent-owned stdin/stdout RPC pipes, pending callbacks, and backend session identity. Keeping the child alive alone would not reconnect those channels. Core therefore retains its existing child shutdown behavior. Replacement resumes eligible ARC-owned Codex threads through native interrupted-task recovery. Neither mode migrates a running computation. Pending app-server callbacks cannot reconnect; immediate mode reports those threads without resending them. Codex Desktop owns its own process lifecycle.

Receipt flush proves delivery to the caller's transport, not that a human read it. The task drain protects writes and interactions; resumable ARC-owned Codex turns can be interrupted after their durable snapshot. In normal mode, other busy or unobservable work cancels installation. Immediate mode skips that wait while still requiring process exit before changing application files.

The user must have a logged-in macOS GUI launchd domain and permission to write beside the installed app. The helper does not request elevation. Logout, reboot, forced worker termination, disk failure, and incompatible user-state migrations are not transactional recovery guarantees. A nonterminal status after such an interruption requires checking its log, job, and backup before manual recovery. Do not run another installer or manually relaunch ARC during the handoff.

## Continue after recovery

ARC automatically records every live ARC-owned Codex turn before shutdown in both modes. `interruptedTurns` contains each thread/turn, configuration, original dispatch, notification binding, a stable resume request ID, state and reason. Core finalizes the snapshot before closing its pipes; `snapshotFinalized:false` requires attention. After verified new-package health, eligible entries call `codex_resume(threadId,turnId)` once, with no new user input. Native interrupted continuation retains the existing thread and origin notification scope. An explicitly supplied new-message continuation uses the original `codex_send(sendMode:queue)` contract instead of native resume for that thread, avoiding a duplicate; its approval and prior-turn failure rules remain unchanged.

Entry states include `recorded`, `needs-attention`, `finished-before-shutdown`, `submitting`, `receipt-returned`, `unconfirmed`, `explicit-continuation` and `not-sent`. Status readback adds `resumeReceipt` using the ordinary operation receipt reader. `receipt-returned` only confirms receipt delivery; inspect the original request ID for approval, rejection or submission outcomes. Public resume receipts expose `replacementContinuation` with the interrupted turn and original request IDs. The new turn retains the original source and notification destination.

Pending interactions cannot reconnect to a terminated app-server in P0. Immediate replacement records them as `needs-attention`; no message or answer is sent. Active or uncertain writes also require attention. A continuation cannot run against a newer predecessor or a turn that completed before shutdown. After uncertain submission, reconcile the original IDs; never generate a replacement request. See [restart resilience](../dev/restart-resilience.md) for component boundaries and later work.


Pass a continuation through stdin when preparing replacement:

```sh
printf '%s' '{"continuation":{"threadId":"<existing-thread>","prompt":"Continue the original task from its recorded state."}}' | arc cli app replace /absolute/Candidate.app --stdin
```

Use `--check --stdin` to validate the same input without installing or sending. Optional continuation fields are `model`, `turn` and `notify`, using the `codex_send` contract. ARC validates the existing thread before staging, records a generated continuation `requestId`, and queues the explicit message in that same thread only after the new Core and Desktop fingerprints pass the existing health check. Existing queue approval and prior-turn failure rules still apply; queue acceptance does not claim the next turn has begun or finished.

The replacing turn MUST end after receiving its replacement receipt. No control-source polling is needed to trigger the continuation. `cli app replace --status` exposes `continuationState`, the original `continuation.requestId`, and `continuationReceipt` or `continuationError`. If submission is uncertain, read that ID with `cli control receipt --stdin`; do not submit another message with a new ID. A worker crash after recording submission intent may require reconciliation through that receipt. Continuation failure does not roll back a healthy installation. Cancelled, failed and rolled-back replacements do not deliver an explicit new-message continuation. Eligible interrupted turns resume after verified rollback through the existing native continuation path.

A replacement launched through a control-source `command` records that source and its uniquely bound notification destination as `submitter`, independently of any Codex continuation. Both simple commands and native `command/exec` carry this attribution in `ARC_COMMAND_SUBMITTER`. It is attribution only and never grants control-source authority to the child. The existing source-scoped inbox records the outcome for that destination without waking the conversation. A source with only a registered target needs no Agent task: the update job supplies its own inbox binding. Multiple possible destinations remain unattributed to a conversation. Plain terminal CLI use needs no submitter and does not infer one from other task bindings.

## Unified control contract

`query({op:"update_status",args:{view:"compact"}})` returns only the current or latest job: `id`, `state`, `source` (including build identity), `work` group counts and task titles, `outcome`, `error`, and `next`. Each work group has `{count,titles}`; counts include non-task blockers such as active writes. `recent` contains at most three single-line summaries of earlier jobs, excluding the selected job. Use `view:"full"` for the unchanged detailed snapshot, work items, timing, notes, recovery paths, interrupted turns and last 20 outcomes. Detailed replacement journals remain available for receipt reconciliation and failed recovery.

`act({op:"update_request",args:{action:"submit",source:{kind:"local",path:"/absolute/Candidate.app"},when:"settled"}})` requires authenticated local administration. Optional `continuation` has the same contract as `app replace --stdin`. Release submission is Desktop-only. CLI control acknowledges a submit receipt only after flushing output. A raw local HTTP caller MUST acknowledge with `app.replace.ack` after reading its receipt.

For an existing job, use `action:"now"`, `action:"defer"` (optional `seconds`, default 3600), or `action:"cancel"`, with the observed `id` to reject a stale request. Commands are accepted before swap only; query status to confirm worker application. `when:"settled"` waits for writes, pending ARC interactions and unknown activity, then counts down ten seconds. `when:"now"` and `--now` bypass settling and report dropped interactions. `when:"defer"` postpones reevaluation by one hour. Desktop and externally owned turns and Desktop-owned interactions appear in `work.unaffected` and are never interrupted. Interaction ownership matches `codex_pending`, independently of dispatch ownership. Pending interactions from completed, failed or cancelled turns appear in `work.stale` and never block settling, including when automatic resumption is disabled. Eligible ARC Codex turns appear in `work.willResume`; other unsafe or unobservable activity remains in `work.blocking`.

Desktop uses `GET /api/updates/status` and `POST /api/updates/request`. Settings govern local-candidate admission, automatic Release timing, interrupted-turn resume and control-source scheduling. Package validation, receipt acknowledgment, matching owner identity, process exit, backup validation and health checks remain mandatory for every timing choice.

Proactive conversation wakeups are limited to four classes: task completion; task failure, including an interruption that ARC did not automatically resume; pending execution questions and approval requests; and SRC peer messages delivered by message_send. The push-binding verification code remains a separate channel handshake. Automatically resumed interruptions MUST NOT wake the conversation. Update and restart lifecycle notices, merged post-recovery resume notices, ordinary restart recovery, ownership handoffs, progress, stalls and all other lifecycle kinds MUST remain inbox/event-center only. A question or approval blocking update settling wakes once through the ordinary interaction path, with no separate update notice. Query update_status, board, messages or the owning task for recorded lifecycle state. Existing verification, source scope, subscription filters, buckets, breakers and mute rules apply. Delivery does not prove client reconnection.
