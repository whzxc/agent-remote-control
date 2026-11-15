# Agent task tracking

[UI](ui.md) · [Dispatch Agents](dispatch-agents.md) · [Architecture](architecture.md)

The homepage retains control-source/ARC/Agent primary connections. Agent outer arcs and secondary tentacles connect task bubbles. Bubbles open execution timelines. Node activity, summaries, timelines, and execution evidence share native normalization.

## Scope

Track all active Agent sessions: ARC ACP/Pi tasks, Codex app-server threads, and directly opened Codex Desktop/Claude Code sessions from local transcripts. Timelines use normalized vocabulary rather than raw Agent formats. New Agents require native adapters, not frontend protocol handling. ARC tasks have owned event streams. External sessions may offer read-only timelines or summary fallback with verified native navigation. Never modify controlled-Agent source or private indexes. Public docs/tests/fixtures use generic projects, paths, and accounts.

## Native interfaces and normalization

Core owns normalization. ACP/Pi save it with task records. Codex backfills history on the first timeline request and merges observed dispatch threads. Live timestamps are ARC observation times. History-only start/end times are null. Native durationMs takes precedence without inferred times.

agents/activity returns session snapshots plus activeAgents for existing callers. Approval/question/selection waits count as active. agent_context.evidence contains selected-turn command/file entries. executionEvidence is true, false, or partial according to observation. Protocol events without tools yield empty evidence, not unsupported. Desktop subscribes to agents:activity, Web to SSE, with GET for initial load/fallback.

Codex transcript activity requires a running native turn. Fork initialization and user-role context without a running turn remain idle. The incremental lifecycle clock supplies turn status when the start event is outside the bounded content tail. Silence does not end a running turn. Activity samples check cached transcripts and the current and previous Codex session day directories every two seconds. File events trigger discovery across the session roots, with a 30-second discovery fallback for missed events. Unchanged transcripts reuse their cached projections.

| Type | Meaning |
| --- | --- |
| user | User/control-source input, including thread additions. |
| text | Agent text, with chunks merged natively. |
| thinking | Reasoning content. |
| command | Command, cwd, status, exitCode, output excerpt. |
| file | Path, operation read/write/edit/create, status. |
| tool | Other tool title/status/input/output excerpts. |
| plan | Plan/todo updates. |
| interaction | Approval/question/selection with respond arguments. |
| error | Error. |

Entries have stable id, startedAt, optional endedAt, and status. Tools use toolCallId/item ID. ACP consumes session/update agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, and session/request_permission. Missing/other kind falls back to rawInput.command/file_path and tool names. toolCallId links calls/results. exitCode prefers rawOutput, then conservative text extraction, otherwise missing. Pi consumes message_end, tool events, extension_ui_request, and agent_settled. Codex consumes typed thread items including reasoning summaries and backfills history. External activity reads transcript tails for phase/headline without eagerly producing complete entries. Codex timeline history reads through the current native owner, including Desktop IPC, using paginated turns. A utility app-server snapshot cannot override the Desktop owner's active turn.

Approval requests containing only toolCallId reuse matching tool command/path/title. Existing excerpt limits and common-secret redaction apply to input/output summaries. Truncated event windows report partial coverage. Execution evidence filters command/file entries. Only absence of protocol events yields STRUCTURED_COMMAND_EVIDENCE_UNSUPPORTED.

### Lifecycle notices and tool inputs

A `notice` entry has completed observation status and a `notice` object with `kind` (`retry`, `compaction`, or `warning`) and `stage` (`start`, `end`, or `message`). Native evidence optionally supplies `attempt`, `maxAttempts`, `message`, `title`, `severity`, `nativeStatus`, `trigger`, `tokensBefore`, `tokensAfter`, `success`, and `aborted`. Unknown values remain absent. Notices never settle, reopen, or fail a turn. They render as quiet semantic-token cards inside the process. A notice following an unmarked final answer does not hide that answer.

