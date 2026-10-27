# Agent task tracking

[UI](ui.md) · [Dispatch Agents](dispatch-agents.md) · [Architecture](architecture.md)

Node activity, summaries, timelines, and execution evidence share native normalization.

## Scope

Track all active Agent sessions: ARC ACP/Pi tasks, Codex app-server threads, and directly opened Codex Desktop/Claude Code sessions from local transcripts. Timelines use normalized vocabulary rather than raw Agent formats. New Agents require native adapters, not frontend protocol handling. ARC tasks have owned event streams. External sessions may offer read-only timelines or summary fallback with verified native navigation. Never modify controlled-Agent source or private indexes. Public docs/tests/fixtures use generic projects, paths, and accounts.

## Native interfaces and normalization

Core owns normalization. ACP/Pi save it with task records. Codex backfills history on the first timeline request and merges observed dispatch threads. Live timestamps are ARC observation times. History-only start/end times are null. Native durationMs takes precedence without inferred times.

agents/activity returns session snapshots plus activeAgents for existing callers. Approval/question/selection waits count as active. agent_context.evidence contains selected-turn command/file entries. executionEvidence is true, false, or partial according to observation. Protocol events without tools yield empty evidence, not unsupported. Desktop subscribes to agents:activity, Web to SSE, with GET for initial load/fallback.

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
| error | Terminal/error evidence. |
| notice | Non-terminal retry, context compaction, or warning observation. |

Entries have stable id, startedAt, optional endedAt, and status. Tools use toolCallId/item ID. ACP consumes session/update agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, and session/request_permission. Missing/other kind falls back to rawInput.command/file_path and tool names. toolCallId links calls/results. exitCode prefers rawOutput, then conservative text extraction, otherwise missing. Pi consumes message_end, tool events, extension_ui_request, and agent_settled. Codex consumes typed thread items including reasoning summaries and backfills history. External activity caches a Timeline projected from the last 128 KiB of each transcript. Claude uses backfill_claude; Codex rollout framing feeds the same native item/tool converters as backfill_codex. Pi branch history feeds Timeline::agent, including tool calls in message_end. Timeline::session owns phase, headline, recent content, recent steps, and turn-start projection for both ARC tasks and external sessions. activity.rs owns discovery, file stamps, expiry scheduling, and metadata caching; it does not interpret message blocks for presentation.

Approval requests containing only toolCallId reuse matching tool command/path/title. Existing excerpt limits and common-secret redaction apply to input/output summaries. Truncated event windows report partial coverage. Execution evidence filters command/file entries. Only absence of protocol events yields STRUCTURED_COMMAND_EVIDENCE_UNSUPPORTED.

### Lifecycle notices and tool inputs

A `notice` entry has completed observation status and a `notice` object with `kind` (`retry`, `compaction`, or `warning`) and `stage` (`start`, `end`, or `message`). Native evidence optionally supplies `attempt`, `maxAttempts`, `message`, `title`, `severity`, `nativeStatus`, `trigger`, `tokensBefore`, `tokensAfter`, `success`, and `aborted`. Unknown values remain absent. Notices never settle, reopen, or fail a turn. They render as quiet semantic-token cards inside the process. A notice following an unmarked final answer does not hide that answer.

Pi maps auto_retry_start/end and auto_compaction_start/end, plus the current compaction_start/end events. A model-attempt message_end error is provisional until agent_settled; a successful retry can finish normally. Codex maps contextCompaction items, thread/compacted, warnings, and errors with willRetry:true. Claude compact_boundary records supply their native trigger and preTokens. ACP advertises session.notices and session.compaction, accepts notices independently of severity, and patches compaction entities by compactionId, including bounded summary/error excerpts. These mappings follow the [ACP session updates](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx), [Codex error notifications](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ErrorNotification.ts), and [Pi session events](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts).

