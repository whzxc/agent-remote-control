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

The [built-in descriptors](../../native/src/agents/builtins.json) contain the exact discovery paths, version/help probes, compatibility notes, and upstream sources. Pi completion requires the agent_settled event. Cursor discovery verifies that an executable named agent belongs to Cursor. Grok uses the official Grok CLI, not similarly named community programs. Goose discovery requires its ACP subcommand to exclude the unrelated migration tool. Oh My Pi uses its own ACP entry, not Pi RPC. Gemini CLI and Antigravity are separate products; the Gemini entry does not execute Antigravity.

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

## Sessions and archives

Each Pi/ACP task owns its process. Completed/stopped sessions can resume through agent_send: Pi reuses the session file, ACP requires negotiated session/load support. Unconfirmed writes are not replayed automatically. Reads and waits never restart a process.

Memory events are bounded to 2000 entries or 8 MiB. Full Pi/ACP events persist as an active JSONL tail and verified gzip segments. Tails rotate at 8 MiB; unique history is retained. `cli storage compact` losslessly compresses archives. control_output reads original content with UTF-16 offsets. ACP's recent text keeps a 256 KiB tail and marks outputTruncated; the event archive holds full output.

Stopping an ingress leaves Agent processes running. Core shutdown closes ARC-owned children. Stopped task snapshots remain readable; live events and pending requests need a running process. Codex Desktop retains its own lifecycle.

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

Agents need their own login, provider access, and runtime. Discovery is not an inference test. ACP supports initialize, new/load, prompt/update, cancel, and request_permission; ARC advertises no client filesystem, terminal, or interactive-login capability. Generic Agent ops do not expose ACP model/mode switching, fork/list/import, image prompts, arbitrary extensions, or ACP v2. Pi extension interactions are not an additional OS sandbox. A Pi session that has never received a prompt may not yet have a persistent session file.