Pi maps auto_retry_start/end and auto_compaction_start/end, plus the current compaction_start/end events. A model-attempt message_end error is provisional until agent_settled; a successful retry can finish normally. Codex maps contextCompaction items, thread/compacted, warnings, and errors with willRetry:true. Claude compact_boundary records supply their native trigger and preTokens. ACP advertises session.notices and session.compaction, accepts notices independently of severity, and patches compaction entities by compactionId, including bounded summary/error excerpts. These mappings follow the [ACP session updates](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx), [Codex error notifications](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ErrorNotification.ts), and [Pi session events](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts).

Tool entries expose `command`, `cwd`, `path` (primary path), `paths` (native paths), and `edits` (up to 100 oldText/newText excerpt pairs) where native input supplies them. ACP rawInput, Claude tool_use, Pi arguments, and Codex dynamic/MCP tool arguments share one normalizer. Shell command/cmd and file_path/path/filePath aliases are native input spellings, not alternate ARC output contracts. Read/Write/Edit/MultiEdit/Grep/Glob keep their file operation; Task/Agent remain generic tools with their original input excerpt. Native `input`, `output`, `commandActions`, and `changes` remain available. Codex fileChange retains bounded diff excerpts and observed added/removed counts. UI tool cards consume normalized paths/edits rather than parsing raw input JSON. No file content or execution success is invented from an input alone.

Claude isSidechain records never enter the main flow, change its turn start, or settle it. History reports `coverage.omittedSidechainRecords` for records deliberately omitted from the loaded window. Separate agent/subagents files remain outside top-level session discovery.

Activity retains the two-second scan cadence, mtime/size/identity reuse, and at most 128 cached tails. Silence does not settle an unfinished turn. The 128 KiB limit applies only to the recent phase/step projection. The separate metadata clock reads the complete transcript line by line on its first scan and only appended bytes thereafter, without retaining transcript contents. Each record uses the shared Timeline converters. The clock preserves the native session ID, first prompt, early thread settings, session/turn starts, and complete observed turn count regardless of file size. Activity uses that session ID even when the rollout filename ends with a separate window ID. Codex activity uses the clock lifecycle even when a large tool output leaves no readable content in the tail. Read errors fail the sample rather than silently skipping bytes. Detailed Claude/Pi history keeps its separate 8 MiB tail limit and partial coverage. Unchanged transcript bytes reuse the projected Timeline.

`process.rs` delivery output remains separate from the redacted display projection. ACP retains the existing per-turn concatenation with a UTF-8-safe 256 KiB tail and sticky outputTruncated; Pi replaces output with the last complete assistant message's text blocks. finalResponse and event-archive continuation consume this native buffer, never Timeline excerpts.

Externally held Codex writers, including parent-owned subagents without a Desktop follower, expose read-only timelines from their native rollout. A utility metadata read locates the rollout without acquiring the writer. The reader validates the first session ID and projects complete records through the shared transcript converter. The native `subagent_history_start_ordinal` excludes inherited parent records from activity, turn metadata, and timeline projection while retaining the child's own session metadata. Explicit `task_complete` and `turn_aborted` records settle the matching turn; utility turn snapshots do not establish completion. Writer checks still protect mutations. Injected `external_codex_apps_open_page` records do not become user prompts or activity titles.

Codex account attribution follows the thread's bound native execution profile. Native retry dispatches retain that account when recorded. Reads resolve missing account fields in persisted native retries without rewriting records. When the execution profile cannot be resolved, attribution follows `retryOf` and then retains the last confirmed thread account. Missing configuration confirmation does not clear account attribution. Native task pages retain their profile account during live enrichment. Topology resolves each explicit task family before account grouping and visibility limits; all descendants inherit the root task's account, including an unresolved account, without detaching their parent edges.

### Activity snapshots

```json
{
  "observedAt":"...",
  "agents":{"<agent>":{"sessions":[{
    "id":"...","source":"arc-task|codex-thread|transcript",
    "title":"...","project":"...","phase":"thinking|command|file|tool|text|interaction|idle",
    "headline":"One-line summary","startedAt":"...","turnStartedAt":"...","phaseSince":"...",
    "interaction":{"kind":"permission|question","summary":"...","respond":{}},
    "recentSteps":["thinking","command","file"],"timeline":true,"open":{"kind":"...","target":"..."}
  }]}}
}
```