Tool entries expose `command`, `cwd`, `path` (primary path), `paths` (native paths), and `edits` (up to 100 oldText/newText excerpt pairs) where native input supplies them. ACP rawInput, Claude tool_use, Pi arguments, and Codex dynamic/MCP tool arguments share one normalizer. Shell command/cmd and file_path/path/filePath aliases are native input spellings, not alternate ARC output contracts. Read/Write/Edit/MultiEdit/Grep/Glob keep their file operation; Task/Agent remain generic tools with their original input excerpt. Native `input`, `output`, `commandActions`, and `changes` remain available. Codex fileChange retains bounded diff excerpts and observed added/removed counts. UI tool cards consume normalized paths/edits rather than parsing raw input JSON. No file content or execution success is invented from an input alone.

Claude isSidechain records never enter the main flow, change its turn start, or settle it. History reports `coverage.omittedSidechainRecords` for records deliberately omitted from the loaded window. Separate agent/subagents files remain outside top-level session discovery.

Activity retains the two-second scan cadence, mtime/size/identity reuse, at most 128 cached tails, and native 90-second/300-second activity grace periods (30 seconds without lifecycle evidence). The 128 KiB limit applies only to the recent phase/step projection. The separate metadata clock reads the complete transcript line by line on its first scan and only appended bytes thereafter, without retaining transcript contents. Each record uses the shared Timeline converters. The clock preserves the first prompt, early thread settings, session/turn starts, and complete observed turn count regardless of file size. Read errors fail the sample rather than silently skipping bytes. Detailed Claude/Pi history keeps its separate 8 MiB tail limit and partial coverage. Unchanged transcript bytes reuse the projected Timeline while expiry still advances.

`process.rs` delivery output remains separate from the redacted display projection. ACP retains the existing per-turn concatenation with a UTF-8-safe 256 KiB tail and sticky outputTruncated; Pi replaces output with the last complete assistant message's text blocks. finalResponse and event-archive continuation consume this native buffer, never Timeline excerpts.

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

recentSteps contains at most five observed types in stable-entry chronological order. Chunks/completion/results neither duplicate entries nor move old ones to the end. Include thinking/command/file/tool/text/interaction, excluding user/plan/error. External transcripts use the same entry projection. Notices never contribute a step or replace the selected phase/headline.

dispatchSummary optionally describes the latest turn with controlSource (id, label, kind), model, effort, and serviceTier. ARC dispatch records take precedence. Persisted native Codex turn context supplies configuration for turns without ARC dispatch records. Pi and ACP supply known model metadata. Unknown fields are omitted. Local CLI origins use kind:local-cli. UI model labels shorten recognized GPT astra/sol/luna/terra IDs; Fast means serviceTier:priority.

Dispatch records and their activity, conversation, timeline and query dispatchSummary projections optionally carry caller: {agent, conversationId} captured from the calling Agent's CLI environment. Caller is display attribution only, never inferred from bindings, and does not change authorization, controlSource, notification binding or task ownership.

turnStartedAt is dispatch time for ARC Agents and observed turn-start time for Codex app-server. External Codex uses latest task_started. Claude uses latest readable user input. Missing trustworthy starts remain null rather than using phase/session start. External start tracking is independent of the 128 KiB summary tail: the first scan streams every complete line from offset zero, subsequent reads use byte offsets, truncation resets scanning, and incomplete last lines wait for the next read. A long turn or a large append does not discard earlier clock facts.

Interaction projections retain native method, question IDs/options, command/diff preview, cwd, and reason when supplied. The detail dock responds with the existing callback arguments and a stable request ID. Synchronous Codex questions submit one answers map; asynchronous questions submit answer text. Unsupported native forms remain actionable in their owner. ARC dispatch receipts use approve/bypass/reject; native permissions retain their own allow/deny semantics and do not offer an invented bypass. Resolved requests without responder provenance are labeled as resolved elsewhere.

Pending interactions, including waiting-permission, remain active and separately marked. timeline:true permits a request but does not guarantee complete coverage. fallbackHeadline uses latest readable text/thinking/command/file, then title/latest user message. recentContent provides three readable summaries. Neither changes phase/headline semantics. open is present only for verified navigation. Activity pushes throttle around one second through Tauri/SSE with GET fallback.

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

