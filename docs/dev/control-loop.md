# Control-source loop: notifications and usage

## Responsibility

Both loop directions matter. Control sources dispatch, continue, and answer interactions through codex_*/agent_* ops. ARC wakes supported sources on completion or input requests and supplies predictable fallback elsewhere. ChatGPT Work uses official MCP Events. Ordinary Chat has no proactive wakeup.

The fixed guide/query/act surface exposes source-specific dispatch, waiting, review, and new-turn guidance plus live op contracts. MCP instructions point to guide. ARC owns events and source guidance. Adapters own delivery. Users own decisions.

## Constraints

Reuse claude_notify.rs and per-turn delivery records as a thin layer. Do not build a generic event bus, pluggable channel registry, retry framework, or workflow engine. Channels are a small fixed enum. Derive state from task records where possible. Persist bindings, delivery records, inbox read positions, and MCP subscriptions in small state files or existing storage. The separate bounded coordination journal projects metadata through query events; task inboxes remain source-scoped delivery records, not a global bus. The journal does not introduce a new delivery stack. Addressed coordination messages use a separate bounded metadata owner store and the existing notification governance through one additive adapter. Push coalesces into counts and query pointers; it never forwards peer summaries into prompts or task actions. Task inboxes remain source-scoped, and Work callbacks do not imply private conversation addressing. See [Coordination](coordination.md#addressed-messages).

Retain ingress authorization. Webhooks validate HTTPS, public addresses, signatures, and challenges according to the official protocol. Execution Agents MUST NOT own notification delivery. Never append notification steps to task prompts. Failure, interruption, or approvals may prevent those steps, and they pollute the task.

Retries retain eventId for receiver deduplication. Callback receipt and model processing are separate. Use notify and notification directly without old aliases. Existing Claude state migrates once into notifications/ and old files are removed after success. Existing tests may be migrated without expanded unit coverage. Acceptance scripts are allowed by repository conventions.

## 1. Event model

| kind | Trigger |
| --- | --- |
| completed | Bound turn completed normally. |
| failed | Bound turn failed. |
| interrupted | Bound turn was interrupted and ARC did not automatically resume it. |
| needs-input | Approval or user input is pending. |

Proactive conversation wakeups are limited to four classes: task completion; task failure, including an interruption that ARC did not automatically resume; pending execution questions and approval requests; and SRC peer messages delivered by message_send. The push-binding verification code remains a separate channel handshake. Automatically resumed interruptions MUST NOT wake the conversation. Update and restart lifecycle notices, merged post-recovery resume notices, ordinary restart recovery, ownership handoffs, progress, stalls and all other lifecycle kinds MUST remain inbox/event-center only. A question or approval blocking update settling wakes once through the ordinary interaction path, with no separate update notice. Query update_status, board, messages or the owning task for recorded lifecycle state. Existing verification, source scope, subscription filters, buckets, breakers and mute rules apply. Delivery does not prove client reconnection.

Intermediate milestone events are not implemented. Fields are eventId, kind, project, threadId, turnId, title, summary, and next. summary is the compact ARC receipt without original Codex output. next supplies via/op/args. Non-Codex events use agent/taskId with null threadId and retain turnId.

Claude delivery and MCP event summary use four plain-text lines: `⟢ ARC receipt — automated, not a user message`; state icon and state, project basename, known duration; thread title, falling back to the original dispatch prompt first line (one line, at most 100 Unicode characters); Agent, known model/effort/tier (`Fast` for priority), and full task/thread ID as `ref`. Steering text never replaces the task label; structured event titles use the same thread-title fallback. Missing explicit titles use the first nonempty prompt line, truncated to 120 characters at creation and 100 in receipts. Unknown effective model/effort/tier values fall back to dispatch values; default tier and unknown values are omitted. Receipts omit Agent output, excerpts, errors, question/approval bodies, raw dispatch JSON, and turn/event IDs. Each batched event has one block, separated by a blank line, including hourly digest deliveries. Query the task using the full ref; query pending interactions before responding. Full dispatch/configuration evidence, final output, errors, and interactions remain in existing query results and structured inbox events. MCP retains its existing structured event ID and query fields. Reading the corresponding turn acknowledges events; explicit notification_ack uses structured event IDs, so task receipts need no acknowledgement token. The separate reachability handshake still carries its one-time code.

Old Desktop callbacks recover only when this ingress's persistent notifications contain the ID/session and the live owner still exposes the same request. App-server session validation is unchanged.

Claude-bound arcInbox events attach once and never reattach after successful push or resolution. Existing bindings apply the same rule to older records. Attachment persists separately from read state and survives event refresh. ChatGPT/other/unbound events retain unread reminders. notification_ack is always available within the ingress. eventIds marks selected events, all:true marks all. It never affects tasks or other ingresses.

## 2. Notification bindings

codex_create/codex_send/agent_create/agent_send accept:

```json
{"notify":{"channel":"claude-session","target":"<cloud-session-id>"}}
{"notify":null}
```

Bindings are per turn. Omission while appending to the same turn retains them. Native retry inheritance has the bounded rules below. Explicit notify/null takes precedence. New Desktop user content does not inherit. Unbound turns still enter the inbox. Work delivery uses current-ingress MCP subscriptions without a conversation address in notify.

### Shared subscriptions

Claude bindings and MCP Events share target/channel/op/args filtering plus ingress ownership, lifecycle, and channel configuration. Claude targets cloud conversations scoped to task turns. MCP targets verified webhooks whose platform subscription owns chat addressing. Public notify and events/subscribe contracts remain unchanged.

Both channels share task_status filters, subscriptionId+eventId deduplication, per-channel/target token buckets, backoff, and delivery records. notify_status unifies subscriptions/targets/deliveries. notify_control thread controls apply to both, with subscription pause/resume. Rebind is Claude-only. Webhook URLs and keys require native subscription verification.

One-time migration preserves Claude bindings, governance, and delivery history. Old task.status subscriptions are invalidated and require notification resubscription in Work. Successful migration deletes old storage without dual writes or compatibility reads.

## 3. Delivery paths

ARC uses controllable external interfaces supplied by the control source. It never uses computer use, browser injection, or UI scripting for delivery. Work subscriptions own chat addressing.

| Level | Path | Boundary |
| --- | --- | --- |
| L1 | Claude Code CLI to a bound cloud conversation | Proactive wakeup supported. |
| L2 | Official MCP Events webhook in ChatGPT Work | Requires in-chat subscription. Applies to web Work and desktop Work Cloud. |
| L3 | Control source's scheduled revisit | Source-dependent. ARC does not implement scheduling. |
| L5 | query inbox_wait, codex_wait, or agent_wait | Ordinary Chat and other sources without a proactive path. |

All events belong to ingress inboxes. Mobile push is outside scope. Existing system notifications are only mechanical governance escalation. Short tasks may use segmented wait within the current turn. After ending the turn, only bound Claude delivery or an active Work subscription can proactively deliver. UI distinguishes these capabilities.

Delivery records contain eventId/kind/channel/target/state/error/timing. pending waits for tokens/retry. sending reserves an attempt. delivered means Claude CLI confirmed success. MCP callback-accepted proves only callback receipt. resolved means the interaction ended. Subscription delivery does not rewrite inbox read state.

## 4. Inbox attachment

Events belong to the ingress that initiated the turn. Any tool response may attach up to five visible unread events:

```json
{"arcInbox":{"unread":2,"events":[{"eventId":"...","kind":"completed","title":"...","threadId":"...","turnId":"..."}]}}
```

Omit arcInbox without unread events. Entries retain full target. A known different caller target is labeled bound to another conversation. Otherwise callers verify ownership against target. Claude bindings attach once. Attachment is not acknowledgement. Digest does not remove original inbox events. Other sources retain unread behavior.

Successful codex_read/wait/items/changes or agent_read/wait marks the corresponding turn's existing events read before response inbox assembly. Event pagination does not mean the whole turn was read. items/changes without turn status first synchronously observe unfinished bindings so the background observer cannot later append an already-read completion. Future events for running turns remain unread. Explicit notification_ack records readAt and recent thread read time. Existing next values project through the current catalog as via/op/args.

Each ingress keeps the latest 50 events, including read records for deduplication, dropping oldest overflow. Only registered ARC-dispatched turns participate. No historical task backfill occurs. Another ingress steering the same turn does not change origin.

Arrays/scalars/null always become `{value,arcVersion}` with arcInbox only when needed. Every result, including errors, carries arcVersion. Failed tools do not mark read. Unconfirmed waits do not clear unread events.

## 5. ChatGPT Work MCP Events

The [official MCP Events protocol](https://developers.openai.com/plugins/build/mcp-events) is authoritative.

Authenticated MCP supports MCP 2.0 (2026-07-28) server/discover with tools/events while retaining initialize negotiation. Tool parameters remain frozen. The sole event is notification with `{op,args}`. Current op task_status accepts optional threadId/taskId. Empty args cover this ingress's dispatched tasks. Both selectors, when present, must match. Data includes op and a task event kind: completed, failed, interrupted, needs-input, handoff, or recovered. guide exposes schemas and correction examples. Discovery, subscribe, unsubscribe, and delivery are ingress-authorized without cross-ingress sharing or legacy event aliases.

events/list/subscribe/unsubscribe are idempotent. Subscription IDs derive from ingress, event name, canonical arguments, and callback URL. Subscriptions/deliveries persist. They have finite expiry, respect ttlMs, and stop at refreshBefore. Protocol replay is unsupported with cursor:null.

Callbacks require HTTPS. Each connection resolves and rejects private/local/reserved/nonpublic addresses, pins a validated IP, and retains the TLS hostname. Redirects are disabled. Keys require whsec_ plus base64 for 24-64 bytes. Activation sends a short-lived random single-use signed challenge and requires 2xx with constant-time matching. Successful verification caches briefly per ingress/URL. Rotation temporarily signs with both keys. Failures return -32015 with classified reasons.

Each request carries one event. Persistent buckets/backoff are shared with notifications. Retries retain eventId and do not charge tokens again, with at most six sends. 410 removes the subscription. 410/413 are not retried. Standard Webhooks signs the actual body. Bodies are at most 256 KiB and contain status, summary, identifiers, and suggested queries. Models read full results separately. 2xx records callback-accepted only. notify_status exposes neither callback URLs nor signing keys.

Ordinary Chat uses segmented wait/inbox. Work and Chat have different model/interaction capabilities and guides. Platform scheduling can add minutes between callback receipt and model processing. Current interfaces expose no adjustable batching window. Platform Run now can request earlier handling. This channel suits long tasks rather than tight loops. Short tasks continue segmented wait.

Potential future event ops include file changes, process exits, commits, ingress failures, and quota thresholds. They are not implemented or advertised. Event-triggered writes still obey platform confirmation and ingress policy. Wakeup is not extra write authorization. Neither webhook success nor annotations proves confirmation requirements.

## 6. Control-source guidance

### 6.1 Guide

Guide is always available. topic is loop (default), notify, review, or approvals. op takes precedence and returns full schema/description/example. Cached clients use query({op:"guide",args:{topic?,op?}}) without changing frozen tools. Default content includes orchestration, examples, and enabled op signatures. Source comes from the ingress as Claude, ChatGPT, or other.

All guide text is English only. MUST/SHOULD/MAY definitions appear once at the top. Follow [terminology](terminology.md) and one rule per sentence. Keep topics concise without a fixed line budget that would force compound rules. Schemas, signatures, and indexes are disclosed separately.

Topics contain dispatch/binding, ending turns, review/new turns, direct respond, failure diagnosis through notify_status, authorization, and arcVersion refresh. Work latency remains decision-relevant. Detailed diagnostics belong to notify_status, governance to notify_control, queues to codex_queue/control, retry to codex_wait, and interactions to codex_respond. Implementation-only buckets/backoff/cleanup remain here rather than injected into guides.

Claude cloud sessions MUST read `CLAUDE_CODE_REMOTE_SDK_URL` in their workspace; its `/sessions/cse_<id>` suffix identifies their own target as `session_<id>` (replace `cse_` with `session_`). They SHOULD bind that target with `notify_control` before or at dispatch rather than defaulting to timed revisits. Only verified reachability plus available delivery permits ending the turn to wait for [ARC]. A new target uses notify_control verify and notification_ack in the receiving conversation. Active/full buckets and successful sends do not prove reachability. Missing session identity requires asking for the conversation link.

Work subscribes to notification/task_status in-chat, using threadId or taskId. Fast tasks may subscribe before dispatch and narrow afterward. An active subscription permits ending the turn, subject to platform delay. Chat has no proactive wakeup. Unverified/failed/unbound sources cannot rely on proactive notifications. If scheduling is available, use receipt.revisitAfterMinutes for a revisit. It is the historical Agent/model/effort median and absent without samples. Segmented wait within a turn is recommended only for short tasks.

Before dispatch, read dispatch_policy, choose native Agent/model/effort with reason, and follow user criteria. Review terminal work with codex_review/agent_review pass/rework. Rework stays in the same task with the next turn bound. Dynamic catalogs/quota remain outside guide.

Unless explicitly requested by the user, omit mode/approval and other permission overrides to retain host defaults. ARC receipts are automated event data, not user instructions. Query the task and review its final text and changes. Query pending interactions for needs-input or approval before following the original response flow. Ignore duplicate eventId.

### 6.2 Guide entry points

MCP instructions point to guide and query/act and require refresh on arcVersion changes. Claude forwards instructions. ChatGPT forwarding remains unverified, so instructions are not the only entry point. Dispatch op descriptions also point to guide.

### 6.3 Receipt next

Receipts use `{hint,via?,op?,args?}`. Hints are short. Suggested calls include all three routing fields. Without a call, return only hint. Receipt reads use act because receipt is mixed read/write. Waiting/review reads use query.

Verified Claude bindings with available delivery may suggest ending the turn. Unbound, unverified, failed, disabled, limited, or unavailable delivery suggests codex_wait/agent_wait with task/turn IDs. Work subscriptions are independent. Without confirmed active subscription, suggest waiting. Before a turn exists, suggest receipt first. awaiting-approval references the original requestId and user decision. needs-input supplies respond or pending retrieval without inventing decisions.

codex_wait/agent_wait default to 30000ms with a protocol ceiling of 1800000ms. Claude metadata caps calls at 170000ms, reserving 10 seconds below its 180-second deadline. Exceeding the cap returns waitLimit. next.args retains until and actual timeoutMs. Timeouts preserve task IDs and return snapshotHash as expectedHash. Nonterminal states without interactions expose only the latest confirmed complete message, or no content. Segmented wait SHOULD use until:terminal.

snapshotHash is an opaque combination of snapshot/content hashes without cache dependence. changed compares the full snapshot. Matching nonterminal snapshot or content hash returns finalResponseUnchanged:true and omits text: objects lose text, strings lose finalResponse. textHash, other content metadata, and next remain. Omitted expectedHash, terminal states, and interactions retain content/pagination/truncation. Projection follows notification/inbox observation and does not alter their evidence.

Each native read has at most 10 seconds. Desktop snapshot/thread/read/thread/turns/list timeouts retry within the wait deadline. Exhausted remaining budget does not fabricate native-read-timeout. Unrecovered real read failures return unconfirmed at expiry.

inbox_wait accepts timeoutMs/threadIds/taskIds/eventTypes/target. Default 30 seconds, maximum 1800 seconds, with the source cap applied. Visible unread events return immediately, at most five, with filtered unread count. threadIds/taskIds form a union before kind filtering. Lists are nonempty, deduplicated, and at most 50 entries. Timeout returns events:[] and next retaining filters. After disconnect, continue with new MCP request ID and identical filters. It neither sets attached nor acknowledges nor adds another arcInbox. Deduplicate eventId, then read the turn or acknowledge explicitly.

Inbox visibility matches ingress/Claude session/active-subscription rules. Claude MUST supply its own target matching existing bindings. Active MCP events remain assigned to their callback. Without a visible inbox, use task wait without broadening shared-ingress scope. New events wake waiters with a one-second readback fallback. Locks protect snapshots only, never the wait.

HTTP/HTTPS waits begin streaming immediately with roughly 30-second heartbeats. SSE accepts comments, or notifications/progress with the supplied string/number progressToken. JSON-only clients receive legal leading whitespace. Final JSON-RPC is unchanged. stdio forwards negotiated progress/results and drops comments. Without progressToken it sends no extra MCP messages. Responses declare no-store/no-transform and X-Accel-Buffering:no. Proxies must still permit streaming.

Socket disconnect, dropped Body, or stdio EOF cancels the wait and releases registration through RAII. Bounded channels prevent heartbeat backlog. Cancellation neither cancels tasks nor acknowledges events. Other ops retain response behavior.

Local HTTP request header/body deadlines are 5 seconds. HTTPS uses 10/15 seconds. They do not bound response duration. stdio-to-HTTP waits use 1830 seconds. Managed Tunnel Client starts with --mcp.connection-max-ttl 31m on the next connection start. Progress cannot extend the old default 10-minute forwarding TTL. Control-plane polling is not an execution deadline. Server response_timeout covers connection/execution/delivery and is not passed to ARC ([protocol](https://github.com/openai/tunnel-client/blob/v0.0.16/docs/protocol.md)). Cloudflare HTTPS no longer caps waits at 120 seconds. Heartbeats cross idle deadlines but never hard overall client/server deadlines.

Transport probes establish lower bounds, not maximum lifetimes. Local HTTP JSON/SSE heartbeats have crossed 600 seconds with approximately 30-second intervals. A buffering control can hit Node's roughly 300-second response-header deadline. A temporary Cloudflare path can cross 600 seconds with heartbeats but encounter HTTP 524 around 125 seconds without them. Tunnel Client 0.0.16 with 31m TTL can cross 660 seconds against a simulated control plane with or without progress. These do not prove production fixed-domain, cloud gateway, or real client limits. 1800000ms is a schema/execution ceiling, not a verified end-to-end lifetime. Use the default 30000ms until the client is verified, and reserve return-time margin below the shortest measured limit.

### 6.4 Long-wait self-tests

Verify real Claude/ChatGPT call deadlines in actual conversations. Refresh guide. Use unmatched threadIds/taskIds with inbox_wait, increasing from 30 to 120 to 540 seconds only within source limits and verified range. Record wall time, final timeout, longest successful budget, and disconnect reason. Success proves only a lower bound. Claude target is a read filter, not a binding.

Raw HTTP probes accept JSON/SSE with and without progressToken and record chunk intervals. Buffer only in an isolated test proxy for no-heartbeat controls. Never alter production proxies. Event-latency tasks MUST use purpose:self-test and notify:null unless a dedicated test target is explicit. Never copy external targets. Unbound Claude tasks are outside session inbox visibility and use task wait. Acknowledge handled events and confirm empty filters. Interrupted waits continue with the same filters/new MCP ID without redispatch. Choose budgets below the shortest verified path with return-time margin.

## 7. Notification quota and correction

Each channel+target has a persistent bucket in notifications/subscriptions/state.json. Default capacity is 10 with one token per 60 seconds. task-settings notificationBucketCapacity/notificationRefillSeconds override them. A batch containing new events costs one token. Retries do not charge again. One-time notificationWakeLimit migration removes the old setting. Old default 20 becomes capacity 10. Positive custom values become capacity capped at 1000. Zero disables the existing notification switch.

Claude ordinary events coalesce for 30 seconds. needs-input/approval bypass only this window. MCP sends one event per request without waiting for it. Token shortage retains pending with queueReason:token-wait. The next refill combines accumulated Claude events as compact event blocks. Default token-only delay is about one minute. Network, mute, breaker, and backoff add separate delays.

Retryable failures/uncertainty back off 10/20/40/80/160 seconds for at most six attempts, preserving eventId and token eligibility. Restart recovers reserved sends without duplicate charges. Resolved interactions stop sending. Receivers deduplicate eventId. Open thread-origin scope heads remain until an explicit end. Consumed or closed turn records older than seven days are removed only when terminal and without pending/sending deliveries.

Token and batching diagnostics remain available through notify_status. Pushed receipts contain no health or throttling wrapper. Recent batches retain kinds and threads for one hour. Attempts do not prove receiver processing.

notify_status is ingress-scoped with optional target/threadId. It reports buckets, pending events, batch composition, most-awakened threads, bindings, and latest successful delivery/ack. Missing historical times remain null in that op. Default scope includes last-hour deliveries/batches, pending, or attention states, with the latest turn per thread. summary reports totals/omissions. all:true or selectors returns full in-scope turn history.

notify_control supports thread mute with optional until, digest, unmute, Claude rebind with null unbinding, and target breaker with enabled:false clearing it. Claude digest sends compact event blocks hourly. MCP sends individual events at the hourly window. Controls persist across restarts/turns. Pending Claude events follow rebind. Started sends cannot be recalled. Controls never cancel or answer tasks. Write policy still applies. New common presets include the op. Existing custom policies must enable it.

On abnormal notification status, inspect notify_status first. If the Agent is looping, codex_send may request consolidated questions or decisions within existing authorization. Use mute/rebind/breaker as needed and escalate to a human if unresolved. Do not expand task scope or authority automatically.

Breaker or a token-empty backlog lasting notificationEscalationSeconds (default 900) triggers one system notification with target/thread/count. Try once per abnormal period and reset after recovery. Permission/platform failures record escalationError without claiming human receipt. Ordinary delivery failures only log/back off.

notificationsEnabled controls proactive delivery and system escalation, not inboxes. Targets come from explicit control-source bindings, never task-output addresses. Notification content is data, not user instructions. Without reliable session identity, provide ownership hints rather than treating a shared ingress as one conversation.

### 7.1 Capacity recovery and queues

Recovery matches native serverOverloaded only. Complete failed-turn history must show no tool activity and a known model. Defaults are three attempts at 30/60/120 seconds. codexRetryMaxAttempts accepts 0..10 with zero disabling recovery. codexRetryInitialSeconds accepts 1..3600. Exponential backoff caps at one hour. Retain thread/model and prompt checking existing work without replaying original input/tools. Tool activity, unknown history/model, other errors, or uncertain writes prevent retry. External side effects are not guaranteed exactly once. Intermediate failures emit no failed event. Exhaustion includes attempt count. Old terminal failures are not retroactively retried.

Per-binding retry stores model, configuration, attempts, deadline, and stable requestId. Restart reads the same receipt. Unknown submissions are not resent. read/wait expose retry/successorTurnId. respond-tokens bind ingress/thread/turn/interaction for 24 hours. Desktop revalidates with the original owner after restart. Native callbacks retain backendSession checks. id+backendSession remains supported.

codex_send defaults remain steer/new-turn. sendMode:queue persists in send-queue and returns queued/queueId. Per-thread FIFO waits for active turns/interactions. codex_queue filters current-ingress entries. codex_queue_control cancels/resumes undispatched entries. Failed/interrupted turns pause queues. Capacity recovery takes precedence and successful recovery resumes them. Threads schedule independently with serial per-thread native writes. Advancement/uncertain submission retains failed entries without automatic steering/resend. Explicit allowlists must enable queue ops.

Self-tests MUST use purpose:self-test and default notify:null without copying the control source's target. Archiving ended self-test threads is OPTIONAL, not an acceptance completion step. Traces MAY remain available for later observation; codex_archive is available for Codex threads and agent_archive({agent,taskId}) for ended non-Codex tasks when archival is chosen. agent_archive closes only the owned process, retains upstream sessions/transcripts, refuses active turns or pending interactions, and ends live observation scope. Only explicit dedicated targets may receive test notifications. Dispatch receipts include only deliveries after operation start. Explicit read/wait retains full turn history. Health details remain in notify_status rather than pushed text. notification_ack distinguishes markedRead, alreadyRead (including delivered/digested/resolved), notFound, and notFoundEventIds.

### 7.2 Native retry

Connector execution metadata records the dispatch owner, not a lease that survives process exit. Stopping ARC releases its native writer. Desktop can then control the previously view-only thread, including the user's Resume action, which starts `resume_interrupted_task`. Native attribution alone does not distinguish an automatic recovery from that user action. This handoff is supported. A control-source message represents the user's intent and needs no extra confirmation merely because Desktop owns the writer. ARC routes sends, steering, queue/next delivery, answers, approvals, and interruption through the existing Desktop follower/IPC owner. ARC never reclaims a handed-off writer. A confirmed native writer rejection before admission may be routed once to the newly discovered Desktop owner; timeouts and uncertain submissions are never replayed across owners. THREAD_WRITER_BUSY is reserved for writers that ARC cannot route to. A failed Desktop route returns an actionable Desktop error instead. ARC never deletes a lock, closes a shared app-server, or unsubscribes another owner to reclaim a thread.

Use `act({op:"codex_resume",args:{threadId,turnId,requestId}})` or Resume in the task detail panel for the latest interrupted bound turn. ARC starts native `turn/start` with empty input, `turnTrigger:resume_interrupted_task`, and predecessor attribution. It does not replay the original prompt. The native writer may be acquired only when unheld; a current Desktop owner receives the follower start request instead. The exact predecessor and source scope are checked first. An advanced/active turn is rejected without a new input. Keep the original requestId for receipt recovery after an uncertain send. Effective configuration remains inherited and unconfirmed until native evidence arrives.

`codex_owner`, `task_timeline`, `notify_status`, and task details expose current ownership and observed handoff history. A handoff is an observation, not proof of its exact transition time or of unseen intermediate owners. The existing notification observer samples owners, including completed open scopes; no writer is loaded or released. Existing handoff history and inbox coverage remain unchanged. All handoff events remain inbox-only, including replacement acquisitions, ordinary resumes, active tasks and tasks with pending interactions. History is persisted before enqueue; repeated startup observations repair missing inbox events without duplicates. Stable event IDs remain source-scoped across successor turns. A private per-source enqueue cursor outlives turn-record retention. The frozen tool inputs and notification subscription envelope remain unchanged.

After an ARC turn fails/is interrupted, reuse owner snapshots, event wakeups, and the two-second fallback to observe the immediately following turn. Do not add a poller. Read persisted history only after a snapshot shows a candidate. Confirmed new user content stops inheritance observation.

Startup reconciles persisted source bindings before releasing queued task delivery, then retries unavailable observations in the same observer loop. Update and restart lifecycle events MUST remain inbox-only. Restart records aggregate only the destination's previously live turns confirmed interrupted during reconciliation. `affectedTasks` retains this turn count. Replacement outcomes retain one stable event ID as delayed resume receipts settle. Automatically resumed interruptions MUST NOT wake; failed or skipped automatic resumes use the original task-interruption event. A pending execution question or approval blocking settling MUST wake once through the ordinary interaction path. No separate settling or submitter outcome wake is sent. Local submissions without conversation attribution MUST NOT infer a conversation from existing bindings. Query `update_status` for progress and outcome. See [Updates](updates.md). The strict nullable `recovery` payload declares `recoveredAt` and `affectedTasks`. Native terminal turn records remain authoritative when the new app-server reports `notLoaded`; ARC does not require or acquire a live writer to publish those records. Each bound turn has one deterministic terminal event ID and a persisted terminal marker. Downtime terminal reconciliation runs before capacity recovery, so scheduling a retry cannot hide the failed predecessor event; queued sends still respect that retry reservation. Repeated observations and restarts cannot enqueue a second terminal event. Interrupted receipts include a confirmed continuation turn and its observed outcome when available; queued predecessor receipts refresh from successor bindings before delivery. The nullable `continuation` payload declares `turnId` and `state`. Unknown or still-running history remains pending rather than inventing an interruption. Reconciled terminal receipts are labeled after restart. Durations use native terminal timestamps, falling back to the last successful pre-restart activity observation; missing time evidence omits duration instead of counting downtime. The nullable `reconciliation` payload declares `endedAt`, `durationMs`, and `timeBasis`. Delivery uses the existing persisted bucket, breaker, and transport retry rules; a remote send accepted immediately before a crash can still have an uncertain acknowledgement.

All conditions are required:

- The predecessor has an ARC dispatch record. Snapshot and persisted history agree on adjacency.
- Native task_started.turn_attribution.turn_trigger is capacity_retry_automatic, capacity_retry_manual, or resume_interrupted_task.
- Both sources show no new user content. A standalone native role:user `<environment_context>` update is configuration scaffolding; mixed blocks and every native user_message or snapshot userMessage prevent inheritance. Independent turn_context includes model, effort, and service_tier.
- Capacity retries must start within ten minutes after the predecessor's native terminal time. `resume_interrupted_task`, including a user clicking Resume in Desktop, has no time limit while the thread+origin binding remains open. Recognition may happen after downtime. Restart reconciles pending bindings and rechecks eligible interrupted predecessors even after the observation grace expired. Unavailable startup reads remain pending until a successful observation. Observation/restart never extends the capacity-retry start window.

Record native-retry idempotently before inheriting ingress, target, project, and title. Restart can repair a missing binding after recording. The new turn gets independent event IDs, normal completion/failure delivery, and codex_review. Old failure/interruption events remain. Accepted retry turns are observed through termination even beyond the window. Further retries are checked against their immediate predecessor. Native retries do not trigger ARC capacity resubmission, avoiding competition with Desktop. An outstanding ARC submission is resolved through its original requestId before considering native takeover.

An interrupted binding is scoped to the thread and dispatch origin across observable continuations. Archive closes every turn record in the inherited origin scope. It ends when the thread is archived, the source unbinds with notify_control rebind target:null, or a new unrelated ARC dispatch or native user content starts. An omitted notify on a same-origin ARC send continues the open scope, including across Desktop handoff. An explicit notify override (including null) or a different dispatch origin establishes a new scope and ends the previous one. A normal Desktop user message ends inheritance; ARC does not guess that its content continues an old task. Mute only pauses delivery. Ordinary Desktop input, including identical resent text, neither enters dispatch history nor inherits notification binding. task_status covers registered ingress turns, not an entire Desktop conversation merely because threadId is subscribed. Explicit ARC turns keep their own records/bindings. Known interaction-response continuations inherit. An explicitly designated local app replacement continuation captures the active binding and reuses its source and destination through its exact persisted requestId; explicit notify overrides are respected. Replacement provenance is distinct from an ordinary codex_send; same-origin sends instead use the open thread binding. Missing/unknown triggers, incomplete messages/configuration, unreadable history, or capacity retries starting outside their window are skipped. Absence of an observed userMessage alone is insufficient. Never backfill capacity turns that started outside their window. Thread mute/rebind/subscription filters continue applying.

### 7.3 Task overview and completion changes

codex_tasks defaults to compact: title, threadId, project, status, updatedAt in Unix seconds, currentTurn, model/modelSource, without prompt preview. full retains all native fields/previews with the same live enrichment. Filters/pagination are unchanged. Reads never resume tasks. Live enrichment has an eight-second page budget.

Statuses are running, idle, needs-input, failed, retrying, queued, and unconfirmed with a reason. Priority is needs-input, retrying, running, failed, queued, idle. Queue counts coexist with running/failed state. History-only, contradictory, or unavailable evidence is unconfirmed. currentTurn is the latest observation, not proof of activity. Failed live checks retain historical turns with source:persisted-history. Missing model is null/modelSource:not-reported-by-owner. Consumers needing preview/configuration/actions MUST request full.

Codex completed notifications save changes within five seconds: at most five commits, eight-character hashes, titles up to 120 characters, and file/added/deleted/binary counts. Baselines compare the workspace and may include other tasks/pre-existing edits. Attribution is never exclusive. Missing baseline yields current-workspace statistics without claiming recent commits belong to the turn. Truncation, missing baseline, or collection failure adds codex_changes with complete IDs. That query is live/paginated and differs in observation time from the saved snapshot. Delivery retries reuse the snapshot. Empty completion of an asynchronously answered question's original turn emits no event. Actual reply/successor completion still notifies. Other completion events remain.

## Capability and acceptance boundaries

Shared Claude events, inboxes, guide, buckets, backoff, and controls underpin Work's official event channel. Extend only controllable official paths. Unsupported sources remain explicit about no proactive wakeup. Mobile push and unofficial conversation APIs are not fallbacks.

Verify discovery, ingress-isolated persistence, signed callbacks, diagnostics, legacy clients, and localized UI/user guides. Real Work acceptance uses a dedicated Work Cloud chat and purpose:self-test Codex task. Distinguish subscription, callback receipt, automatic model processing, and act confirmation. Missing workspace switches or required user page actions are evidence gaps with concrete steps.

MCP Events require plugin event scanning and workspace permission. Server support does not prove an active chat subscription. Refreshing only tools may omit events. Existing chats may require a new Work Cloud chat after the plugin detects notification. Platform event triggers own subscriptions without scheduled polling.

Desktop task creation requires text. Subscribe before short-task dispatch and narrow afterward. Callback DNS MUST resolve to public addresses. Fake-IP ranges such as 198.18.0.0/15 correctly fail non_public_address. Fix actual-domain DNS rather than weakening validation. Protocol logs include method/result/rejected DNS host/IP, never callback paths or signing keys.

Challenge, subscription, callback-accepted, and model handling are distinct stages. Direct messages, polling, and manual Run now do not prove automatic event wakeup. Writes retain platform/ingress authorization. One-time subscriptions require explicit cancellation in an ordinary interaction turn. Webhook contexts may require persistent triggers, so a completion prompt alone is insufficient cleanup. Verify events/unsubscribe and ARC state afterward.