phase/headline prefer pending/running noninteraction entries over the latest ended entry, with update order breaking ties. Late completion never displaces active work. Pending interaction takes precedence. Resolved interactions no longer select phase/headline. phaseSince uses the selected entry's start. Thinking takes its last line, commands their command line, files their path, and text its latest sentence. Text strips Markdown. Commands/paths remain original.

recentSteps contains at most five observed types in stable-entry chronological order. Chunks/completion/results neither duplicate entries nor move old ones to the end. Include thinking/command/file/tool/text/interaction, excluding user/plan/error. Transcripts may omit it or return empty.

dispatchSummary optionally describes the latest turn with controlSource (id, label, kind), model, effort, and serviceTier. ARC dispatch records take precedence. Persisted native Codex turn context supplies configuration for turns without ARC dispatch records. Pi and ACP supply known model metadata. Unknown fields are omitted. Local CLI origins use kind:local-cli. UI model labels use exact native catalog identity matches and omit provider names, even when multiple providers share a model label. Missing labels retain the recorded model ID. Fast means a recorded serviceTier of fast or priority.

Dispatch records and their activity, conversation, timeline and query dispatchSummary projections optionally carry caller: {agent, conversationId} captured from the calling Agent's CLI environment. Caller is display attribution only, never inferred from bindings, and does not change authorization, controlSource, notification binding or task ownership.

turnStartedAt is dispatch time for ARC Agents and observed turn-start time for Codex app-server. External Codex uses latest task_started. Claude uses latest readable user input. Missing trustworthy starts remain null rather than using phase/session start. External start tracking is independent of the 128 KiB summary tail: the first scan streams every complete line from offset zero, subsequent reads use byte offsets, truncation resets scanning, and incomplete last lines wait for the next read. A long turn or a large append does not discard earlier clock facts.

Interaction projections retain native method, question IDs/options, command/diff preview, cwd, and reason when supplied. The detail dock responds with the existing callback arguments and a stable request ID. Synchronous Codex questions submit one answers map; asynchronous questions submit answer text. Unsupported native forms remain actionable in their owner. ARC dispatch receipts use approve/bypass/reject; native permissions retain their own allow/deny semantics and do not offer an invented bypass. Resolved requests without responder provenance are labeled as resolved elsewhere.

Pending interactions, including waiting-permission, remain active and separately marked. timeline:true permits a request but does not guarantee complete coverage. fallbackHeadline uses latest readable text/thinking/command/file, then title/latest user message. recentContent provides three readable summaries. Neither changes phase/headline semantics. open is present only for verified navigation. Activity pushes throttle around one second through Tauri/SSE. The visible renderer refreshes via GET after ten seconds without a snapshot, including when the push subscription is still connected.

### Timeline API

| Operation | Interface |
| --- | --- |
| Activity snapshot | GET /api/agents/activity; CLI agents.activity. |
| Respond locally | POST /api/agents/respond with snapshot `{op,args}` plus answer and stable requestId. CLI agents.respond uses `{"body":{"op":"agent_respond","args":{}}}`. |
| Web stream | GET /api/agents/activity/events, SSE event:snapshot. |
| Desktop stream | Tauri agents:activity with GET-equivalent payload. |
| Timeline | GET /api/agents/timeline/{id}?after={cursor}; CLI agents.timeline with `{"id":"...","body":{"after":12}}`. |
| Open in agent | POST /api/tasks/open with `{"agent":"codex","taskId":"<thread-id>"}`; CLI tasks.open. |

Use sessions[].id: ARC taskId for ACP/Pi, with separate nativeSessionId, or Codex threadId. after defaults to 0 and is an entry-update sequence. Chunk merges, completion, and interaction resolution advance it. Replace entries by ID, retain absent entries, and sort by position. Backfill may update positions. Cursor beyond current sequence returns TIMELINE_CURSOR_EXPIRED and requires a full read. Frontends never process raw chunks.

