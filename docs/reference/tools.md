# MCP tools and operations

[Home](../../README.md) · [Concepts](../concepts.md) · [CLI](cli.md)

## Discovery and policy

The public MCP surface is frozen at three tools. Call `guide` first; use `guide({"op":"codex_create"})` for a single op’s full schema and example.

| Tool | Input | Annotation |
| --- | --- | --- |
| guide | `{topic?: "loop"\|"notify"\|"review"\|"approvals", op?: string}` | readOnlyHint=true |
| query | `{op: string, args: object}` | readOnlyHint=true |
| act | `{op: string, args: object, requestId?: string}` | readOnlyHint=false |

`args` is an open object at the MCP boundary and is validated against the current op schema on the server. `guide` defaults to topic=loop and returns the ingress-specific workflow, common examples, and an enabled op index. `op` takes precedence over topic. Each index row gives `op`, `via`, a short description, and a compact `signature` generated from its input schema. `?` marks optional fields; brackets show alternative required parameter groups. A single-op response also includes `inputSchema`, the full description, and a ready-to-call example. Replace example paths and IDs with actual values. Claude dispatch examples include notify; other sources use their currently available wait/inbox workflow.

If a session cached the older guide schema without `op`, call `query({"op":"guide","args":{"op":"codex_create"}})` instead. `query guide` accepts the same topic/op arguments and returns the same content. The three MCP tool parameter structures remain unchanged.

The embedded [catalog](../../native/src/catalog.json) defines the fixed tools and 49 ops. Names of the former tools remain op names, without tool aliases. The table below lists each op’s assigned entrypoint; mixed read/write ops such as receipt, screen, mcp, and codex_thread always use act, even for a read action. Assignment follows readOnlyHint, with connector_verify marked as a write because it saves verification state.

| Group | Ops via query | Ops via act |
| --- | --- | --- |
| Default (29) | `guide`, `dispatch_policy`, `projects`, `overview`, `tree`, `search`, `read`, `git`, `codex_tasks`, `codex_queue`, `codex_queue_control`, `codex_read`, `codex_wait`, `codex_items`, `codex_pending`, `control_output`, `codex_changes`, `logs` | `connector_verify`, `screen`, `command`, `codex_create`, `codex_send`, `codex_review`, `codex_interrupt`, `receipt`, `codex_respond`, `edit`, `write` |
| Advanced (12) | `codex_account`, `file_search`, `codex_capabilities`, `codex_schema`, `codex_query`, `codex_events` | `git_write`, `fs`, `process`, `mcp`, `codex_thread`, `codex_call` |
| Conditional default (12) | `agents`, `agent_capabilities`, `agent_tasks`, `agent_read`, `agent_context`, `agent_wait`, `agent_events`, `agent_pending` | `agent_create`, `agent_send`, `agent_interrupt`, `agent_respond` |

Default stores an explicit op allowlist; All enables the registry; Custom stores an exact selection. Read-only retains connector_verify through act as its connection-maintenance exception. Saving a selection includes necessary receipt, status, wait, and output dependencies. Existing allowlists retain their op names; guide is always available through both its fixed tool and the query op, even when absent from a saved allowlist.

`tools/list` always returns the same three definitions, including on an empty allowlist. Except for guide, disabled ops are omitted from guide and rejected with OP_UNAVAILABLE. Conditional ops require an available, enabled non-Codex Agent. Refresh local Agent discovery, then call guide again; no client tool refresh is needed for op changes. Saved allowlists do not grow automatically; reselect a preset to adopt new ops.

Every tool result carries `arcVersion`, a short SHA-256 of the embedded guide and catalog (not the application release version). Reread guide when it differs from the version last read. Object results gain this field; array, scalar, and null results are wrapped as `{value, arcVersion}`. Successful calls additionally attach arcInbox when unread events exist. Policy and availability are checked live; the catalog version does not change when a local policy changes.

INVALID_ARGUMENTS gives a field path, a short reason, a nearby supported parameter name when available, and a query guide call for the current schema. Error responses put error first in the text result, omit the full schema and inbox events, and do not consume unread inbox events. UNKNOWN_OP supplies up to three closest enabled op names and points to guide. WRONG_TOOL supplies the assigned entrypoint. These are MCP tool errors (`isError=true`) with arcVersion, so a client can correct the call once without refreshing its cached tools.

Upgrading from the former tool surface requires one client tool refresh and renewed authorization. Later capabilities change through ops and guide.

## Project facts and files

`projects` reads the native `project/list` pages. Project selectors accept a native ID, unique name, or absolute directory; a multi-root project requires a specific directory. ID/name resolution caches the catalog for 30 seconds. Absolute `read`, `tree`, and `search` paths can omit project; relative paths require it. Git revision reads require project.

`tree` and `search` normally use Git working files; `includeIgnored: true` includes ignored files. `read` can address ignored files directly. Text reads paginate by lines with `lineCount` or its alias `limit`; supplying both requires equal values. Search accepts positive limits above 50 and caps each page at 50 results. Tree/search use nextOffset. File results include metadata and hashes. `view: "review"` applies the workspace resource boundary. `includeSource: true` adds observation metadata where supported.