See [Arena homepage](arena.md).

### Agent view and task details

Agent nodes open layer one. Bubbles open layer two. Agent headers show a dual quota-ring icon, name, version, live task count, native link, display settings, and width toggle. The inner ring is the short window and the outer ring is weekly. Two compact quota cards honor remaining/used and countdown/time preferences. The weekly bar includes an even-pace marker. Pace sits beside the summary window percentage; update age and refresh stay in the window header. Account nodes open with the account alias and its own quota. Account-scoped lists include only recorded account attribution; unassociated history remains in the platform view. Task details and Back retain account selection. Missing quota has one muted line. Other quota details remain in settings and quota overview.

The Agent list merges live tasks with unarchived conversation metadata by session ID. Sticky sections show pending input, running tasks, unread completed tasks, conversations created today, and earlier conversations, with counts of loaded rows. Unread uses the shared tracked completion read state and precedes all date groups. Opening an unread task marks it read and moves it to its creation-date group. Empty sections are omitted. Ordinary history metadata does not imply unread status. Rows use full-width standard-density bubbles with shared source/model/project/step presentation when known. History-only rows use a neutral conversation tile and omit unknown duration, phase, model, and source. Each section orders by creation time descending. Missing live evidence never implies completion. The local agents/conversations operation pages metadata only, default 20 and maximum 50. Codex uses native thread/list with archived:false, created_at descending, and its cursor. Other drivers expose ARC-stored tasks only; a streamed metadata scan runs off the async runtime and is cached for 30 seconds across pages. No timeline or per-row runtime request occurs during listing. Scroll proximity loads the next page without polling or overlap. Rows are memoized and offscreen content uses content-visibility. Details/back retains pages and scroll position. Selecting a row reads agents/conversations/timeline. Unknown Codex histories remain read-only and full-snapshot polling follows the existing external-history interval. Metadata observed by this mounted panel is retained after live task removal, preventing an unpaged new task from disappearing; it does not imply a completed result.

Mirrored ElasticPanel/panelMorph shells open right from node/bubble, 400px wide with 16px margins and 20px radius. Open ~250ms, close ~160ms, fading content. No scrim/scroll lock/inert. Switch Agents within the shell. Reclick/Escape closes with trigger focus restoration or owning-Agent fallback. Left source views are mutually exclusive. Center dots remain global entry points.



Details have Back, a single-line task title with a full-title tooltip, native link, width toggle, status, project, and localized duration. The title omits the Agent name; the metadata row retains it. A second metadata line shows known source/connection information, the latest turn configuration, and turn count. Agent and task layers share the default 400px or viewport-minus-32px width. Forward/back slide slightly in opposite directions over 160ms without shell resizing. Activity-snapshot membership means ongoing, including external sessions whose completion is snapshot removal rather than old item status. Timelines scroll internally with jump-to-latest.

Opening Codex details reads tasks/runtime/{threadId} once for the native task title without loading conversation items or resuming the thread. This title takes precedence over activity/selection titles because bounded transcript tails may omit the original user input. Metadata read failure retains the snapshot title. Other Agents retain their activity/selection titles.

ARC first reads fully, then polls after each completed read plus ~1s with after, without overlap. Expired cursors force full reload. External read-only snapshots refresh fully about every 5s. Leaving details stops polling. Partial coverage is disclosed. Later errors preserve acquired entries.

External Codex uses app-server thread/read includeTurns without ownership/resume/approval registration. Claude transcripts project user/text/thinking/tool/results by stable tool ID, reading at most the last 8 MiB and reporting partial truncation. External responses include readOnly and use full snapshots rather than after. Missing/failed timelines show phase/recent content and a localized explanation directing complete-record inspection to the native Agent. Verified open appears in the header. External sessions offer no approval actions.

Initially scroll to bottom. Follow running work until the user scrolls up. Resume within 24px of bottom. Layout clamping after collapse is not user scrolling. Preserve the final follow at completion, then stop automatic jumps. Completion never closes details.