turnDispatchSummaries optionally maps turn IDs to the same dispatch summary. Merge summaries by turn ID during incremental reads. turnStatuses preserves native turn outcomes by ID so a recovered tool failure does not erase a completed turn answer. Text entries preserve a native phase when available, including Codex final_answer; absent phases remain unknown.

```json
{
  "sessionId":"<activity-session-id>","status":"completed",
  "entries":[{"id":"command-example","type":"command","status":"completed",
    "startedAt":"2026-01-01T00:00:00.000Z","endedAt":"2026-01-01T00:00:01.000Z",
    "updatedAt":"2026-01-01T00:00:01.000Z","cursor":13,"position":0,"turnId":"turn-example",
    "command":"printf example","exitCode":0,"exitCodeSource":"rawOutput"}],
  "cursor":13,"coverage":{"state":"complete","truncated":false},"executionEvidence":true
}
```

Tool excerpts use agent_context's 1024-byte structure with truncated/hash. Merged text caps at 256 KiB. Event/entry windows retain 2000 entries/8 MiB. Window loss or text truncation marks partial. Codex backfill is serial once per thread/Core using thread/read includeTurns:true and deduplicating typed items by ID. Live updates during backfill win. Existing observation times remain. History order precedes live-only items. After restart, ARC task records identify backfillable threads and restore timeline entry points. Desktop restores read-only subscriptions without resuming/restarting work. External history is fetched only through the separate read-only detail path.

Read failure, missing turns/items, or limits produce partial. Successfully projected history does not become partial solely because the raw event window expires. Failed backfill retains live entries and is not repeatedly retried in the same Core. status is task status. position need not be contiguous and does not reset after eviction. durationMs is native duration when available. Historical times may be null. Pi interaction.method is select/confirm/input/editor. Responses use value, string value for input/editor, or cancelled:true through agent_respond.

Activity checks around once per second ignore observedAt-only changes. Transcript tails sample around every two seconds without eager timelines. Same-entry content changes retain phaseSince. respond uses existing Agent/Codex contracts with answer/options and a new requestId. open.taskId declares native task navigation. Timeline, records, and setup send only agent and taskId to tasks/open. The adapter builds the deep link and the backend opens it natively; callers cannot supply URLs. Agents without a deep link expose no action. Codex tasks created outside Desktop become visible after Desktop restarts. The webview opener retains its default web, mail, and telephone schemes.

## Homepage UI

### Topology and task cards

Topology keeps the configuration node geometry and projects task activity into
node capsules. The task feed and Agent, source and Board task entries share
the card described in [Design sources](design.md). Related-task links use the
summary card. The detail timeline reuses the same header and keeps its own
navigation, task controls and request handling.

The summary form renders the three header rows and reads metadata already
available for the selected conversation or turn. The detail form adds a bounded
activity preview. A visible local detail card may request the native recent
timeline. Remote previews use the observed controller-scoped snapshot.
The running border follows the observed phase and is static under reduced motion.

When a full backend snapshot removes a session, retain the observation until
terminal execution evidence arrives for that turn. Viewing a completion marks
it read. Elapsed duration uses the recorded end time. A new turn clears prior
completion and unread state. Read acknowledgements persist per Agent and task
in WebView storage across renderer reloads and app restarts.

The topology and agent operations share the same persisted completion read state. `task_mark_read({agent,id})` dismisses only a completed bubble without selecting details. `task_bubble({agent,id})` and snapshot `model.taskBubbles` expose completed/unread/readAt/retained, including read acknowledgements after dismissal. Active and unknown IDs are rejected for writes. Turn IDs or turn-start timestamps distinguish a new turn from a replay of the same completed task. A newly observed turn clears the previous acknowledgement. Core reconnection preserves acknowledgements. Expired or excess records are pruned on reads and writes. Persist before dismissing a bubble or returning a successful mark-read result. Read acknowledgements do not acknowledge the notification inbox or alter task execution.