```text
query {"op":"read","args":{"path":"/absolute/project/README.md"}}
act {"op":"edit","args":{"path":"/absolute/project/file.txt","edits":[{"oldText":"before","newText":"after"}],"expectedHash":"<sha256>"}}
act {"op":"write","args":{"path":"/absolute/project/new.txt","content":"hello\n"}}
```

`edit` applies all replacements in memory before an atomic file replacement. Empty oldText, missing matches, or ambiguous matches without replaceAll fail the whole operation. `expectedHash` checks existing content. `write` creates parent directories and creates or replaces a UTF-8 file. Existing permissions are preserved by edit. Active-task notices do not block a write.

`git` reads status/history/diffs; `git_write` performs its cataloged mutations with receipts. `file_search` exposes fuzzy filename search. `fs` exposes native writes and watches with base64 contents and native path semantics; use the upstream schema for parameters.

## Codex tasks

```text
act {"op":"codex_create","args":{"project":"/absolute/project","prompt":"Read the project and summarize its structure."},"requestId":"<fresh UUID>"}
query {"op":"codex_wait","args":{"threadId":"<returned ID>","turnId":"<returned turn>","timeoutMs":30000}}
query {"op":"codex_read","args":{"threadId":"<returned ID>"}}
query {"op":"codex_changes","args":{"threadId":"<returned ID>","turnId":"<returned turn>"}}
```

Before dispatch, call `query({"op":"dispatch_policy","args":{}})`, optionally with `agent` to select one registered Agent. The result contains observedAt, global criteria and an agents array. Each row has agent and availability (installed, available, enabled and discovery observation time). Existing explicit ingress allowlists must enable this op; the default preset includes it. The Codex row returns compact native model IDs, supported efforts, defaultServiceTier and serviceTiers (native IDs, names and descriptions), the user policy, and current rate-limit pools/windows from the same native API as codex_account rateLimits/read. Unavailable reads are marked explicitly; quota is advisory. The state-directory dispatch-policy.json is created on first use as two-space-indented JSON with a final newline and reloaded on each query/dispatch. Preserve this formatting when restoring backups. Its top-level criteria guides Agent selection. Missing Agent sections are empty policies; native defaults apply when model/effort/options are absent. Existing files are not rewritten. Its codex object contains nullable model, effort and serviceTier, serviceTiers (model-ID overrides), criteria and optional allowModels/denyModels/allowEfforts/denyEfforts lists. Empty allow lists are unrestricted; deny lists win, including for defaults. Invalid policy files fail explicitly.

