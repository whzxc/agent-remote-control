# Local Agents

[Home](../../README.md) · [Tools](tools.md)

ARC discovers installed executables and reuses their native configuration and login. Codex uses `codex_*` ops; Pi and ACP Agents use `agent_*` ops with an explicit non-Codex ID. Agent management on the home screen refreshes discovery, enables Agents, and changes display order. Home shows installed entries, prioritizes enabled Agents, and respects the saved Agent order, with a configurable limit of 4/6/8/10. Subscription readings do not reorder Agents. The management panel supports search and shows entry availability separately from installation and live session status. Details include the execution entry, discovery errors and integration limits.

Call `guide` for the enabled op index and `guide({"op":"agent_create"})` for a current schema and example. Execute reads through query and mutations through act; these entrypoints remain fixed when capabilities change.

## Drivers and launch commands

| Agent ID | Entry point | Execution |
| --- | --- | --- |
| codex | Codex App Server / Desktop IPC | Native owner; [task ownership](../concepts.md#task-ownership) |
| pi | `pi --mode rpc` | ARC-owned process, Pi RPC |
| opencode | `opencode acp` | ACP v1 |
| gemini | `gemini --acp` | ACP v1 |
| claude | Installed `claude` + ARC-managed ACP adapter | Managed ACP adapter |
| cursor | `agent acp` | ACP v1 |
| grok | `grok agent stdio` | ACP v1 |
| copilot | `copilot --acp --stdio` | ACP v1 |
| kimi | `kimi acp` | ACP v1 |
| qwen | `qwen --acp` | ACP v1 |
| kiro | `kiro-cli acp` | ACP v1 |
| devin | `devin acp` | ACP v1 |
| cline | `cline --acp` | ACP v1 |
| junie | `junie --acp true` | ACP v1 |
| hermes | `hermes acp` | ACP v1 |
| droid | `droid exec --output-format acp` | ACP v1 |
| goose | `goose acp` | ACP v1 |
| codebuddy | `codebuddy --acp` | ACP v1 |
| omp | `omp acp` | ACP v1 |
| dsh | `dsh --profile acp` | ACP v1; CLI or Desktop-bundled CLI |
| kilo | `kilo acp` | ACP v1 |
| vibe | `vibe-acp` | ACP v1 |

The [built-in descriptors](../../native/src/agents/builtins.json) contain the exact discovery paths, version/help probes, compatibility notes, and upstream sources. Pi completion requires the agent_settled event. Cursor discovery verifies that an executable named agent belongs to Cursor. Grok uses the official Grok CLI, not similarly named community programs. Goose discovery requires its ACP subcommand to exclude the unrelated migration tool. Oh My Pi uses its own ACP entry, not Pi RPC. Gemini CLI and Antigravity are separate products; the Gemini entry does not execute Antigravity.

Kilo Code uses its native `kilo acp` entry. Mistral Vibe uses the separate `vibe-acp` executable from the official installation. Both reuse native provider configuration; neither provisions credentials or adds client filesystem/terminal capabilities. Vibe uses the Mistral brand artwork from the shared asset library.

installed means an executable was found. available includes version and launch-condition checks. ready means an initialized ARC session exists. Read discoveryError for failures, and agent_capabilities with taskId for the actual negotiated initialize/session responses.

## DeepSeek Harness

ARC discovers `dsh` on the normal executable search paths and the bundled CLI inside standard macOS DeepSeek Harness Desktop installations. The installed release must expose the official ACP profile. Each task runs its own ACP process with native login and profile configuration. Desktop-specific model/provider overrides are not copied to the `acp` profile; configure that profile through DeepSeek Harness when needed. ARC does not control the Desktop window or import its active conversations. Continuing after process shutdown requires `loadSession`; releases advertising only `session/resume` cannot resume through ARC. The transport ignores DSH model-catalog diagnostic lines prefixed with `[llm-deepseek-account] ` because affected releases write them to ACP stdout.

## Claude adapter

Install and log in to Claude Code, then enable Claude in ARC. ARC prepares its pinned ACP adapter and private Bun runtime, verifies SHA-512, probes startup, and activates the completed component. It reuses the discovered Claude executable through CLAUDE_CODE_EXECUTABLE. Ordinary discovery does not download it; enabling starts preparation, and disabling cancels unfinished preparation.

Components live under `dependencies/claude-acp/<version>` in ARC state. Old completed versions remain available to running sessions and are cleaned at a later Core startup before new Agent processes. Check adapter.state for missing, preparing, ready, or failed. This adapter executes local Claude Agent tasks; the Loop's outbound cloud notification uses Claude Code CLI directly.

## Create, wait, continue

```text
act {"op":"agent_create","args":{"agent":"opencode","cwd":"/absolute/project","prompt":"Do not use tools or read files. Reply OK."},"requestId":"<fresh UUID>"}
query {"op":"agent_wait","args":{"agent":"opencode","taskId":"<returned taskId>","timeoutMs":30000}}
query {"op":"agent_read","args":{"agent":"opencode","taskId":"<returned taskId>"}}
act {"op":"agent_send","args":{"agent":"opencode","taskId":"<returned taskId>","prompt":"Continue with the agreed next step."},"requestId":"<fresh UUID>"}
```

taskId is ARC's persistent UUID; sessionId is the upstream session. Pi/ACP turnId identifies one submitted prompt. agent_tasks lists ARC-created tasks with pagination. Receipts and wait continuation follow [Tools](tools.md#waiting). Pi prompt acceptance and ACP prompt completion occur at different points, so use agent_wait for the task outcome.

agent_pending returns ACP permission requests or Pi extension interactions. agent_respond selects the upstream optionId, or supplies the Pi value/confirmed field; cancelled declines the interaction. agent_interrupt requests cancellation; wait/read confirms the result.

agent_context produces a read-only review/handoff of an existing task and current project facts. It does not execute or resume work. Keep reported Agent claims distinct from command evidence.

## Dispatch policy and acceptance

Query dispatch_policy with an optional agent and taskId for native choices, shared quota readings, policy and history. The default decision view summarizes availability, quota, defaults, criteria and history. Use `view:"full"` for detailed native facts. The top-level criteria guide agent selection. Each agent has its own criteria. Use `knownCriteriaHash` to reuse unchanged criteria. See [the dispatch contract](tools.md) for hash placement and history grouping. Missing model/options inherit native session values. Existing policy files are not rewritten.

Catalog model rows keep the opaque `model` ID and existing fields. Optional `displayName` is the unmodified native human name. Optional `provider:{id,name}` comes from an explicit native provider record or a provider-defined group; if only a provider key is supplied, both fields use that key. Optional `contextWindow` is a native token count, or an array of native token counts when only selectable windows are supplied. A stated default count takes precedence over the window list. Missing metadata is omitted, never inferred from model IDs, brands, model families, endpoints or names.

`authoritative` describes completeness for the queried native session/catalog, not entitlement or execution. It is true for a fully paginated Codex model/list response, live Pi get_available_models, or a complete live ACP model selector. It is false for persistent/session snapshots, the Grok cache, Pi's installed registry subset, unavailable catalogs, empty provider groups and truncated previews. A selection absent from a non-authoritative list is not evidence of an invalid selection. Snapshots retain all model metadata but are always non-authoritative when read without a live session. The decision view groups models with identical provider and effort/tier/option choices into compact strings, such as `model-a,model-b: low-ultra, fast=priority, option=a/b`. A native displayName differing from the ID appears as `displayName (id)`; an informative native provider name labels the group once. Exact duplicate names are omitted. IDs and labels are not parsed or rewritten. Per-model contextWindow is omitted from decision strings. `authoritative` remains at catalog level. `view:"full"` retains structured model rows and all available metadata; combine it with `agent` for an untruncated single-Agent catalog. Agents without criteria or history omit model summaries in decision view and report authoritative:false because that response carries no catalog.

agent_create and agent_send accept model, options (native option IDs to string values), reason and purpose (task or self-test). Explicit choices override Agent policy defaults, then native current values. Deny rules win. The model is set first; ARC reads the updated option catalog, sets other choices and confirms the session before sending text. Unsupported or forbidden choices fail before prompt submission. Partial configuration failure returns a failed receipt with promptSubmitted:false and sessionConfirmation; already applied native settings are not rolled back. A timed-out setter closes the process and marks configuration unconfirmed so it cannot race a later prompt. Empty-prompt creation only bootstraps the catalog and ignores selection parameters.

agent_read includes dispatches. Each record separates submittedConfiguration, sessionConfirmation and turnEvidence. Pi assistant model/provider fields supply turn evidence; The managed Claude adapter can supply a per-prompt model set including internal calls; this does not prove a single main model or effort/fast settings. ACP configuration success alone does not prove a turn's actual model. Unknown evidence remains null. submission distinguishes accepted, pending, rejected and unconfirmed requests; only accepted work enters history. Never retry unconfirmed work with a new request ID.

Use agent_review with agent, taskId, optional turnId, verdict (pass/rework) and optional note. Any existing confirmed terminal turn in a readable task is reviewable, regardless of who started it. Omit turnId to review the most recent confirmed terminal turn. Unknown and running turns are rejected. Reviews record reviewer provenance and dispatchOrigin (arc with dispatchRequestId, or external with available model/effort/serviceTier, otherwise null). The latest verdict replaces the previous verdict for either origin. Reviews are supplementary feedback and never determine execution state. New dispatches do not infer rework links and do not depend on review availability. Reviews and dispatches use durable idempotent receipts. History groups by Agent, model and native options. External reviews require known model and effort and appear as separate external review counts without changing ARC counts or durations. Self-test dispatches and inherited self-test continuations are excluded.

Cursor uses its advertised cursor_login authenticate method to reuse native login before creating/loading a session. ARC does not drive an interactive login flow. ARC negotiates Cursor's parameterized model picker so model catalogs preserve native model and parameter defaults. Model, context and reasoning options are reported separately using Cursor's native IDs. Model and model-parameter overrides are rejected because their native setters persist user defaults; asserting the current values does not call a setter. Native-default inference and session mode selection remain available. The capability snapshot reports modelSelectionUnavailable.

## Sessions and archives

### Codex execution owners

Desktop is the default execution owner on macOS and Windows. Connector-owned threads use ARC's App Server. Both owners use confirmed native turn IDs for `codex_send` (`next`, `queue`, `steer` and default `auto`), queue promotion and FIFO dispatch. Desktop's optimistic UI turns without native IDs are not running-turn evidence for ARC dispatch.

Desktop can retain a trailing optimistic turn with no native ID even after the real turn ends. Its follower steering implementation selects that placeholder and waits for an ID. ARC detects this before submission and returns `DESKTOP_STEER_UNAVAILABLE`, including recovery steps. An unsuccessful `codex_queue_control action:promote` leaves the message queued. Let FIFO dispatch it after completion, or explicitly submit `codex_send sendMode:queue`. Direct `steer` and active-turn `auto` return the same error rather than silently changing delivery semantics. ARC never switches an owned thread to another executor or starts a new turn as a steering fallback. If Desktop stops acknowledging a submitted steer, its receipt is `unconfirmed`; reconcile that receipt and native history before any further submission.

Each Pi/ACP task owns its process. Completed/stopped sessions can resume through agent_send: Pi reuses the session file, ACP requires negotiated session/load support. Unconfirmed writes are not replayed automatically. Reads and waits never restart a process.

Memory events are bounded to 2000 entries or 8 MiB. Full Pi/ACP events persist as an active JSONL tail and verified gzip segments. Tails rotate at 8 MiB; unique history is retained. `cli storage compact` losslessly compresses archives. control_output reads original content with UTF-16 offsets. ACP's recent text keeps a 256 KiB tail and marks outputTruncated; the event archive holds full output. `agent_read` and `agent_wait` with `view:"summary"` expose `finalResponseNext` when the message is truncated. Follow it to `control_output` for the complete selected-turn message as plain text, including text recovered from the archive. Concatenate page `text` using returned UTF-16 `nextOffset` values until null; do not JSON-parse the message. This immutable snapshot survives later turns on the same task and uses the one-hour, 64 MiB output cache. Codex summary reads and waits use the same continuation.

Stopping an ingress leaves Agent processes running. Core shutdown closes ARC-owned children. Stopped task snapshots remain readable; live events and pending requests need a running process. Codex Desktop retains its own lifecycle.

Explicit native `thread/unsubscribe` and connector transport loss invalidate timeline observation. `task_timeline` refreshes paginated native history on subsequent reads and reports `coverage.state:partial` with `coverage.reason` until an explicit native resume restores the subscription. A history refresh never silently resumes a thread or claims that missed live events were observed.

For local ARC upgrades, use [app replace](app-replacement.md) and end the calling turn after its receipt. The detached helper waits for active turns and pending interactions to finish before shutdown; it cancels if they do not settle. RPC pipes and callbacks are not reattached across Core restart. Continue the conversation with a new turn after replacement health succeeds.

## Custom ACP manifests

Add a local definition to `agents/manifests.json` under ARC state, then restart ARC:

```json
[
  {"id":"custom-agent","command":"/absolute/path/to/agent","args":["acp"]}
]
```

Required fields are id, command, and args. Optional fields include displayName, protocol (`acp-v1`), integration (native/adapter/custom), aliases, searchDirs, versionArgs, and compatibility. IDs contain only ASCII letters, digits, underscore, and hyphen and cannot collide with built-ins or other custom IDs. Unknown fields and invalid launch conditions fail validation. `versionArgs: []` skips a custom launcher's version probe; the ACP handshake still runs.

compatibility can describe helpArgs/helpContains/identityContains, versionRequirement, runtime, authentication, caveats, and sources. Version requirements are descriptive; executable probes and the actual handshake determine availability. ARC does not expand shell commands or accept manifest edits over remote MCP.

## Limits

Agents need their own login, provider access, and runtime. Discovery is not an inference test. ACP supports initialize, new/load, prompt/update, cancel, and request_permission; ARC advertises no client filesystem, terminal, or interactive-login capability. Generic Agent ops expose only session-advertised model/config options (legacy models/modes use their native setters). They do not expose fork/list/import, image prompts, arbitrary extensions, or ACP v2. Pi extension interactions are not an additional OS sandbox. A Pi session that has never received a prompt may not yet have a persistent session file.

## ACP MCP servers and context occupancy

Configure `agents/mcp.json` under the ARC state directory. Each key is an agent ID; settings apply to new ACP processes and supported session loads:

```json
{
  "opencode": {
    "mcpServers": [
      {"name": "project-tools", "command": "/absolute/bin/project-tools", "args": ["stdio"], "env": {"LOG_LEVEL": "warn"}}
    ],
    "includeContextProvider": true
  }
}
```

Commands must be absolute paths and server names unique. `args` and `env` default to empty. `includeContextProvider` defaults to true for every ACP agent: when `context-provider.json` is configured, ARC adds `context-provider`, preserving the provider's command, arguments, environment and working directory through its stdio launcher. Set false to opt out. Dispatch does not inject context; agents query configured MCP servers on demand. Dispatch `context` and `intent` are deprecated and ignored, and do not change this session-level setting. Without explicit servers or a context provider, `mcpServers` remains empty. Do not mount the same server again in the agent's native profile. The launcher command `arc context-provider-stdio` runs the configured provider directly with inherited stdio. Task readback exposes server names only, not arguments or environment secrets.

Completed, failed and cancelled `agent_read` and `agent_wait` results expose `finalResponse`; running tasks return null and `agent_read.output` remains the streamed text. Completion notifications carry the final reply and failure/interruption errors. ACP `usage_update` is exposed as `contextUsage` with `kind: "context-occupancy"`, `used`, `size` and observation time. It is context-window occupancy, not subscription quota or account balance.

## Desktop conversation pages

Local management exposes `agents.conversations` (`POST agents/conversations`) with `body: { agent, cursor?, limit? }`. The default limit is 20 and the maximum is 50. Results contain metadata-only `data`, an opaque `nextCursor`, and `scope`. Read the current operation description with `cli schema agents.conversations`. Reuse each returned cursor unchanged.

Codex continues to use app-server `thread/list`, creation time descending, and `scope: native-unarchived`. Optional Codex model, outcome and turn-count metadata comes from at most the last 128 KiB of each validated rollout, cached by file identity and stamp. `metadataPartial: true` means the tail is incomplete; exact `turnCount` is null and earlier model or thread-tier evidence can be unavailable. An explicit latest completion or interruption may confirm the outcome; native active status takes precedence. Claude Code and Pi report `scope: native-and-arc-tasks`. Other drivers report `scope: arc-tasks`. Non-Codex rows sort by `updatedAt` descending, then `id` ascending. ARC task rows win matches on Agent and `nativeSessionId`, retaining native file-derived update time, preview, count and coverage metadata. Multiple task records for one native session resolve to the newest task. Native rows use `source: native` and their native session UUID as `id`; merged rows keep `source: arc-task` and the task ID.

Claude discovery covers every account transcript root returned by the native account registry. `agent-*` files, `subagents` directories and sampled `isSidechain` records are excluded. Titles prefer native custom titles, then summaries, then the first user text after removing reminder, command, caveat and attachment noise. Pure tool-result turns do not supply titles. If no cleaned user text remains, the first textual user row is the fallback. Titles are limited to 80 Unicode characters; previews use the last sampled assistant text, limited to 240. `project` comes from native `cwd`, and `projectName` uses the existing project catalog. Account attribution is included when the transcript root identifies an account; missing attribution does not block reads.

Pi discovery supports the explicit v3 JSONL store: the session header supplies identity and cwd, and the latest sampled `session_info` supplies its name. It scans the native agent directory's `sessions` tree (including `PI_CODING_AGENT_DIR`), `PI_CODING_AGENT_SESSION_DIR` when configured, and ARC's Pi session directory. Unregistered custom `--session-dir` locations are not discovered. Other session format versions are not inferred.

Discovery runs only on demand, off the async runtime, with a 30-second TTL. Per-file metadata is cached by path, file stamp (including size and modification time) and derivation version. Unchanged transcripts are not reparsed. Each changed file reads at most a 64 KiB head and a 128 KiB tail. `updatedAt` is the file modification time, including native title edits. `messageCount` is exact only for files fully covered by the head; otherwise it is null and `metadataPartial` is true. Large files can have titles, cwd, sidechain markers or assistant text outside these windows. Native archive semantics are unavailable. Cursor order is deterministic for a stable cache snapshot; external writes between refreshes can move rows, so restart pagination to obtain a fresh view. List rows use metadata and do not prefetch detail timelines. Missing outcome evidence remains unconfirmed until new activity or an explicit detail read supplies it. Native Claude rows can confirm a final stop reason from their latest sampled message. Listing does not resume any Agent.

`agents.conversations.timeline` (`POST agents/conversations/timeline`) takes `body: { agent, id, after? }`. Use the returned row's `id`. Unknown Codex histories and indexed native Claude/Pi sessions remain read-only without creating task records, processes, live subscriptions or ARC dispatch/approval ownership. Claude uses the existing external `claude_timeline` path. Pi replays the latest leaf's ancestry through the existing timeline event vocabulary; missing ancestors produce partial coverage. Both native readers use at most an 8 MiB tail and keep transcript paths private. Read-only responses are full snapshots, ignoring `after`; ARC task responses use the existing timeline cursor contract. These local management operations do not change the frozen control-source MCP tools or notification surface.