Outer-arc actions can mark all unread completed tasks under a node as read without opening details. This includes hidden descendants and overflow items. The selection is deduplicated by Agent and task ID. Active tasks remain untouched. Save the selected turn acknowledgements together before dismissing any bubbles; a storage failure keeps the selection unread. Bulk reads use the same retention and replay rules as individual reads.

Apply persisted read acknowledgements when terminal execution evidence arrives after an activity snapshot as well as during snapshot ingestion. A rediscovered completion for an acknowledged turn stays dismissed even if its initial activity record had no end time.

External transcript tentacles use text-tertiary `3 5` dashes. Ongoing ARC and external sessions show contrasting 3px flow dots on their tentacles. reduced-motion stops the flow. All bubbles open details. Native navigation is in the header. Narrow windows clip bubbles/tentacles with a 32px right fade without shrinking, hiding the whole group, or horizontal scrolling. Visible parts remain clickable. New tasks grow/fade from their outer-arc port.

### Agent view and task details

Agent nodes open the Agent panel. Activating a task opens its detail timeline. Agent headers show the [shared Agent icon](../../design/components/agent-icon.tsx), name, version, live task count, native link, display settings, and width toggle. Short, weekly, and available monthly quota cards honor remaining/used and countdown/time preferences. Monthly quota spans the full row below the short and weekly cards. All cards share reset times, pace markers, and consumption projection. Pace sits beside the summary window percentage; refresh stays in its window header. Account nodes open with the account alias and its own quota. Account-scoped lists include only recorded account attribution; unassociated history remains in the platform view. Task details and Back retain account selection. Missing quota has one muted line. Other quota details remain in settings and quota overview.

The Agent list merges live tasks with unarchived conversation metadata by session ID. Sticky sections show pending input, running tasks, unread completed tasks, conversations created today, and earlier conversations, with counts of loaded rows. Unread uses the shared tracked completion read state and precedes all date groups. Opening an unread task marks it read and moves it to its creation-date group. Empty sections are omitted. Ordinary history metadata does not imply unread status. Rows use the shared task card and omit unavailable metadata. Each section orders by creation time descending. Missing live evidence never implies completion. The local agents/conversations operation pages metadata only, default 20 and maximum 50. Codex uses native thread/list with archived:false, created_at descending, and its cursor. Other drivers expose ARC-stored tasks only; a streamed metadata scan runs off the async runtime and is cached for 30 seconds across pages. History pages read metadata. Visible detail cards request bounded previews. Scroll proximity loads the next page without polling or overlap. Details/back retains pages and scroll position. Selecting a row reads agents/conversations/timeline. Unknown Codex histories remain read-only and full-snapshot polling follows the existing external-history interval. Metadata observed by this mounted panel is retained after live task removal, preventing an unpaged new task from disappearing; it does not imply a completed result.

Node and task panels use the shared Panel, fixed left/right M slots, retained content-fit height and the layer store's dismissal and focus restoration. Source panels use the left slot; Agent and task details use the right. Narrow and portrait viewports collapse both into the full available width. See [UI conventions](ui.md) for geometry, entry motion and switching.

Narrow configuration columns and Tasks cards follow [Portrait layout](portrait-layout.md).

Topology geometry uses the retained node solvers, viewport fitting and explicit disclosure. Attention protects configuration branches. Capsule activity updates the outline, phase discs and width extent. Tasks mode owns the card feed. Opening a panel preserves topology positions.

Details have Back, the native link and a width toggle above the shared header. The header shows the task origin chain, elapsed time, title, execution spec, project name and recorded turn count. Timeline-specific controls and state stay below it. Agent and task layers share the default 400px or viewport-minus-32px width. Forward/back slide slightly in opposite directions over 160ms without shell resizing. Activity-snapshot membership means ongoing, including external sessions whose completion is snapshot removal rather than old item status. Timelines scroll internally with jump-to-latest.