Other Agent rows include capabilities from existing session snapshots and quota from the same SubscriptionService used by the UI. Use both agent and taskId for a specific non-Codex session; otherwise the latest nonempty snapshot is selected. Sources and observation times distinguish persisted snapshots, live ACP snapshots and live Pi RPC reads. A null observation time means an older record did not capture it. Queries never start or resume sessions, or send RPCs to disabled Agents. With no snapshot, capabilities reports unavailable. The unfiltered query previews at most eight models per non-Codex Agent and reports omittedModels; filter by agent for its full catalog. Native model IDs, including encoded variants and grouped values, are preserved. Configuration evidence has session scope and does not prove the model used for inference. authentication.inference remains unknown; quotaAccess describes only access to each quota provider. Unintegrated providers and unknown model-to-quota associations are explicit. Non-Codex rows return selectionSupported:true, per-Agent policy and history. agent_create/agent_send accept model, options, reason and purpose; explicit choices override policy defaults, then native current values. The model is set first and options are read again before other setters and prompt submission. Configuration failures return promptSubmitted:false with confirmed session values. See [Agent dispatch and acceptance](agents.md#dispatch-policy-and-acceptance) for evidence levels and agent_review.

Pass model, effort and a short reason following the user criteria. Native collaboration settings take precedence over turn fields, then top-level convenience fields, then thread.model for creation, then policy defaults; ARC aligns the submitted thread and turn settings. Both dispatch ops retain reason and per-field source (explicit / policy-default; steer uses active-turn). Requests replay before policy selection. Queue defaults resolve at execution time. Each successful submission records requestId, turnId, configuration, reason, source and submittedAt in task metadata; full task listings expose dispatches, and terminal notifications include the turn's records. Terminal observations add observedDurationMs (submission to first terminal observation, not pure model runtime) and native persisted effectiveConfiguration when available. When turn_context lacks service_tier, effectiveConfiguration.serviceTier stays unknown. Its separate threadServiceTier snapshots the last persisted thread_settings_applied before task_started; this confirms thread settings, not a per-turn tier override. History uses native per-turn tier when available, otherwise submitted tier, otherwise unknown. Review verdicts are submitted with codex_review, described below. These op constraints do not restrict direct native API calls or Codex UI choices.

After reviewing a terminal turn, call `act({"op":"codex_review","args":{"threadId":"<thread>","turnId":"<turn>","verdict":"rework","note":"Acceptance failed"},"requestId":"<fresh UUID>"})`. verdict is pass or rework; note is optional. Omitting turnId selects the native thread's most recent terminal turn, skipping active turns. Only ARC-dispatched terminal turns can be reviewed. The per-turn review contains verdict, note, reviewedAt and requestId; the latest write replaces the previous verdict. Replay the same requestId for retries; use a new one to change a verdict. After rework, the next new-turn dispatch in that thread records reworkOf pointing to the reviewed turn; steer does not consume the link. Later verdict changes do not rewrite existing links. Queued sends link at execution time. Full task listings expose current reviews; completion events remain snapshots. Existing explicit ingress allowlists must enable codex_review.

The Codex row's `history` in `dispatch_policy.agents` aggregates new turns submitted in the last 30 days by effective model/effort/serviceTier (submitted values if native evidence is unavailable). Each group returns dispatches, pass, rework, failed, interrupted and unreviewed. Failed/interrupted turns are counted separately, ahead of verdicts; active and unreviewed successful turns count as unreviewed. medianObservedDurationMs and durationSamples only use successful terminal observations. Same-turn duplicates and steer do not count as new dispatches. purpose:self-test is excluded; sends without purpose inherit the previous dispatch's purpose. Empty groups are omitted. At most 12 groups are returned, ordered by dispatch count, with omittedGroups when truncated. Reviews are read fresh on each query.

Current native Turn/turn-completed/history data has no complete per-turn token total. thread/tokenUsage/updated includes turnId but last is the latest model response and total is thread-cumulative; account/usage/read reports estimated thread usage. ARC does not use these as per-turn totals or compute differences. Per-turn tokens and their average remain absent, not zero, until directly attributable complete native usage is available.

`codex_create` accepts prompt or native input; input takes precedence. `thread` and `turn` forward native parameters. Explicit native parameters take precedence over convenience fields. Omitted model and effort independently use ARC defaults from dispatch-policy.json (initially gpt-6-astra / medium), including new turns sent to existing threads. Omitted serviceTier uses the final model’s serviceTiers override, then global serviceTier; null/absent defaults inherit native settings. Factory defaults have no tier preference. Fast uses priority, standard speed uses default; fast is a catalog speed label. Explicit tier wins: turn.serviceTierForTurn, turn.serviceTier, top-level serviceTier, thread.serviceTier. A serviceTierForTurn override does not change thread defaults. Each new turn reselects policy tier, including model switches. Tier source is explicit, policy-default or native-default; active steer retains active-turn configuration. Permissions and approval policy inherit native host/task settings. `mode` presets are read-only, workspace-write, or danger-full-access; the first two default networkAccess to false when selected explicitly. networkAccess alone requires a complete permission policy.

`codex_send` continues the existing owner. Active-turn steering changes input only; explicitly requesting different model/effort returns ACTIVE_TURN_CONFIGURATION. Wait for the active turn or queue a new one to change settings. An unloaded Desktop thread is opened and its owner awaited before sending. Only if that load still explicitly reports no owner does ARC resume the same thread in its own App Server; disconnects, timeouts and uncertain turn submissions never trigger another submission. Desktop resume loads the thread but does not apply App Server configuration overrides. Unsupported thread/turn extensions are rejected. Background sends resume a notLoaded session with metadata only before starting a new turn. Desktop creation sets a title to materialize the seed, then confirms persistence through an independent metadata reader; it never polls rollout file size or hydrates full history. An omitted title uses the first nonempty prompt line with leading Markdown heading, quote or list markers stripped, capped at 120 characters (ARC task when there is no text). Seed failures archive on the creating App Server before it exits; later definite creation failures archive only when the turn list is confirmed empty. MCP receipts expose `failureStage` and `cleanup`, including any archive error; stored local receipts also retain `seedTimings` in milliseconds. Unknown submissions remain available for inspection. Reads and waits do not resume execution. `executionOwner` is `desktop` or `connector`; Linux uses the latter.


Send receipts include `dispatchMode: "steered" | "new-turn" | "queued"`. The default `sendMode:"auto"` preserves steering. `sendMode:"queue"` accepts a durable FIFO message and returns `queueId`; receipt completion means queue acceptance, not execution. Query `codex_queue({threadId?,queueId?})` for up to 100 newest entries and the total; dispatch remains oldest first per thread. Entries expose `queued`, `blocked`, `dispatching`, `sent`, `failed`, or `cancelled`, with a short preview and the dispatch request/turn IDs. Queue operations are ingress-scoped. Older explicit tool allowlists must enable the new ops.

```json
{"op":"codex_send","args":{"threadId":"<thread>","prompt":"Next step","sendMode":"queue"}}
{"op":"codex_queue","args":{"threadId":"<thread>"}}
{"op":"codex_queue_control","args":{"threadId":"<thread>","queueId":"<queue UUID>","action":"cancel"}}
{"op":"codex_queue_control","args":{"threadId":"<thread>","action":"resume"}}
```

An active turn or unanswered interaction keeps the queue waiting. A failed/interrupted predecessor pauses the queue. Capacity recovery takes priority; a successful retry lets the queue continue. `resume` explicitly accepts the failed predecessor; omit queueId to resume/cancel all undispatched entries in that thread. Already-submitting messages cannot be recalled. ARC rechecks the previous turn immediately before starting; a concurrent thread change or uncertain submission becomes a failed queue entry for inspection, never a steer or blind replay. Queue entries and dispatch reservations survive restart.

Automatic capacity continuation uses the same thread and confirmed model, preserving history and asking the Agent to verify previous work before continuing. It never resends the original task input or replays stored tool calls. It is restricted to native `codexErrorInfo:"serverOverloaded"` failures whose complete failed-turn history contains only user messages, Agent messages or reasoning. Any tool activity, unknown history/model, other error or uncertain write excludes automatic recovery. This conservative check does not promise exactly-once external effects; ambiguous effects require review. Intermediate failures are withheld from notifications; exhaustion emits one failed event with the retry count. Read/wait results include retry status, deadline and successorTurnId when applicable. `task-settings.codexRetryMaxAttempts` defaults to 3 (0 disables, range 0–10); `codexRetryInitialSeconds` defaults to 30 (1–3600). Delays double per attempt and cap at one hour. Existing terminal failures are not retried retroactively.

For validation tasks use `purpose:"self-test"`, which defaults to `notify:null`. Explicit `notify:null` is also recommended. Never copy the orchestrator's target into a self-test; an explicitly supplied destination must be a dedicated test target.

codex_tasks defaults to view:compact: title, threadId, project, status, updatedAt (Unix seconds), currentTurn and model/modelSource, without prompt previews. view:full preserves the previous fields and full native preview, with the same status enrichment and per-request dispatches history. Pagination and filters are unchanged. Reads never resume tasks; live enrichment has an eight-second page budget. status is running, idle, needs-input, failed, retrying, queued or unconfirmed with a specific statusReason. Priority is needs-input, retrying, running, failed, queued, idle; queue counts remain visible alongside an active/failed state. Persisted-only, contradictory or unavailable runtime evidence stays unconfirmed; currentTurn is the latest observed turn, not proof it is running; source:persisted-history retains history evidence if live checks fail. Missing models are null with modelSource:not-reported-by-owner. Existing consumers needing preview/configuration/actions must explicitly request view:full.

`codex_changes` compares the current worktree with the HEAD/dirty baseline captured before the turn. It includes current untracked files and pre-existing dirty changes. It returns reachable new commits and file statistics; path selects a paged diff. Missing historical baselines use fallback=true with recent commits and the current diff. The result is a live workspace comparison, not a frozen task-only snapshot.

Codex completed notifications also include a persisted change summary captured when completion is observed (five-second collection budget): up to five commits, eight-character hashes, titles limited to 120 characters, and file/addition/deletion/binary statistics. It compares the workspace against the turn baseline; other tasks and pre-existing dirty files may be included, so attribution is never exclusive. Missing baselines show current-workspace statistics without labeling recent commits as this turn's commits. Truncation, missing baselines or collection failure include a codex_changes query with exact threadId/turnId; that query is live and paginated, not the original frozen summary. Delivery retries reuse the saved summary. An answered asynchronous question's original turn does not emit an empty completed event; a substantive result or the continuation still emits normally. Other completion events are retained.

## Receipts and interactions

Ops that support receipts accept a UUID requestId, generated when omitted. Supply it at act’s outer level or in args; the outer value takes precedence. For receipt it identifies the original operation. Ops without a requestId property (including connector_verify and screen) reject it; omit it for those ops. Retain it for retries: the same ID and arguments return the original receipt; changed arguments conflict. The default dispatch wait is 25 seconds, adjustable with waitMs from 0 to 120000. A longer dispatch returns pending. `receipt` reads the original operation or applies approve/bypass/reject to a pending ARC task approval.

Receipt completion describes the operation; task completion comes from read/wait. An unconfirmed outcome needs readback using the original request/task IDs. Do not resend it with a new ID.

`codex_pending({threadId?})` returns native requests and unanswered Desktop questions with `respondToken`, `respondTokenExpiresAt` (Unix seconds), `responseId`, `backendSession`, `method`, `params`, `canRespond` and `next`. Specifying a thread refreshes its Desktop state. Prefer `codex_respond({respondToken,result})`; legacy `{id:responseId,backendSession,result}` remains supported. Tokens bind to one ingress, thread, turn and interaction; they expire after 24 hours and are consumed after a successful answer. An optional threadId assertion rejects a mismatched thread. Do not combine a token with legacy id/backendSession. Refresh pending after expiry. Persisted Desktop tokens survive ARC restart after fresh owner validation; native app-server callbacks remain session-bound. Desktop asynchronous questions use `result: {answer: "option or free text"}`; command/file approvals use `result: {decision: "accept" | "decline" | "cancel"}`. Permissions, synchronous user input and MCP elicitation use their native response schemas (`codex_schema`, `direction: "server"`). ARC-owned app-server requests accept exactly one of result/error. Desktop responses require result and are confirmed by owner readback. Requests with `canRespond: false`, including user verification and unsupported pickers, require Desktop. Saved Desktop notification callbacks are revalidated against the live owner after restart; otherwise refresh pending for the current backendSession; answered requests disappear. An unconfirmed response must be inspected before retrying. ARC task approval is separate from Codex command permissions.

Dispatch receipts include only deliveries queued since that operation began; explicit read/wait calls retain the full turn notification history.

## Waiting

Use `codex_wait` or `agent_wait` after dispatch. Both default to 30000 ms and return on a terminal state or required interaction. `codex_wait` permits 1–90000 ms; non-Codex `agent_wait` permits 1–300000 ms. Prefer 20–30-second slices for remote clients.

After timeout, keep the same task/thread and turn IDs and pass the previous snapshotHash as expectedHash. It controls changed reporting, not whether a terminal result is returned. Cancellation/disconnection of a wait ends that wait, not the task. Results distinguish completed, failed, cancelled, interaction-required, timeout, and unconfirmed. Read finalResponse and the observation timestamps.

## Control-source notifications

`codex_create` and `codex_send` accept `notify: {channel: "claude-session", target: "…"}`. The target is a `session_…` / `cse_…` cloud ID or `claude.ai/code/<id>` URL. `agent_create` and `agent_send` accept the same binding. ChatGPT Work uses independent MCP Events subscriptions; no per-turn notify target is needed. Ordinary Chat cannot be proactively woken; use segmented waits and the inbox. Omission retains a same-turn binding; null unbinds. New turns should bind explicitly. A native Codex retry immediately after a failed/interrupted ARC turn inherits the binding only without an explicit binding/unbinding record. Both start and detection must be within ten minutes of the native terminal timestamp. ARC requires a persisted capacity_retry_automatic, capacity_retry_manual or resume_interrupted_task trigger, no new user message in history or the owner snapshot, and persisted turn configuration. Missing/unknown evidence and Desktop user-authored turns do not inherit. Accepted retries are recorded as dispatchSource:native-retry with retryOf, nativeTrigger and native model/effort/serviceTier; they retain purpose, support codex_review and enter history. Their stable record requestId is the native turn ID, not a replayable ARC request receipt. In-flight ARC retries first resolve their existing receipt. Once adopted, a retry is observed to completion even past the window.

ARC observes completion, failure, cancellation, and requests for input/approval. It calls the installed Claude CLI with `-p <fixed message> --cloud <session> --output-format json`. Delivery succeeds only for `ok: true` and the matching session_id. Pending and interrupted deliveries survive restart. Failed or uncertain sends retry with the same eventId, with exponential backoff starting at ten seconds and capped at five minutes; consumers deduplicate eventId. Read `notification` (channel, target, deliveries with eventId, kind, level, state and error) on the task; a binding failure marks the receipt bind-failed without failing an already-dispatched task. ARC escalates breaker and sustained token-starvation episodes through a local system notification. See the [workflow guide](../guides/claude.md).

`guide` is always available with topics `loop` (default), `notify`, `review` and `approvals`. It follows the ingress control source and app locale. Dispatch without explicit permission parameters unless the user requests them in the current conversation.

Registered turns produce fixed `completed`, `failed`, `interrupted` or `needs-input` events. Tool results on the originating ingress carry `arcInbox` when unread events exist (at most five listed, fifty retained per ingress). A successful `codex_read`, `codex_wait`, `codex_items`, `codex_changes`, `agent_read` or `agent_wait` marks the returned turn's existing events read. Unconfirmed waits do not acknowledge events. Array/scalar results always use `{value, arcVersion}`, with arcInbox when present.

All events use one scheduling path and token bucket per channel and target. Claude ordinary events merge for 30 seconds; needs-input and approval notifications bypass only this window. MCP callbacks send one event per request without this window. Each batch containing new events costs one token. Failed or unconfirmed retries reuse event IDs and cost no additional token; their backoff is 10, 20, 40, 80, then 160 seconds, with at most six attempts. Empty buckets retain and combine queued events until refill, with a merged-count line in the message. Claude-session notifications use plain event blocks with full IDs. `respond={op,args}` supplies the callback; add the required `result` and call act directly. Async questions use `{answer:"..."}`; synchronous multi-question requests require one combined `answers` map with every question ID. Approval content and available decisions are preserved. Only stale or missing callbacks require a pending query. Saved Desktop callbacks for the current ingress can survive an ARC restart; the live owner revalidates the exact request before responding. App-server callbacks remain session-bound. Completed events include the last message verbatim, capped at 2000 Unicode characters; `truncated=yes` includes a full-text query. Failed/interrupted events include the original error when supplied by the owner. No task state or result is inferred from the notification delivery status.

For Claude ingresses, events bound to claude-session are attached in `arcInbox` only once, and successfully delivered events are omitted, including existing records. Attachment is separate from read status. ChatGPT, other ingresses and unbound events retain their existing unread reminders. `act({op:"notification_ack",args:{eventIds:["..."]}})` marks selected events read; `args:{all:true}` marks the current ingress inbox read. The result distinguishes `markedRead` (new acknowledgements), `alreadyRead` (previously read, delivered, digested or resolved), and `notFound` plus `notFoundEventIds`; repeated IDs are counted once. Delivery is treated as consumed for acknowledgement even when its inbox row has aged out. This ingress-scoped, idempotent operation is always available and never answers or cancels a task. Reading the corresponding turn also marks its existing events read. No events means no `arcInbox` field.

Desktop IPC state changes wake observation, with a two-second fallback refresh. Deliveries survive restart; resolved interactions are not sent again. The bucket defaults to ten tokens and refills one every sixty seconds. `task-settings.notificationBucketCapacity` (1–1000) and `notificationRefillSeconds` (1–86400) configure it; `notificationsEnabled` remains the master switch. The removed `notificationWakeLimit` is migrated once: the old default becomes capacity 10, a custom positive value becomes capacity (capped at 1000), and zero disables the existing master switch. The old key is removed and rejected on subsequent writes. The refill default is always 60 seconds. Existing attempted deliveries retain retry credit; recent recorded batches remain visible without becoming new bucket debt.

A factual health line appears only when remaining tokens are at most 20% of capacity (threshold at least one token), or after throttling: this turn's question or approval count, send attempts to the target during the preceding ten minutes (including retries), the remaining tokens, and the triggering operation/time when known. `causedBy` records the dispatch op, time and requestId on the binding. Missing provenance is omitted, never reconstructed by guessing. Inbox events carry their current `target`. A different target is labeled only when the current call supplies a known `notify.target`; otherwise `bindingNotice` asks the receiver to check ownership. An ingress may be shared by multiple Claude sessions; its identity alone does not identify the calling session.

`query notify_status({target?,threadId?,all?})` returns ingress-scoped target buckets, pending/sending events, batch kind counts over the preceding hour, thread wake rankings, thread/turn bindings, and the last successful delivery or acknowledgement time. By default, targets are included only when they have batches in the last hour, pending/sending events, an enabled breaker, non-null emptySince, or escalated state. Threads are included only with last-hour delivery attempts, pending/sending events, or a non-normal mode; each includes only its latest turn with causedBy. `all:true` returns all records and historical turns. Supplying target or threadId also disables omission within that scope. `summary` contains scope totals `totalTargets`, `totalThreads`, `totalBindings`, and `hidden` counts for targets, threads and bindings (omitted turn records). All status timestamps are Unix seconds except the nested delivery `timing` fields, which use milliseconds. Older records without exact completion or acknowledgement times return null. `notify_status` is always available. `notify_control` is a normal write op in the common preset; existing custom policies must explicitly enable it.

```json
{"op":"notify_control","args":{"action":"mute","threadId":"<thread>","until":"2026-12-01T10:00:00Z"}}
{"op":"notify_control","args":{"action":"mute","threadId":"<thread>","mode":"digest"}}
{"op":"notify_control","args":{"action":"unmute","threadId":"<thread>"}}
{"op":"notify_control","args":{"action":"rebind","threadId":"<thread>","target":"<session>"}}
{"op":"notify_control","args":{"action":"rebind","threadId":"<thread>","target":null}}
{"op":"notify_control","args":{"action":"breaker","target":"<session>","enabled":true}}
```

Controls persist across restart and apply to future turns of the thread. Mute retains events without waking the target. Digest sends hourly count summaries for Claude, or releases individual MCP events at the hourly window, and keeps the original events in the inbox; those summaries use tokens too. Expiry or unmute resumes normal delivery. Rebind updates the thread's pending Claude events and future binding; null unbinds it. Rebind back to the previous target to undo it. Breaker blocks target wakes until set to false. These operations never answer, cancel or recreate an Agent task. A send already started cannot be recalled.

When health counts look unusual, inspect `notify_status` first. If the Agent is looping, use `codex_send` to ask it to combine questions or decide within its existing authority. Use mute, rebind or breaker as appropriate. If unresolved, involve the user. ARC attempts one local system notification when a breaker is enabled, or when a bucket remains empty with queued events for `notificationEscalationSeconds` (default 900; configurable 1–86400). The notification includes the target, threads and count. Recovery resets the episode. An unavailable desktop or missing system-notification permission is recorded as `escalationError`; an attempted notification does not prove the user saw it. Individual send failures are recorded and retried, without separate system-notification spam on each retry.

Each delivery exposes `timing`: `queuedAt`, `startedAt` and `finishedAt` are Unix milliseconds; `queueMs` measures elapsed time from event creation to the latest attempt (including earlier retries), and `sendMs` measures that attempt. `queueReason` retains the last blocking reason: `batch-window`, `token-wait`, `disabled`, `retry-backoff`, `muted`, `digest-wait` or `breaker`; unsupported or unbound targets record their own reason. Local logs contain timing and identifiers without message content. Missing timestamps on older records are unknown. These times do not measure receiver display. Unfinished tasks and pending deliveries are retained; finished records expire after seven days.

## Host and native operations

| Op | Operations |
| --- | --- |
| command | Simple cmd/cwd execution, or native exec/write/terminate/resize |
| process | spawn, writeStdin, kill, resizePty |
| fs | writeFile, createDirectory, remove, copy, watch, unwatch |
| mcp | list, resource/read, tool/call, oauth/login, event/stream/start/stop |
| codex_account | read, usage/read, rateLimits/read, workspaceMessages/read |
| codex_schema | Native domain/method schema discovery |
| codex_query / codex_call | Native read/mutation methods subject to task ownership |
| screen | macOS window capture and accessibility operations; OS permissions apply |

Simple `act {"op":"command","args":{"cmd":"git status --short","cwd":"/absolute/project","timeoutMs":10000}}` uses the user's shell and returns stdout, stderr, exitCode, and durationMs. It defaults to a 60-second execution timeout. Optional `waitMs` (0–120000) bounds only the wait for the receipt and can return `pending`; continue with `receipt` and the returned requestId. Without waitMs, the simple form waits for the execution timeout plus ten seconds. Simple fields and action/params are mutually exclusive. Native command/exec uses the upstream sandbox/permission policy; process/spawn runs directly on the host outside the Codex sandbox. Neither creates a thread.

Native handles for processes, watches, and MCP subscriptions belong to the current App Server connection. MCP tool/call and event/stream/start require an existing threadId. Consult codex_schema before using native parameters; top-level RPC timeoutMs is separate from params.timeoutMs.

## Output, events, and logs

Large JSON results over 64 KiB are stored as snapshots with outputId and nextOffset. `control_output` reads up to 65536 UTF-16 code units per page; join all text pages before parsing JSON. Snapshots expire after one hour and share a 64 MiB quota. Expired reads return OUTPUT_EXPIRED; oversized/unallocatable snapshots return OUTPUT_STORAGE_LIMIT.

Codex events keep a bounded memory window of 2000 entries or 8 MiB. gap/reset reports loss or restart. Native task history remains readable on demand. Pi/ACP events additionally have durable archives; see [Agents](agents.md). `codex_items` reads original task items, including tool output. `codex_read` can include local images with includeImages and maxImages.

`logs` reads retained Core and connected App Server stderr logs newest first. since uses RFC3339, level is exact, grep is a fixed string, and cursor continues a page. Retention is seven days and 16 MiB; an expired cursor reports gap.

## Review views and task context

For overview/tree/search/read/git, explicit `view: "review"` resolves the real workspace boundary and excludes paths outside it and ARC's own runtime state. In-root symlinks remain readable; Git renames check both paths. Default reads follow host permissions without content-based filtering.

With includeSource, coverage records pagination, filtering, and skipped items. A non-null read.nextLine requires another page even if truncated is false. Search snippets cap per-file matches/characters; matchesComplete reports their completeness. Use read for the full text. tree/search can pass listingHash as expectedHash; read uses sha256. A changed hash requires restarting pagination. A listing hash does not freeze file contents.

`query {"op":"agent_context","args":{"agent":"pi","taskId":"<existing ID>","view":"handoff"}}` reads an existing non-Codex task plus current project facts. Optional project must match the task workspace or TASK_WORKSPACE_MISMATCH is returned. Missing evidence is partial. Policy checks include agent_read and git; readNext recommends allowed ops with via/op/args. Codex review uses codex_read/items/changes directly.

## Git mutations

`git` and `git_write` accept `action` as an alias for `operation`; supplying both requires equal values. Aliases normalize before receipt hashing, so retrying with the other spelling retains the same receipt. `git_write` uses project, operation/action, and an optional UUID requestId:

| Operation | Input / scope |
| --- | --- |
| add / unstage | Nonempty literal relative paths or all=true, exclusively; unstage changes only the index |
| commit | Required message; commits the current index, without amend |
| branch | Required branch; creates a local branch from HEAD |
| switch | Existing local branch, or create=true to create and switch |
| stash_push | Tracked changes only; optional message |
| stash_pop | Latest stash; Git preserves stash/conflict state on failure |

Branch, commit, and stash operate on the repository. There is no fetch/pull/push, branch deletion, history rewrite, hard reset, or clean operation. Git writes run under host permissions, outside task-creation approval. Use receipt and git readback after failure or an uncertain result.

Commit/stash identity comes from repository/global user.name and user.email, including include/includeIf; missing identity fails. Process GIT_AUTHOR/GIT_COMMITTER overrides are not used. Hooks, fsmonitor, external diff, configured filters, signing, automatic maintenance, and recursive submodule operations are disabled. Files requiring filters such as LFS are not converted automatically. stash_pop disables rerere and rejects external merge drivers. Commands use a 12-second timeout and 16 MiB per output stream.

## Images and item pagination

read detects PNG/JPEG/WebP/GIF by signature and returns MCP image blocks with source, original/returned dimensions, byte counts, hashes, and reencoded. maxEdge defaults to 1568 (1–4096); quality defaults to 80 (1–100). Originals within the pixel and 1 MiB byte limits pass through. Re-encoding uses JPEG for JPEG/opaque WebP, PNG otherwise; animation reduces to the first frame. A smaller original may be retained within the byte cap and less than 10% above maxEdge. Input reads retain the 16 MiB file limit.

codex_read and codex_items accept includeImages=false and maxImages=4 (1–8). Local Markdown images must resolve inside the task project or its own CODEX_HOME/visualizations/YYYY/MM/DD/threadId directory; symlinks cannot escape. Embedded data-URL tool screenshots are supported. An unavailable image adds an explanation while preserving the text result.

codex_items defaults to original oldest-first order. latest=true selects the newest turn and reads newest first; explicit turnId pins a specific turn. Continue with that turnId, nextCursor as cursor, and latest=true. A cursor with latest=true but no turnId is rejected.

## macOS screen operations

Core invokes the bundled arc-screen Swift helper directly. Grant ARC Screen Recording and Accessibility in macOS settings when requested. Except for windows, select app (name substring), bundleId (exact), title (substring), or windowId; combined filters all apply. Refine ambiguous targets.

| Action | Result |
| --- | --- |
| windows | IDs, app/bundle/PID, titles, frames, visibility and foreground state |
| capture | Window image and metadata; maxEdge/quality follow image preparation |
| tree | Accessibility refs, roles, labels, frames; text=true includes static text; default 300, maximum 1000 entries |
| press | AXPress by ref or label substring; nth is zero-based; visible center-click fallback when foreground use permits |
| show | AXScrollToVisible for the selected element |
| raise | Explicitly activate the app and raise its window |
| key | Escape/Return/Tab/arrows, letters/digits, or combinations such as cmd+k |

Read a fresh tree after structural changes; refs are window-scoped structural paths. front=auto temporarily activates/restores an inactive target only after 60 seconds without user input. Otherwise capture may report possiblyStale and foreground-dependent input returns FOREGROUND_REQUIRED. never avoids activation; always activates and leaves the target in front. raise is an explicit foreground action.

press/show/raise/key can add `after: {"waitMs":200,"capture":true}` or a capture options object. Maximum wait is 10000 ms. Operation, wait, and capture share one Core lock even if the caller disconnects. If the action succeeds but capture fails, performed=true and captureError preserve the outcome; inspect before repeating the action. performed confirms input submission, so verify the visible result.

## Limits

Op allowlists do not isolate users/tasks or change OS permissions. Native method availability, login, and Agent capabilities come from the actual host. Screen operations are macOS-only; Linux has no Desktop actions. Event buffers are not durable task history; consume pagination before its retention expires.

## macOS permissions

| Ops | Permission / execution owner |
| --- | --- |
| screen tree, press, show, key, raise | Accessibility / arc-screen |
| screen capture, windows titles | Screen recording / arc-screen |
| read, tree, search, edit, write, git | Full Disk Access for protected locations / Core |
| command | Full Disk Access when cwd is protected / Codex app-server execution host |
| Closed-loop notification fallback | Notifications / ARC Desktop |

Missing screen permission returns `PERMISSION_REQUIRED`, `permissionId` and local settings guidance without prompting. File protection uses an FDA heuristic; unknown is not granted. command requires a successful executor FDA probe only when cwd is in a protected location. Screen-recording grants may require reopening ARC.

For the bundled Desktop launch chain, grant Full Disk Access to ARC App: Core and its Codex app-server children inherit that responsible application. A standalone Core launched by a terminal can instead inherit that terminal's identity; its probe does not prove the App is ready.

Paths referenced in command arguments are not inspected; enabling Full Disk Access can prevent permission dialogs during calls.

## MCP Events

The same authenticated endpoint supports `server/discover` for MCP 2.0 (`2026-07-28`), advertising `tools` and `events`. Legacy `initialize` retains the requested supported 2024/2025 protocol and tools-only capabilities. The three tool schemas are unchanged.

`events/list` exposes exactly one frozen event, `notification`, with frozen subscription arguments `{op, args}`. `guide` (topic `notify`) returns the event op catalog and argument schemas. Currently only `op: "task_status"` is supported; its `args` accepts optional nonempty string `threadId` and `taskId` filters (both must match if supplied). Empty `args` means all tasks dispatched through this ingress. Unknown ops and invalid arguments return JSON-RPC -32602 with a correction contract and guide reference. Kinds are `completed`, `failed`, `interrupted`, and `needs-input`. Payload data contains op, kind, summary, project, title, agent, threadId, taskId, turnId and query. The signed envelope contains eventId, name, timezone-qualified timestamp and cursor:null.

`events/subscribe` accepts name, arguments, delivery:{mode:"webhook",url,secret}, optional ttlMs and cursor:null. Identity includes authenticated principal, ingress, URL, name and canonical arguments. Default and maximum TTL are 24 hours; positive ttlMs grants no more than requested, and null receives the finite default. Successful responses contain id, refreshBefore, cursor:null and truncated:false. Refresh rotates secrets with a five-minute dual-signature window. No historical replay is available.

Callbacks require HTTPS, public destination addresses at connection time, no redirects, and a `whsec_` signing key decoding to 24–64 bytes. Signed verification must return 2xx with the matching challenge. Failures return -32015 with data.reason. Successful verification is cached for at most five minutes for the same principal, callback and key.

`events/unsubscribe` accepts the original name, arguments and delivery:{mode:"webhook",url}; it is idempotent. Expiration, ingress revocation or OAuth grant removal stops delivery. Only the owning principal can refresh or cancel a subscription. The notification master switch and thread mute apply; digest releases pending individual events at the thread’s hourly digest window, since each callback carries one event. `notify_control` breaker accepts an owned subscription ID; rebind applies only to Claude session bindings.

Events use the existing persisted channel/target token bucket. Each event pays once; transient failures retry with 10/20/40/80/160-second backoff, at most six attempts. 410 removes the subscription; 410/413 are never retried. Bodies are limited to 256 KiB. `notify_status` exposes unified `subscriptions`, `targets` and `deliveries` for Claude and MCP without callback URLs or keys. `callback-accepted` means HTTP receipt only, never model processing. Inbox read state is independent.

Claude notify bindings and MCP Events share the subscription model (target, channel, op and args), subscriptionId/eventId deduplication, token buckets, retry scheduler and delivery records. `notify_control` also accepts `subscriptionId` with `mute`/`unmute` (optional `until` on mute). Thread controls affect both channels; rebind only changes Claude destinations. A one-time migration retains Claude bindings, governance and delivery history, invalidates retired event subscriptions, and deletes the former storage. Recreate Work subscriptions with `notification` and `{op:"task_status",args:{}}`.

Work callbacks are asynchronous: a measured delivery took about 1.2 seconds, followed by roughly five minutes before model processing. No latency adjustment is exposed in the official tool or current task editor; users can manually choose Run now. Use this channel for long tasks, and segmented waits for tight loops.