Approval and Pi choice/input cards appear only in the fixed bottom area, using warning-soft/warning, requester/object, allow-once explanation, and deny/allow actions. Pending cards receive focus. Full-width cards use 14px horizontal padding with explanation left and actions right. File requests use known paths. Only explicitly associated same-turn read/write/edit/create operations classify permission as read/write. Otherwise retain generic file access without inference from titles/paths.

Existing local respond forwarding, submission locks, stable requestId, and receipt state remain. Pending submission spins/disables repeats. Success removes the card while preserving timeline outcome. ACP allows only allow_once and disables allow if absent. Timeline interactions are borderless single lines showing pending object and eventual result. Keep request and execution entries in the work block. Use exact same-turn/object matching only to identify the footer request; never guess ambiguous parallel matches. File/command rows without details have no collapse control. Unknown durations have no placeholder. No extra message box exists except question-answer fields.

### Entry rendering

User messages are right-aligned light bubbles with 14/14/4/14px corners. They default to a three-line preview. Only overflowing messages show Show more / Show less, with disclosure state retained by entry ID during timeline updates. Overflow is measured again when text or panel width changes. Text/thinking use react-markdown/remark-gfm for tables, links, tasks, and code, skipping raw HTML. Links use platform opening. No syntax-highlighting dependency is added. Existing plainMarkdown and other-page rendering remain.

Entries group by turnId. Transcript or turn-less sessions use one stable fallback turn. Each turn shows its primary user prompt, one work block containing every other entry except the final answer, then the final answer as full Markdown. Native text phase:final_answer takes precedence. Completed turns without that marker use the last text entry after the last non-text entry. Intermediate text stays inside work as a muted expandable line. Steering user entries remain inside work rather than being dropped.

Work summaries show stacked kind icons, running/done/waiting state, known duration, operation counts, failures, and a chevron. Thinking, commands, files, tools, plans, interactions, errors, and intermediate text share the same block. Running and waiting blocks default open. Completion collapses the block unless a manual choice exists. Live blocks with more than three steps initially show the latest three; an explicit toggle reveals older steps. Stable turn IDs and entry IDs retain disclosure choices through incremental updates and backfill.

Work steps use one-line kind/title/status/timing summaries. Commands and paths are monospace. Thinking expands as prose beside a thin rule. Command output uses a bounded scrolling monospace box. Plans expand as checklists. Interactions retain their request/result evidence; actions remain in the approval footer. Unknown durations and diff counts remain absent. Reliable turn spans use observed start/end times, never sums of overlapping or incompletely timed steps.

Earlier turns initially collapse to a card showing turn number, known source/model/duration, a one-line prompt, and a two-line answer preview. Expanded earlier turns have an explicit collapse control. The latest turn remains expanded. Expanded turn headers stick to the top of the timeline scroll viewport.

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

The detail projection merges consecutive tool activity, keeps the latest plan in place, and removes thinking at turn end. Successful process groups fold behind their summary; failed and interrupted process groups start expanded and remain manually collapsible. Native unified diff hunks supply per-file line counts and bounded diff excerpts. Missing diff evidence remains unknown. The first prompt may carry controlSource from the original new-turn dispatch; a later steering dispatch never rewrites that prompt's attribution. Unattributed native inputs stay explicitly unattributed.

POST tasks/control bridges a fixed allowlist of existing send, interrupt, review and receipt operations through their execution owners. It records local ARC provenance and uses stable request IDs. Codex queue uses sendMode:queue; steer uses auto. Other Agents accept input after settling because agent_send rejects active turns. A successful interrupt receipt only confirms the request; timeline state confirms interruption. Unconfirmed requests require receipt readback before another write.

POST tasks/reviews reads persisted reviews. Pass/rework use codex_review or agent_review; rework sends the inline instructions as the next turn after recording the verdict. POST tasks/reviews/undo removes only the exact matching local ARC pass review under the review lock. Changed or external reviews reject undo. These are authenticated local management operations, not additions to the frozen MCP tools or notification envelope.