Opening Codex details reads tasks/runtime/{threadId} once for the native task title without loading conversation items or resuming the thread. This title takes precedence over activity/selection titles because bounded transcript tails may omit the original user input. Metadata read failure retains the snapshot title. Other Agents retain their activity/selection titles.

ARC first reads fully, then polls after each completed read plus ~1s with after, without overlap. Expired cursors force full reload. External read-only snapshots refresh fully about every 5s. Leaving details stops polling. Partial coverage is disclosed. Later errors preserve acquired entries.

External Codex uses app-server thread/read includeTurns without ownership/resume/approval registration. Claude transcripts project user/text/thinking/tool/results by stable tool ID, reading at most the last 8 MiB and reporting partial truncation. External responses include readOnly and use full snapshots rather than after. Missing/failed timelines show phase/recent content and a localized explanation directing complete-record inspection to the native Agent. Verified open appears in the header. External sessions offer no approval actions.

Initially scroll to bottom. Follow running work until the user scrolls up. Resume within 24px of bottom. Layout clamping after collapse is not user scrolling. Preserve the final follow at completion, then stop automatic jumps. Completion never closes details.

Approval and Pi choice/input cards appear in the timeline beneath the work rail, with the Agent → controller request address and existing RequestRouting. Local manual approve, deny and handoff controls remain available. Narrow panels open the shared request Dialog. Pending cards receive focus; long previews and question options scroll independently. Existing local response forwarding, submission locks, stable requestId and uncertain receipt handling remain unchanged.

ARC-brokered answers record a bounded `answeredBy` in ARC-owned interaction responses or approval state: `{kind:"source",sourceId}`, `{kind:"local-ui"}`, or `{kind:"unknown"}`. Existing timeline and receipt reads resolve optional `label` and `brand` from the current source record, including retained revoked sources. Missing attribution remains unknown. No native Agent session, transcript or history index is changed. The timeline names the answering source for recorded approvals and uses plain Approved otherwise.

### Entry rendering

Controller instructions are left-aligned source-edged cards with a directional route and dispatch, follow-up or queued kind. The route requires ARC dispatch attribution; native prompts without it use the neutral Prompt form. They default to a three-line preview. Only overflowing messages show Show more / Show less, with disclosure state retained by entry ID during timeline updates. Overflow is measured again when text or panel width changes. Text/thinking use react-markdown/remark-gfm for tables, links, tasks, and code, skipping raw HTML. Links use platform opening. No syntax-highlighting dependency is added. Other pages retain their shared Markdown renderer.

Entries group by turnId. Transcript or turn-less sessions use one stable fallback turn. Each turn shows its primary user prompt, one process block containing every other entry except the final answer, then the final answer as full Markdown. Native text phase:final_answer takes precedence. Completed turns without that marker use the last text entry after the last non-text entry. Process rows keep observed order: intermediate text renders as Markdown narrative, and steering user entries remain in place rather than being dropped.

Consecutive command, file and tool entries form one tool run. A run with one entry renders that entry directly. Longer runs fold behind one summary line that names up to three kinds in observed order; with more kinds it names the two most significant (edits and commands before reads, searches and listings, then other tools) plus a remainder count. Failed entries add a danger-toned failure count. Tool runs start collapsed. Stable turn IDs and entry IDs retain disclosure choices through incremental updates and backfill.

A running turn ends with one live activity row. Running or pending tools leave their run and combine into that single row with a shimmering phase label, elapsed time and an open eight-line output tail. Without a running tool, the row shows the newest reasoning observed after the agent's latest message, reduced to its bold heading or first sentence, or the generic thinking label. Earlier reasoning never appears as current. A pending interaction replaces the live row with the timeline request.

Tool steps use one-line kind/title/exit-code summaries. Commands and paths are monospace. Command output uses a bounded scrolling monospace box. The latest plan renders once in the fixed panel footer while running, with a completed/total count and upward disclosure; settled turns remove the dock. Interactions retain their request/result evidence; actions remain in the request card. Unknown durations and diff counts remain absent. Reliable turn spans use observed start/end times, never sums of overlapping or incompletely timed steps.

Earlier turns initially collapse to one row showing turn number, route marks, outcome line and known duration. Expanded earlier turns have an explicit collapse control. The latest turn remains expanded.

Terminal task details read the selected turn's review automatically. A recorded review uses the final-answer card surface, with a review heading, verdict, reviewer, timestamp, and optional note. No review section or placeholder is shown while loading or when no review exists. Read failures retain an actionable retry notice.

Radix Collapsible owns keyboard/semantics. motion animates height around 180ms. Live reduced-motion changes immediately stop mounted transitions and icon rotation. Expansion affects only timeline content, never polling/cursors/follow behavior/panel shell. All colors use semantic light/dark tokens.

## Native navigation

Navigation support requires actual session readback, not command existence/help. Never modify private indexes. Do not add unverified Windows/Linux CLI routes.

| Agent | Candidate | Current boundary |
| --- | --- | --- |
| Codex | codex://threads/{threadId} | Adapter-built link, opened natively by the backend. External threads become visible after Desktop restarts. No Desktop link on Linux. |
| Claude Code | claude --resume {sessionId} in original cwd | No deep link; no task-open action. |
| Cursor | cursor-agent --resume {sessionId} | Distinct cursor-agent identity required. Generic agent is insufficient. Workspace trust may block session proof, so no open is exposed. |
| Grok | grok --resume {sessionId} | ACP creation alone does not prove CLI same-session content. No open. |
| OpenCode | opencode --session {sessionId} | Can create nonexistent IDs, so successful launch/empty UI does not prove resume. No open without content proof. |
| Pi | pi --session <path-or-id>, ARC session-dir | Empty RPC sessions may lack persisted files. Expected sessionFile paths are not persistence evidence. No open. |
| DeepSeek Harness | dsh tui --resume <session>, ACP profile | ACP creation does not establish a usable tui profile or Desktop session link. No open. |
| Gemini, Copilot, Kimi, Qwen, Kiro, Devin, Cline, Junie, Hermes, Droid, Goose, CodeBuddy, Oh My Pi | Unverified | No integrated verified navigation route. |

### Task detail controls

The detail projection merges consecutive tool activity, keeps the latest plan in place, and keeps reasoning out of process rows. Settled process blocks fold behind a duration label: worked for, failed after or stopped after the turn span, plus the action count and any failed actions. Successful process blocks start collapsed; failed and interrupted process blocks start expanded and remain manually collapsible. Settled turns are memoized on entry identity, so the one-second clock and unrelated polls re-render only the live turn. Full re-reads keep unchanged entry objects. Native unified diff hunks supply per-file line counts and bounded diff excerpts. Missing diff evidence remains unknown. The first prompt may carry controlSource from the original new-turn dispatch; a later steering dispatch never rewrites that prompt's attribution. Unattributed native inputs stay explicitly unattributed.

POST tasks/control bridges a fixed allowlist of existing send, interrupt, review and receipt operations through their execution owners. It records local ARC provenance and uses stable request IDs. Codex queue uses sendMode:queue; steer uses auto. Other Agents accept input after settling because agent_send rejects active turns. A successful interrupt receipt only confirms the request; timeline state confirms interruption. Unconfirmed requests require receipt readback before another write.

POST tasks/reviews reads persisted reviews. Pass/rework use codex_review or agent_review; rework sends the inline instructions as the next turn after recording the verdict. POST tasks/reviews/undo removes only the exact matching local ARC pass review under the review lock. Changed or external reviews reject undo. These are authenticated local management operations, not additions to the frozen MCP tools or notification envelope.

Reasoning summaries remain in transcript order as collapsed Thought rows with a heading and recorded duration. The newest streaming narration carries a trailing caret. Failed tool rows remain inline with their first error line. Successful work folds to duration and operation count; failed work starts open. Earlier turns collapse to one row with number, route, outcome and duration. The final reply is addressed Agent → controller with copy and changed files.
