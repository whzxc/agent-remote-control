# CLI reference

[Home](../../README.md) · [Automatic setup](../auto-setup.md)

`cli status` reports `cliPath`, the absolute executable path of the target Core. Every control-source guide response also reports `cliPath`. Invoke that path with `cli <command>` when `arc` is absent from PATH; quote it when it contains spaces. Guide hash caching includes the path. The optional macOS `cli install-shim` command remains available for an owned `~/.local/bin/arc` symlink.

## Executables

On macOS, use the bundled Core executable for local administration:

```sh
ARC_APP="/Applications/Agent Remote Control.app/Contents/Resources/bin/arc"
"$ARC_APP" cli help
"$ARC_APP" cli guide
```

ARC_APP is a shell convenience variable, not a runtime configuration field. Windows packages include `arc.exe` beside the desktop resources; use the installed executable path. Linux installs `arc` on PATH. The Desktop executable also accepts `cli <command>`.

Commands return a JSON envelope: `schemaVersion: 1`, `ok: true`, and `result`; errors use `ok: false` with code/message and an actionable `next`. Syntax errors also include usage. Authorization failures such as `SOURCE_REVOKED` identify the source and recovery steps instead of suggesting corrected syntax. Read `result.markdown` for the guide. Stdin accepts a JSON object up to 16 KiB. `cli guide` embeds this reference. `cli help` is a compact command-group index with one-line descriptions. Full operation schemas and configuration fields are in `capabilities` / `schema`; command syntax and operational notes are in `guide`. Discover operation contracts before invoking them:

```sh
"$ARC_APP" cli capabilities
"$ARC_APP" cli schema app.status
```

Choose the operation name from capabilities; command names and catalog operation names are not interchangeable. `cli call <operation> --stdin` sends JSON input. `cli mcp` exposes the local management catalog over stdio, separate from remote execution tools.

`cli ingress list` and `cli status` expose per-ingress `requests` counters for the current ingress instance (reset on Core restart or ingress recreation). Managed-provider `health` includes the last observation, edge connection count, consecutive restart attempts, lifetime restart count, and degradation/recovery timestamps. Recovery runs independently of status reads. `error`/`tunnelError` describe current failures; `lastTunnelError` and `lastTunnelErrorAt` retain historical provider diagnostics after recovery.

Read retained ingress events with `cli logs --stdin` and `{"grep":"Ingress","ingressId":"<id>"}`. Filter by `traceId`, `requestId`, `cfRay`, or `event` to correlate one request. The control-source `logs` op accepts the same correlation filters. Events correlate `request_received`, `request_dispatch`, `response_headers`, and `response_finished`/`response_dropped`/`handler_cancelled` using `traceId` and `connectionId`. `cfRay` is recorded when valid and available. Header/parser errors and capacity rejection use connection IDs; `provider_health`, `provider_restart`, and `provider_stop` record provider transitions. Durations and response bytes describe server processing and output production, not confirmed client delivery. Logs contain metadata only and use the existing seven-day/16 MiB retention budget. Correlate Cloudflare-side evidence before attributing requests with no ARC record to an upstream failure.

## Local build replacement

On macOS, use `cli app replace <absolute-path-to-.app>` for self-replacement, including from an ARC-owned task. `--check` validates without installing; `cli app replace --status` reads the durable outcome even while Core is offline. Use `--now` for an explicit user-directed local replacement; it skips idle checks and countdown and may interrupt ARC-owned work. Normal mode waits for idle work and shows a ten-second restart countdown. Backups live under `<state>/app-replacements/backups/`; native notifications and `app replace --status` report phases and completion. The CLI returns a receipt before the detached launchd helper stops ARC. End the calling turn after that receipt. Query status from a new turn after reconnecting. Do not run `app quit` or background a replacement shell script from the task. For a first upgrade, invoke the candidate bundle's Core CLI. See [Local app replacement](app-replacement.md) for validation, acknowledgment, task draining, rollback, and limitations.

## Control-source management

These commands use authenticated local management only. They do not change the remote `guide`, `query`, `act`, or `notification` schemas.

| Command | Local API | Input / result |
| --- | --- | --- |
| `cli source list` | `GET source` | `{sources:[...]}`, including disconnected and revoked external sources; excludes built-in local authority |
| `cli source update <id> --stdin` | `PUT source/{id}` | `{"label":"Work account","product":"claude"}`; either field may be omitted |
| `cli source disconnect <id>` | `POST source/{id}/disconnect` | Revoke external source access and keep the record; also stop a non-OAuth connection. Built-in local authority returns `LOCAL_SOURCE_PROTECTED` |
| `cli source claim <pending-source-id> --stdin` | `POST source/{id}/claim` | `{"sourceId":"new"}` or `{"sourceId":"<existing-source-id>"}`; switch requests require their fixed `switchSourceId` |
| `cli source switch <sourceId> <ingressId>` | `POST source/{id}/switch` | `{"ingressId":"<target-id>"}`; expect the next authorization on that connection |
| `cli source switch <sourceId> --cancel` | `DELETE source/{id}/switch` | Cancel the expectation and its bound request; keep the old connection |

A source contains `id`, `ingressId`, `credential`, `product`, `platform`, `label`, `createdAt`, `connectedAt`, `lastSeenAt`, and `state`. Credentials have `type` `oauth-grant` (plus `grantId` and `clientId`), `ingress`, or `local`. State is `connected`, `disconnected`, or `revoked`. `createdAt` is RFC3339; connection and last-seen times are Unix seconds or null. Connected state means the connection is available or the source has made an authenticated request, not an independently verified client presence.

`ingress oauth list <id>` identifies pending source reservations and reauthorization candidates. Ordinary claim targets must be on the same connection and have the same product. A switch request exposes `switchSourceId` and can only claim that source, with no New source option. The source anchor changes only after successful code exchange; rejecting or abandoning consent preserves the existing source. Refresh rotation preserves identity. Receipt and task origins expose `sourceId` and the current source label. Ingress IDs describe connection provenance and never determine source isolation.

A pending switch is exposed on the source as `pendingSwitch: {ingressId, expiresAt, requestId?}`. `expiresAt` is Unix seconds, 300 seconds after registration. At most one switch may wait per source and per target connection. The next new OAuth authorization is bound atomically; existing requests and their retries are not consumed. Verify the pairing code before approval. Cancel, deny, expiry, or a Core restart leaves the original source connection unchanged. Expired expectations are omitted from reads. A successful PKCE exchange moves the source anchor and invalidates the former grant for access, refresh, and events. Old grant storage is pruned on the former connection's next OAuth access. Other sources on that connection are unaffected.

After starting `cli source switch`, remove the old ARC connector in the client and add it again with the target address (or edit the URL if supported). A new DCR client ID is supported: the next authorization on the target connection binds to the pending switch and must claim its existing source. Approval and successful PKCE exchange complete the move; registration alone does not. See [Change connection](oauth.md#change-connection) for expiry and cancellation.

Removing a connection preserves established sources as disconnected with `connectionRemoved:true` and `connectionName`, revokes their grants, and cancels related switches. Source IDs, labels, history, notification bindings, governance, and dispatch records stay. Existing revoked records are unchanged. Use source switch to reattach a disconnected source. No new migration runs. Non-OAuth targets already carrying any source are rejected. An empty non-OAuth target completes on an authenticated client request; listener readiness alone is insufficient. A former non-OAuth connection cannot create another identity from its retired credential; remove and recreate that connection before reusing it. Local connections are not switch targets.

## Local control and condition waits

`cli control <op> [--stdin]` acts as the built-in `local-cli` control source.
Create/send dispatches capture `caller: {agent, conversationId}` from `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID` (Codex), or `PI_SESSION_ID` (Pi); missing, unknown or ambiguous identities are omitted.
The persisted caller appears in `dispatchSummary.caller` for display attribution only and does not affect authorization, source identity, notification binding or task ownership.
Stdin is the op's **args object**, not the MCP envelope. `requestId` can be
provided in that object where the op schema supports it. The existing
control dispatcher chooses guide/query/act, validates the same schemas and
returns the same projected result in the CLI `schemaVersion: 1` envelope.
Control errors retain the remote error object (including code and correction
hints) under `error`, with a sibling `next`. Every failure includes a schema-valid `next` operation and args, or `next:{op:null,hint}` when recovery requires a human action. Control errors do not add a CLI usage field.

```sh
arc cli control guide
arc cli control guide codex_create
printf '%s' '{"title":"Verify dispatch","prompt":"Do not call tools. Reply ARC_ACCEPTANCE_OK.","mode":"read-only"}' | arc cli control codex_create --stdin
printf '%s' '{"timeoutMs":1000}' | arc cli control inbox_wait --stdin
```

Read `arc cli control dispatch_policy` for criteria hashes and the active `policyPath`.
Use `all:true` when editing an uninstalled or disabled Agent. Agent hashes appear on
decision rows or under `policy` in the full view; the global hash is top-level.
Empty criteria also return a hash. Replace a scope's complete criteria with:

```sh
arc cli control guide dispatch_policy_update
printf '%s' '{"scope":"codex","criteria":"Use current task evidence.","expectedCriteriaHash":"<current criteriaHash>"}' | arc cli control dispatch_policy_update --stdin
```

`scope` is `global` or a registered Agent ID. `criteria` may be empty to clear it.
`expectedCriteriaHash` is required. `DISPATCH_POLICY_CONFLICT` carries
`currentCriteriaHash` and a `next` read; review the current criteria before retrying
with that hash. Success returns `scope`, `criteriaHash`, `policyPath`, and
`backupPath`. ARC atomically saves formatted JSON and retains the previous policy
in `dispatch-policy.json.bak`. Defaults, constraints and other scopes are preserved.
After an uncertain result, read the policy before attempting another replacement.

Dispatch defaults to `purpose:"self-test"` and `notify:null`. Explicit stdin
values override these defaults. Archiving ended self-test threads is optional and
is not an acceptance completion step. Keep traces for observation or archive them
later.

Receipts, task records and live activity use
`origin.ingressId` / `origin.controlSource` = `local-cli`, plus a stable
`origin.sourceId` and the current `origin.sourceLabel`. It has no ingress configuration or listener. This command uses
the existing authenticated local Core channel; neither a network ingress nor
`cli mcp` can select it. The remote guide/query/act and notification schemas are
unchanged. `cli capabilities` lists CLI-only descriptors under `cliOnly`;
`cli schema control`, `cli schema wait` and `cli schema install-shim` describe
those commands separately from management operations. Control operation errors add
`error.cliHint`, for example `arc cli control guide codex_create`, to the existing
error object. This executable hint is CLI-only; remote MCP errors are unchanged.

```sh
arc cli wait --op status --until '/core/desktop/state=="ready"' --timeout 20
printf '%s' '{"threadId":"<thread-id>","turnId":"<turn-id>","until":"terminal"}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 60
printf '%s' '{"requestId":"<request-id>"}' | arc cli wait --control --op receipt --stdin --until '/threadId exists' --until '/turnId exists' --timeout 60
```

Conditions address the unwrapped operation result with RFC 6901 JSON Pointers
(`~0` escapes `~`, `~1` escapes `/`). Comparisons are `==`, `!=`, and the suffix
`exists`. Equality operands must be JSON literals: quote strings, leave booleans,
numbers and null unquoted. `exists` includes an explicit null; missing pointers
match neither equality nor inequality. Repeated `--until` conditions are AND.
Flags may appear in any order; repeat only `--until`. Timeout is 1–1800 seconds
(default 60). Management stdin uses the same shape as `cli call`, including
`body` where required; control stdin uses the op args directly.

Waits accept read-only operations, plus `receipt` with omitted action or
`action:"read"`. Native `codex_wait`, `agent_wait`, `inbox_wait` and `state.wait`
retain their existing wait mechanism, bounded by the remaining deadline. Other
reads fall back to 500 ms polling. Success returns `matched` (pointer/value
pairs), `elapsedMs` and `lastResult`. Timeout exits nonzero with `ok:false` and
`error:{code:"WAIT_TIMEOUT",message,elapsedMs,lastResult}`; lastResult is null
if the first read did not complete. Other read errors stop immediately. A wait
does not cancel the dispatched task or re-submit it. Terminal state still needs
to be inspected: failed/cancelled also satisfy native `until:"terminal"`.

## App snapshots and macOS shim

```sh
arc cli app snapshot --out ./output/acceptance/manual
printf '%s' '{"width":1280,"height":800,"panel":{"kind":"agent","id":"codex"}}' | arc cli app snapshot --out ./output/acceptance/agent --stdin
printf '%s' '{"panel":{"kind":"source","id":"<ingress-id>"}}' | arc cli app snapshot --stdin
arc cli schema app.snapshot
arc cli install-shim
```

Snapshot requires an App-owned desktop. It opens the main window, optionally
sets its logical width/height (320–3840 / 320–2160), and optionally opens a panel:
`{kind:"agent",id}`, `{kind:"source",id}`, or `{kind:"none"}`. Panel selection
navigates to the overview. Without `panel`, the current page and panel remain.
The CLI resolves `--out` relative to its working directory; the management
operation `app.snapshot` takes `{body:{out,width,height,panel}}` and requires
an absolute `out`. Without an output path, it creates a unique directory under
`<state>/acceptance/`.

The result includes `directory`, `viewModel` and `png`. `view-model.json` records
the current renderer's animated node/task positions, primitive geometry, SVG
paths (outer arcs and tentacles), task states/text, panel selection, viewport,
theme and language. The UI refreshes its stores and waits for geometry to settle;
`layoutSettled` is always boolean: `true` when geometry settled, `false` when
the bounded settling period expired. Task bubbles include `taskId`, optional
`threadId`, and their activity `origin` for matching dispatched work. Capture is
sequential, so live activity can advance between model export and PNG capture.
On macOS `snapshot.png` comes from WKWebView `takeSnapshot`, without screen
recording permission and independently of SSH's TCC identity. Other desktop
platforms still export the model and return `png:{ok:false,code:"NOT_SUPPORTED"}`.
A failed PNG has its own error while preserving the model; inspect `png.ok`.
Headless Linux has no WebView and cannot export a rendered UI model.

`install-shim` is macOS-only and must run from the App-bundled executable. It
creates `~/.local/bin/arc` pointing to that App's `Contents/Resources/bin/arc`.
An identical link succeeds without changes; any other existing file/link fails
with `SHIM_EXISTS`. Uninstall removes the link only when this instance recorded
creating it and its target is unchanged. The result always includes `pathHint`:
`shell`, `inPath` (boolean, or null if the probe failed), `baselinePath`, `message`,
and `command` (null when unnecessary or the shell has no known correction).
The probe runs `$SHELL -c` (default `/bin/zsh`) with a minimal system PATH,
without interactive/login startup or inherited interactive PATH additions, and
has a three-second deadline. This checks shell startup, not SSH server-specific
PATH overrides. For zsh, a missing path returns a copyable command:

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "${ZDOTDIR:-$HOME}/.zshenv"
```

Shell configuration is never modified automatically. Other shells report the
probe result; configure their non-interactive startup explicitly.

## Resource diagnostics

`cli status` (catalog operation `status`) and `cli doctor` expose the same Core
resource observations used by the desktop Settings page. Sampling runs only when
status is read, with no additional monitoring task. It never starts app-server or
asks it to execute a shell. Doctor uses passive permissions and leaves Codex login
and command permission `unknown`; use the permissions page for active probes.

- `core.resources.nofile`: `soft`, `hard`, `state`, `source`, `observedAt`, `error`.
  Values are numbers, `"unlimited"`, or null when unknown/not applicable.
- `core.resources.startup`: `targetSoft` (8192), `original`, `actual`,
  `attemptedSoft`, `platformCeiling`, `state`, `reasons`, `observedAt`.
  macOS/Linux raise only the soft limit, within the hard and platform limits,
  read it back, and keep higher existing limits. Core continues when this fails;
  startup reports `degraded` and the reason. No system-wide limits are changed.
- `core.appServer`: `pid`, `startedAt` (Core's spawn timestamp), `state`
  (communication only), `observedAt`, and `resources`. These describe the shared
  background RPC instance, not temporary account readers or Codex Desktop.
- `core.appServer.resources`: `nofile`, `fd` (`count`, `sampledAt`, `attemptedAt`,
  `state`, `error`), `usageRatio`, `warningRatio` (0.9), and resource `state`.
  No process, exit during sampling, or a failed read leaves fd count null and
  state `unknown`, never a fabricated zero. PID/start time and inherited limits
  may remain as historical evidence after exit.

Limit sources are `self-measured` (Core getrlimit), `child-measured` (Linux prlimit),
`inherited-at-spawn` (Core's verified limit immediately before spawn), or
`unavailable`. Inherited limits are not proof that a child has not changed them.
Linux falls back to the inheritance record with `measurementError` if prlimit
fails. macOS uses inheritance for limits and enumerates fd records with libproc;
Linux counts `/proc/<pid>/fd`. Windows reports `not_applicable` with null values.

`diagnostics.checks.resources` contains the same snapshots. Resource states are
`ok`, `degraded`, `pressure`, `unknown`, or `not_applicable`, independently of
communication `ready`. `diagnostics.findings` uses `CORE_NOFILE_DEGRADED`,
`APP_SERVER_NOFILE_DEGRADED`, and `APP_SERVER_FD_PRESSURE` (fd count at least 90%
of the known soft limit), with source evidence and a read-only next action.
These observations do not establish a leak and do not trigger restarts or thread
unsubscriptions. Doctor exposes Core resources at `resources` and the same
app-server object at `appServer`.

## Uninstall

Run the installed binary's `cli uninstall` to stop ARC and move its App/Core,
current state directory (including managed dependencies), login registration,
platform caches, and Codex/Claude Code `arc-setup` skills to Trash. Use
`cli uninstall --purge` for permanent deletion. ARC resets macOS TCC permissions
before removing the App; failures appear in `warnings` and make the result
`incomplete`. This includes the historical `~/.local/bin/tunnel-client` only when
this instance's configuration or upgrade record identifies it; unrelated Agent
installations and histories remain intact. Remote tunnels, DNS, plugins and API
keys are not deleted by local uninstall.

Use the same `ARC_STATE_DIR` as the installation. Windows finishes after the CLI
exits and returns `state: scheduled` with `resultPath`; read that JSON receipt for
completion or errors. Linux uses the freedesktop Trash layout; a cross-filesystem
move that cannot be completed leaves the source and reports an error. The command
is local-only and is not exposed through MCP.

## Agent-driven setup

`cli setup` returns the next step for `claude-loop` (recommended) or
`chatgpt-chat`. Without a saved goal it returns `choose-goal`; submit the user's
choice with `cli setup apply choose-goal --stdin` and
`{"option":"claude-loop"}` or `{"option":"chatgpt-chat"}`. `setup next --goal`
previews a goal without persisting it. Apply decisions as `{"option":"<id>"}`;
auto actions use `{}`. `claude-code-ready` and `permissions` accept an explicit
`{"option":"skip"}`. Skipping Claude Code reports a notification limitation and
checks the completed task's `ARC_ONBOARDING_OK` reply instead.

The five step kinds are `auto`, `decide`, `authorize`, `secret`, and `remote-ui`.
The response includes `goal`, `progress`, `complete`, `steps` (the full selected
sequence as `{id,title,kind,done}`), and `step` with localized
`title`, `explain`, option labels, `apply`, `openUrl`, `doneWhen`, and `playbook`.
Goal explanations share the App’s selected-goal copy. User-facing titles,
explanations, and completion descriptions contain no internal field names or commands;
use the structured fields and playbooks for execution details.
`next`, `apply`, and `wait` accept `--locale zh-CN|en` (catalog: `body.locale`)
to localize this response without changing saved preferences. If omitted,
App language preferences apply; Auto uses the locale resolved by the App, or
terminal locale when no App locale has been saved. `onboarding` supplies the
selected ingress URL and current verification prompt. `cliPath` and `stateDir`
identify the current instance for copied prompts; `hasState` reports whether
`setup.json` exists; `dispatch` contains a saved requestId, threadId and desktopUrl
when setup has been sent to Codex. `nextAction.command` is executable in a POSIX
shell (PowerShell on Windows), includes this instance's CLI and state directory,
and supplies JSON stdin for automatic actions. Findings carry their own executable
next actions. Decisions still require the user's choice; their next action reads
the matching playbook.

`setup wait` defaults to 60 seconds (0–3600 accepted); timeout returns the
current step successfully. `setup reset` clears only setup choices, its start
time and dispatch reference, leaving ingresses intact. Repeated apply reuses an existing matching
ingress. Fixed-address choice and ChatGPT prerequisite confirmation prepare an
unstarted ingress before credential entry. Fixed addresses add `choose-provider`: `cloudflare` (recommended) or
`other-provider`. Cloudflare uses `cloudflare-login` (apply `{}` to start
authorization) and `cloudflare-tunnel` (apply `{}` to reuse/create a locally
managed tunnel and route DNS). Login state is derived from the origin certificate
in `<stateDir>/cloudflare/.cloudflared/cert.pem`; the child process has an isolated
home directory. Other providers retain the connection form.
`setup apply tunnel-credentials --stdin` accepts the non-secret
`{"tunnelId":"..."}`. Both `address-secret` and `tunnel-credentials` also accept
`{"source":"clipboard"}`. Core reads the system clipboard, extracts a
credential from plain text, common provider commands or JSON, and saves it through
ingress update, then clears the clipboard only after saving succeeds. The result contains only the relevant `hasXxx` flag; call next
again afterward. An empty clipboard with an already-saved credential is a no-op.
Extraction or save failures preserve the clipboard and return the original error without echoing its content. Agents click official
Copy controls but never inspect secrets or read the clipboard. The ARC form
opened by `openUrl` remains a fallback. Linux requires wl-clipboard or xclip and
an active desktop clipboard.

`claude-code-ready` with `{}` returns installation guidance when the CLI is
missing, or opens an interactive sign-in terminal when installed but signed out.
Its step carries `installCommand` only when missing. Login remains user-driven.

`setup playbook protocol` returns bundled protocol Markdown in `result.markdown`;
UI step IDs return their matching playbook; auto/decide-only IDs return the protocol.
The Markdown is read from the same resources installed with the skill. The local catalog exposes
`setup.next`, `setup.apply`, `setup.wait`, and `setup.dispatch`, also accessible through `cli mcp`.
Catalog inputs follow the usual `body` wrapper; apply takes
`{"body":{"stepId":"choose-goal","input":{"option":"claude-loop"}}}`.

Ingress `verification` includes `firstOAuthRequestAt` (accepted remote
DCR/authorize), `firstMcpRequestAt` (authenticated MCP dispatch), and `lastProbe`
(`observedAt`, `url`, `passed`). These are observations, not challenge verification;
setup requires a challenge newer than its saved start time and a completed task
from the selected ingress. Claude completion additionally requires delivered
notification evidence unless Claude Code was skipped.

`cli call setup.dispatch --stdin` accepts `{"body":{"goal":"claude-loop"}}`
(or `chatgpt-chat`). It saves the goal, installs the Codex skill, creates
`setup-workspace/` under the state directory, and submits the localized setup
prompt through the existing Codex task path. Explicit dispatch approves this task;
model, reasoning effort and execution ownership use existing defaults. It returns
`requestId`, `threadId` and `desktopUrl`, saved in setup.json. Repeated dispatch
reuses its durable receipt; unconfirmed or failed creation reports an error and
retains the requestId. Prompts specify ARC_STATE_DIR to keep the same instance.

`cli skill install --target codex|claude-code` installs the bundled `arc-setup`
skill to `~/.codex/skills/arc-setup/` or `~/.claude/skills/arc-setup/`, replacing
that skill directory with the current version. This command and playbook reads
work offline without starting Core. macOS loads Resources/skills/arc-setup;
Windows loads skills/arc-setup under the installation directory; Linux loads
skills/arc-setup beside arc. Debug builds fall back to the repository sources.

Permissions require Full Disk Access and applicable command Full Disk Access.
Accessibility, screen recording, and notifications are optional. Claude delivery
records expose `taskState` (raw task state, e.g. `completed`) independently of the
localized `state` display label and delivery `status`.

The local setup agent prepares and sends the loop-test prompt through ARC from
a Claude Code cloud session or ChatGPT conversation, using the available UI
tools. If no usable UI is available, the user sends it there. Completion is
observed with `setup wait`, not inferred from screenshots or local task creation.

### ChatGPT setup recovery

ChatGPT setup assumes access and starts at Tunnel configuration; it does not
inspect local Codex/ChatGPT credentials to probe permissions. Report an observed
block with `setup apply chatgpt-fallback --stdin` and
`{"reason":"platform-denied"}`, `{"reason":"chatgpt-denied"}`, or
`{"reason":"runtime-key-rejected"}`. The returned decide offers
`{"option":"https-oauth"}` or `{"option":"retry"}`. HTTPS keeps the ChatGPT goal
and reuses address/provider selection, Cloudflare login, public probing and OAuth.
It does not bypass ChatGPT workspace policy. `next.fallback` describes the
alternative while on the Tunnel path; reports and choices live in `setup.json`.

OpenAI ingress summaries include `controlPlane.state` (`unknown`, `authenticated`,
`rejected`) and `httpStatus` when observed, or null before observation. Readiness
requires a successful control-plane poll as well as the local startup check.
401/403 produces `RUNTIME_KEY_REJECTED` and returns setup to `tunnel-credentials`.
Clipboard apply checks the credential's minimum shape before saving: OpenAI
`sk-` and 32+ characters, Cloudflare `eyJ` and 64+, ngrok/LocalXpose 20+, Pinggy
16+. A failed extraction/save preserves the clipboard; success returns flags
only and clears it. Empty clipboard retries do not accept a known rejected key.

## Command groups

| Group | Commands after `cli` |
| --- | --- |
| Discover | help, guide, capabilities, schema `<operation>` |
| Invoke | call `<operation>` [--stdin], mcp |
| App | app start/status/quit/restart |
| Setup | setup [next] [--goal `<goal>`] [--locale zh-CN\|en], setup apply `<stepId>` --stdin [--locale zh-CN\|en], setup wait [--timeout `<sec>`] [--locale zh-CN\|en], setup playbook `<id>`, setup reset |
| Skill | skill install --target codex\|claude-code |
| Diagnose | status, doctor, onboarding, context --stdin, watch |
| Logs | logs, logs --stdin, logs --follow, logs --offline |
| Ingress | ingress list/presets, add --stdin, update `<id>` --stdin, remove/start/stop/restart/probe/doctor `<id>`, start-all, stop-all |
| Verification | ingress verify `<id>` [--fresh], verify [--fresh] |
| OAuth | ingress oauth list `<id>`, request `<id> <request-id>`, decision/register/revoke `<id>` --stdin |
| Bearer | ingress token rotate `<id>` |
| Settings | configure --stdin, network --stdin, connect, disconnect |
| Quota | subscriptions get/set --stdin/refresh [providerId]/open [providerId] |
| Storage | storage compact |

help, guide, capabilities, schema, ingress presets, and logs --offline do not need Core running. Other commands use the target instance's Core/Desktop. app start can launch an installed app. Prefer ingress commands for multi-connection administration; configure/network/connect/disconnect address the primary connection projection.

## Configure an ingress

```sh
printf '%s\n' '{"name":"Claude","controlSource":"claude","transport":"https","auth":"oauth","enabled":true,"config":{"httpsProvider":"cloudflare","cloudflareMode":"quick"}}' | "$ARC_APP" cli ingress add --stdin
"$ARC_APP" cli ingress list
"$ARC_APP" cli ingress start <returned-id>
"$ARC_APP" cli onboarding
```

add accepts optional id and name. id is immutable; update takes it as a command argument, not in stdin. Updates partially merge settings and restart only that running ingress. Fields include controlSource, transport (`openai-tunnel` / `https`), auth (`openai` / `none` / `bearer` / `oauth`), enabled, toolPolicy (`all` or `{allowlist:[…]}`), and config.

config fields include httpsProvider, cloudflareMode, cloudflareAuth (token by default, or login), cloudflareTunnelId, httpsUrl, httpsHost, httpsPort, cloudflareToken, ngrokAuthtoken, pinggyMode, pinggyToken, localxposeMode, localxposeAccessToken, localxposeRegion, tunnelId, apiKey, and tunnelBinary. Use `cli help` for current modes and requirements. A Bearer token is at least 32 printable ASCII characters. Secret input uses stdin or a protected file; status/list do not reveal it.

For OpenAI Tunnel, use controlSource chatgpt, transport openai-tunnel, auth openai, and config.tunnelId/apiKey. Register the identity through the official OpenAI flow. For HTTPS, choose a client-supported auth method and [provider](../guides/connections.md).

## Verify from the client

Read `cli onboarding` for the ingress's stage, URL/Tunnel ID, verificationPrompt, and executionPrompt. Ask the actual client to call `act({"op":"connector_verify","args":{"code":"<displayed code>"}})`. Then dispatch a harmless task and read its final result. `--fresh` creates a new verification challenge; retain it for that client round.

For OAuth, read the pending request before deciding. [OAuth](oauth.md#local-management) specifies the request/decision fields. Token rotation prints the new Bearer secret once; redirect it to a private file with `umask 077` rather than collecting it in chat logs.

## Subscription settings

Read subscriptions get first. subscriptions set replaces enabled and refreshMinutes (1/3/5/10; defaults to 3). Providers participate automatically with their Agent; home rings use weekly quota windows. refresh starts an online refresh; inspect observedAt/state/error for its result. open activates Agent details.


## State and environment

| Platform / purpose | Location or variable |
| --- | --- |
| macOS state | `~/.local/state/agent-remote-control` |
| Windows state | `%LOCALAPPDATA%/agent-remote-control` |
| Linux state | `${XDG_STATE_HOME:-$HOME/.local/state}/agent-remote-control` |
| Linux environment file | `${XDG_CONFIG_HOME:-$HOME/.config}/agent-remote-control/environment` |
| Explicit instance | ARC_STATE_DIR; Desktop also accepts `--state-dir <path>` |
| Desktop development (`npm run dev`) | Installed state directory; the supervisor quits the installed Desktop, hands off Core ownership, and restores it on exit |
| Standalone Dev Web (`npm run dev:ui`) | Installed app state directory; connects to its existing Core and shares its data |
| Isolated preview | Set ARC_STATE_DIR to `agent-remote-control-preview` under that base |
| Build version | ARC_BUILD_VERSION; otherwise nearest reachable v-tag, then 0.0.0 |
| Linux installer | ARC_VERSION (v-prefixed tag), ARC_INSTALL_DIR |

ARC_NATIVE_PORT, ARC_NATIVE_TOKEN, and ARC_INGRESS_ID are private forwarding-process inputs. ARC_DEV_SUPERVISED is owned by the desktop development runner; ARC_FIXTURE_* belongs to test fixtures. Upstream variables such as CODEX_HOME retain their own meaning. See [Development](../dev/development.md) for builds and [Linux](linux.md) for daemon commands.

## Limits

Manage only the selected instance. An app restart/quit can stop the CLI's own host; reconnect before readback. Do not expose the authenticated local management API through a public tunnel. A successful settings write or local listener start still needs verification from the intended remote client.

## Permissions and readiness

`cli doctor` includes passive `permissions.items` with stable IDs, state, owning process and observation time. The existing `overview` tool uses the permission page's active report, including Codex login and command probes. Detection never requests consent. Use ARC Permissions & readiness locally to request access and open System Settings. FDA is heuristic (granted / missing / unknown); Codex command execution is probed separately from Core. No additional MCP tool is required.

For the bundled Desktop launch chain, grant Full Disk Access to ARC App: Core and its Codex app-server children inherit that responsible application. A standalone Core launched by a terminal can instead inherit that terminal's identity; its probe does not prove the App is ready.

### Tunnel dependency and error diagnostics

Before starting an OpenAI Tunnel ingress, ARC checks the selected Tunnel Client
against minimum version `0.0.16`. Missing/older clients are installed into the
state directory. ARC first reuses a managed cache containing both executables at
a qualifying version. If none qualifies, it downloads the supported `v0.0.16`
release directly from the official repository and verifies its SHA256SUMS.txt.
Startup does not call the anonymous GitHub releases API. A running
ingress is stopped only when an upgrade is needed and restarted by the same start
operation. External executables are not overwritten; the ingress switches to the
managed executable. An unrecognized version blocks startup with
`TUNNEL_VERSION_UNKNOWN`; an unsuccessful install reports `TUNNEL_UPGRADE_FAILED`.
`ingress doctor` and `setup next` include the reason, observed/minimum versions,
redacted client error summary and executable next action. To explicitly reinstall
for a selected ingress, call `ingress.dependencies.install` with
`{"id":"<ingress-id>","body":{"component":"tunnel"}}` on stdin; the original
`dependencies.install` operation targets the primary ingress. Both manage the
necessary stop/start themselves.

A tunnel must be associated with the intended ChatGPT workspace in Platform.
ARC does not query a separate workspace-association API: control-plane
polling proves runtime authentication, and the first authenticated remote MCP
request remains the ChatGPT enablement signal. Follow `tunnel-credentials` and
`enable-in-chatgpt` to associate the workspace. The setup protocol requests one
scope confirmation after goal selection, and replaces/revokes only identified
ARC-created keys after replacement authentication succeeds.

## Local control sources

`cli call local-access.status` reports Claude client availability and installed configuration.
Use `cli call local-access.install --stdin` with `{"body":{"target":"code"}}` or
`{"body":{"target":"desktop"}}`. Claude Code is added in user scope with `claude mcp add`;
Claude Desktop receives a dedicated entry in its official configuration file and requires a restart.
Other servers are preserved; a conflicting same-name entry is rejected.

The installed command is `arc cli local-mcp <ingressId>` with the instance's `ARC_STATE_DIR`.
It leases the local Core and forwards the existing `guide`, `query`, `act` and `notification`
contracts through authenticated loopback IPC. A local ingress has `transport: "local"`,
`auth: "none"`; it exposes no public listener. Its enabled state and tool policy still apply.


## Control-call statistics

Run `arc cli stats control --since 1h` (default: `1d`; supported units: `m`, `h`, `d`; maximum: `30d`). This local report works offline. It groups calls by source, op, and UTC day. `textBytes` counts UTF-8 text content; `structuredContentBytes` counts serialized structuredContent; `responseBytes` counts the complete serialized tool result, including escaping and other content blocks. `requestBytes` counts serialized tools/call parameters, excluding transport framing. These are byte measurements, not billed tokens.

Records contain timestamps, source identity, op, byte counts, duration, ARC version, error codes, correlation IDs, and guide/criteria hashes. They never contain prompts, commands, file paths, results, authentication material, or error messages. Content sampling is not implemented. Storage rotates at 2 MiB, expires after 30 days, and has a 64 MiB budget. Collection and reports prune expired files; an inactive installation prunes on its next use. Storage failures do not fail control calls. Cancelled calls retain request metadata without claiming response bytes.

Sequences group calls from the same source with gaps of at most five minutes. Waste candidates include projects-then-act calls, repeated guide/policy hashes (with uncached repeats counted separately), and same-op retries after INVALID_ARGUMENTS. These are timing-based candidates, not proof of unnecessary work. Task totals associate create and subsequent calls through task/thread IDs and request receipts, ending at the first successful review. Tasks whose create predates the retained window are excluded. Unrelated source calls without a task association are not charged to a task.


## Per-source MCP text

Use `arc cli source list` to obtain a source ID. Enable minimal text only after verifying that this source's client reads structuredContent:

```sh
printf '%s' '{"minimalText":true}' | arc cli source update <sourceId> --stdin
```

Set `minimalText:false` to restore full text immediately. This setting defaults to false for every existing and new source and is read for each response without rebuilding or reconnecting. In minimal mode, MCP text points to structuredContent.result; errors also name their code. Structured results, isError, and non-text content such as images are retained. Some clients consume only text, so do not enable this setting globally. Offline configuration may set the source's minimalText boolean in sources.json while Core is stopped. CLI updates are the supported live path. No credentials or source identity change with this setting.

Task detail actions use `cli control` with the same operation arguments as control sources. See [Task detail actions](tools.md#task-detail-actions). For example, send `{ "agent": "codex", "id": "<threadId>", "action": "latest" }` to `cli control task_panel_control --stdin` to scroll to the bottom and enable follow. Read `cli control task_panel --stdin` with the same `agent` and `id` to inspect `following`, `atLatest`, the queue, timeline and disclosures.

`cli app snapshot --stdin` accepts `{ "modelOnly": true }` to return the live model inline without writing files or capturing a screenshot. Its `taskDetail` contains the selected task's current follow and queue state. An optional `taskPanel` object accepts the same navigation arguments as `task_panel_control`.

Send `{ "agent": "codex", "id": "<threadId>" }` to `cli control task_mark_read --stdin` to dismiss a completed homepage bubble without opening details. Use `cli control task_bubble --stdin` with the same arguments to read `completed`, `unread`, `readAt`, and `retained`. The same persisted read state appears in snapshot `model.taskBubbles`, including dismissed completions. Acknowledgements in WebView storage survive renderer reloads, window recreation, app restarts, and Core reconnections. Retain the newest 1000 agent/task records for at most 30 days. A new observed turn clears its prior acknowledgement. This does not acknowledge notification inbox events.

A combined resize/navigation snapshot can return `SNAPSHOT_TIMEOUT` after navigation has already taken effect. Read `{ "modelOnly": true }` without resize or navigation arguments and inspect `model.taskDetail.id` before deciding whether another navigation is needed. Once the intended task is open, capture again without replaying the navigation.

Task names can appear both in topology buttons and in the open Agent dialog. Browser automation SHOULD scope task selectors to that dialog by its accessible role and Agent name, then select the task within it. Native AX automation SHOULD read a fresh tree and select the task ref within that dialog. Do not use a global task-name match when multiple surfaces expose the same task.

## Explicit instance targeting

Run `npm run dev:isolated` from a source checkout to start a supported side-by-side development Desktop and Core. The launcher allocates a fresh private ARC state directory and uses the existing development bundle identity (`com.whzxc.agent-remote-control.dev`). Core and Desktop bind independent ephemeral loopback ports. The installed application and its state keep running. Signing and the development build remain owned by the normal development supervisor.

Wait for the launcher's `isolated-ready` JSON line. It is emitted only after Core identity and the attached Desktop endpoint respond, and includes `stateDirectory` and a `cli` argument array. This readiness handshake does not perform product acceptance. Use that checkout's newly built Core:

```sh
./dist/native/arc cli --state-dir /absolute/isolated-directory control guide
./dist/native/arc cli --state-dir /absolute/isolated-directory wait --op app.status --until '/pid exists'
./dist/native/arc cli --state-dir /absolute/isolated-directory app snapshot --stdin
```

`--state-dir` is a global CLI option placed before the command. It requires an existing absolute directory and never falls back to the installed instance. It applies to `control`, `wait`, `app snapshot`, and other CLI commands. `ARC_STATE_DIR` remains available for subprocess environments. Stop the launcher with Ctrl-C; the existing supervisor drains its own Core and Desktop. The temporary state directory is retained for inspection.

Only one development supervisor may use the development bundle identity and Vite port 5187 at a time. The production installation does not use that port. Close another development instance before starting this one. ARC state isolation does not clone or isolate the upstream Agent account/profile; select harmless projects and tasks explicitly. Local device permissions still apply. Linux supports explicit CLI state targeting for headless instances; the Desktop launcher requires macOS or Windows.

## Scoped help and control guides

Append `--help` to a command or command group, such as `cli app replace --help`, `cli wait --help`, or `cli control --help`. Help is local and does not execute the command. For the complete control index, use `printf '%s' '{"view":"full"}' | arc cli control guide --stdin`. This routes through the query `guide` op and also accepts `topic`, `op`, and `knownGuideHash`; `cli control guide codex_send` remains the single-op shortcut. The frozen MCP `guide` tool retains its original `topic`/`op` parameters.

Each `npm run dev:isolated` launch generates an `ARC Acceptance <instance>` app name and `com.whzxc.agent-remote-control.dev.acceptance-<instance>` bundle ID. `isolated-ready` includes those values, observed `desktopPid`/`corePid`, and a stable bundle-only `screen` selector. The launcher continues monitoring and emits `isolated-restarted` with new PIDs/build identity after a supervisor rebuild. `cli app snapshot --stdin` with `{ "modelOnly": true }` exposes the current `instance.desktopPid`, `bundleId`, and `appName`. The macOS bundle lives at its own named path and does not claim the installed app's URL schemes. Use the reported bundleId and omit pid so rebuilds resolve the current process: `query({op:"screen",args:{action:"tree",bundleId:"<reported-id>"}})`. Read a fresh tree after structural changes. `press`/`show` accept `expectedLabel` and `expectedRole` with a ref and reject mismatches before acting. Window results include `bundlePath`.

For an ordinary native page, wait for layout readiness: `echo '{"body":{"modelOnly":true}}' | arc cli wait --op app.snapshot --stdin --until '/model/layoutSettled == true' --timeout 20`. This confirms settled layout; use the fresh model to identify the intended panel before acting.

Only when a development scenario is loaded in the surface being read, wait for its intended detail: `echo '{"body":{"modelOnly":true}}' | arc cli wait --op app.snapshot --stdin --until '/model/scenario/ready == true' --timeout 20`. `model.scenario` exposes `name`, `state`, `ready`, `expectedTaskId`, and `error`; ordinary native pages return null. Loading a browser fixture does not load it in the native app. Browser agents MUST wait on `window.__ARC_VIEW_MODEL__().scenario.ready` in that browser page. Scenario readiness includes the expected task's loaded timeline, not just the initial list render.

Both CLI waits accept the read-only `modelOnly:true` snapshot form; resize, navigation, and file-output arguments are not allowed in a repeated snapshot wait.

### Pending request routing

`cli control` uses the built-in `local-cli` source and can change only tasks bound
to it. `request_route` changes only
notification routing; it never answers or approves. See [routing fields and
lifecycle](tools.md#pending-request-routing).

```sh
arc cli control request_route --stdin <<'JSON'
{"taskId":"<thread-id>","id":"<responseId>","action":"handoff"}
JSON
```

Use `action:"pause"`, `action:"resume"`, or `action:"read"` with the same arguments.
For other Agents include `agent` and use their `taskId` and string-form native
request ID. Local management uses `tasks.request-routing` with the same arguments
inside `body`; `tasks.settings.set` accepts `body.requestRoutingDelaySeconds`.

## Instance environment overrides

Use `cli control app_env` to read instance-local acceptance inputs. Pass `--stdin`
with `{"action":"set","reducedMotion":true,"colorScheme":"dark","locale":"en","windowWidth":320,"windowHeight":900,"taskPanelWidth":320,"presence":"present","clock":{"freeze":true}}`
to set them. `presence` also accepts `absent` and `follow-system`. Window dimensions and panel widths are logical
pixels from 320 to 3840; supported locales are `en` and `zh-CN`.

`{"action":"set","clock":{"advanceMs":15000}}` advances the routing/UI clock.
`clock.speed` accepts 0 through 100; `clock.freeze:false` resumes speed 1 unless a
speed is supplied. Advances accept 0 through 604800000 ms and are not replay-safe.
Read back after an uncertain response. Native Codex, security expiry and transport
clocks remain real.

`{"action":"clear"}` clears every override. Sets merge fields and renew `ttlMs`
(default 900000; range 1–3600000 real milliseconds). Overrides are stored separately
from preferences under the selected instance, work in installed and isolated apps,
and are marked in logs. `cli --state-dir <absolute-directory> control app_env`
targets an isolated instance explicitly. There is no Settings UI control.

Read `cli app snapshot --stdin` with `{"modelOnly":true}` for `model.env` effective
values and `source:system|override`, plus `active`/`expiresAt`. Normal app preferences
and OS resolution are both `system`. Width fields expose actual `value` and override
`requested`; a closed task panel has `value:null`. Changes are observed within the
renderer polling cadence; snapshot refreshes inputs before reading. See
[Acceptance](../dev/acceptance.md#instance-environment) for restoration and scope.
Acceptance MUST never modify host system settings; use overrides or report a gap.

## Unified updates

Use `query update_status` for the current or latest job with state, source build, blocking/resumable/unaffected group counts and task titles, outcome, error and `next`, plus at most three single-line summaries of earlier jobs. Each compact work group has `{count,titles}`. Use `view: full` for the detailed snapshot and last 20 outcomes. Use `act update_request` with `action: now | defer | cancel` to schedule the current job; pass its `id` to reject stale changes. Defer defaults to one hour and accepts `seconds`. Swap cannot be cancelled.

Authenticated local administration can submit `source: {kind: local, path}` with `when: settled | now | defer` and optional `continuation: {threadId, prompt}`. Release jobs originate only in Desktop. `arc cli app replace` and the local management routes remain local-submit aliases; `--now` maps to `when: now`. End the replacing turn after the receipt. New ARC dispatches while settling or later receive durable held receipts and start after a terminal outcome. Query their original request IDs with `receipt`. Desktop-owned and external turns remain unaffected.

See [app replacement](app-replacement.md) for acknowledgment, validation, rollback and recovery details.

## Maintainer mode

`cli config get` returns `{"maintainerMode":false}` on normal installs.
To enable the mode on this device, send `{"maintainerMode":true}` to
`cli config set --stdin`. Send `false` to disable it. This is the same persistent
ARC setting as Settings > Experimental > Maintainer mode. It takes effect on the
next guide read without disconnecting or restarting. Mode changes do not publish,
import, migrate or remove AX records. Authenticated local triage/import remains
available with the mode OFF; remote triage requires the mode and entry ownership.

For a local issue draft, send `{"friction":"A receipt stalled","receiptIds":[],"threadIds":[]}`
to `cli control ax_issue_draft --stdin`. The returned title/body include ARC version
and OS, a fixed symptom category and hashed reference IDs. Original descriptions,
prompts, paths, emails, tokens and routes are omitted. No evidence bodies are read,
no AX records are written and GitHub is never contacted. Review and complete the
reproduction details before copying the draft into an issue. Nothing is posted
automatically.

## Local AX migration and export

Use `cli ax import --from <absolute-path>` to import the interim Markdown queue
through the running Core's authenticated local management boundary. It reads only
AX frictions, backlog ideas and follow-ups from the given file. No seeds or
maintainer backlog ship with ARC. Keep personal queue files outside the source
repository. Policy, completed acceptance and history prose are not new defects.
Normalized row text determines stable import IDs. Re-running the same input is
idempotent; imported rows do not imply independently observed occurrences. Ideas
have zero failure occurrences. Imported build/time
evidence remains unknown, and reported fixes stay open for triage and verification.
The input is limited to 256 KiB. The command never changes or deletes the input.
Read the returned entries and `cli control ax_list --stdin` before retiring an
interim queue. There is no runtime dependency on that file and no dual writing.

Use `cli ax export --to <new-absolute-path>` to save a private local AX archive
in an existing directory outside ARC state. It refuses an existing destination
and returns the export count and SHA-256. A successful export marks current revisions eligible for pruning
when closed/merged and older than 180 days. A changed revision requires another
export. Open records remain retained. Keep archives with the user's local records;
export does not delete them. Local triage uses `cli control ax_triage --stdin` with
the same revision checks and history as the control-source op.


## Local coordination observation

Worktree and isolated supervisors use local management `coordination.observe` with
`body:{transitionId,kind,repository,lane?,instance?,pid?,exitCode?}`. Supported kinds
are `lane.created`, `lane.landed`, `lane.removed`, `isolated.started` and
`isolated.exited`. Read `coordination.observation` with `{id:transitionId}` after
submission. The repository must be an existing registered parent; the operation
does not register it. Core verifies ref/worktree or process evidence before reporting
`state:observed`. Reuse the exact ID and payload after an uncertain response. These
operations record metadata only and cannot execute Git, start a process or resume a
thread. They are not exposed through control-source MCP ops.

## Execution lifetime and recovery

`command` runs a foreground execution. Its child process tree is cleaned up when
execution exits or times out, including children started with shell `&` or `nohup`.
`waitMs` only controls how long the caller waits for the receipt. It does not detach
children or change the execution deadline. An `executing` receipt means the command
is running; its phase age does not indicate stalled submission. Read the original
receipt until terminal. A backend restart makes an incomplete receipt `unconfirmed`.

Use `process` with `action:"spawn"` for a managed process that must outlive the call.
Supply `params:{command:[...],cwd:"/absolute/directory",processHandle:"unique-handle",timeoutMs:null}`.
Observe output and exit through `codex_events`; stop it with `process` and
`action:"kill",params:{processHandle:"unique-handle"}`. The process belongs to the
native backend session and does not survive its termination or Core restart.
This is not a persistent operating-system service.

`codex_send` inherits omitted model and effort independently from the thread's
latest explicit settings. Explicit request fields override inheritance; policy
defaults apply only when the thread has no value for that field. Policy restrictions
still apply. Queued sends resolve omitted settings when dispatched. Replacement
prompt continuations use this same send contract; `codex_resume` keeps the thread's
model and effort for the interrupted continuation. Steering cannot change an active
turn's configuration.

Desktop owner discovery is bounded. An unanswered discovery for an unheld thread
allows reads through native persisted state. A held writer is never reclaimed.
Follow `codex_owner` recovery for the exact thread when discovery fails. During
replacement, `REPLACE_PENDING` directs the local CLI to `arc cli app replace --status`;
remote control clients can query `update_status` after reconnecting.

`logs` accepts `since` as RFC3339 or a nonnegative integer duration ending in `ms`,
`s`, `m`, `h`, or `d`, such as `2m`. Invalid input returns the accepted formats.

Account and `whoami` notification projections expose active destinations in
`notifications.sessions`. Empty, unregistered, failed, expired, revoked and
unavailable routes remain in `notifications.historicalSessions` for diagnosis.
This projection does not change delivery or erase history.

Coordination notices require qualified `lane:<project>/<name>` resources. Errors
include examples using registered project IDs and direct callers to `projects`.
Posting a notice observes its linked Codex threads before returning; unavailable
observations remain unknown rather than implying completion.

AX candidates with the same signature share occurrences across sources and builds.
An existing matching confirmed entry receives new occurrences without creating
another candidate. Candidate counts remain separate from confirmed defects.
Seed/imported entries can only be triaged by local authority. Read the current
revision with `arc cli control ax_list --stdin`, then run
`arc cli control ax_triage --stdin` with `id`, `expectedRevision`, `action`, and
`reason`. Source callers receive `AX_FORBIDDEN` with this local recovery command.


## Source-account conversations

Use `cli schema src.conversations.query` for the account-window registry and
`cli schema src.conversations.profiles` for Chrome directory/display-name discovery.
`src.conversations.open`, `src.conversations.import`, `src.conversations.clear` and `src.conversations.bind`
mirror the source conversation ops through local management. Pass the operation's
JSON arguments to `cli call <operation> --stdin`. The frozen control equivalents
are `src_conversations`, `src_chrome_profiles`, `src_conversation_open`,
`src_login_import`, `src_login_clear` and `src_conversation_bind`.

Native containers require macOS 14+. Import returns `importing` immediately
with a `next` call to poll `src_conversations`; duplicate same-account requests
reuse the running import. The background Keychain wait is 180 seconds.
Completion is `signed-in-pending` or `not-imported`; failure is `import-blocked`
with a safe reason and human-action hint. For a Keychain prompt, enter the macOS
login password and choose Always Allow. Never retry automatically or work around
a denial. See [Source conversations](tools.md#source-conversations) for arguments,
URL restrictions, binding provenance and the URL-only status limitation.

Import ownership is checked using the imported organization and ARC's confirmed
source identity. `import-mismatch` identifies `detectedAccountId` without installing
cookies. `import-unverified` requires explicit `allowUnverified:true` before installation.
The flag cannot bypass a known mismatch. `src.conversations.clear` removes only
the account website store and UUID mapping; conversations and task bindings remain.


## Local Code profile

`cli control guide` returns the built-in local authority's `sourceId`.
Enable its shared Local Code discovery preference through local management:

```sh
printf '%s' '{"capabilityProfile":{"hostAccess":"host","waitMode":"background-cli"}}' | arc cli source update <sourceId> --stdin
arc cli control guide
```

This setting affects all built-in CLI callers and does not change execution permissions.
Set `capabilityProfile:null` to restore Legacy.
MCP sources instead accept `{hostAccess:"none"|"unknown",waitMode:"push"|"poll"}`.
A `claude` MCP connector can serve Code, Chat and Cowork, so it cannot select Local Code.
New sources offer a selection through `capabilityProfileOffer` and source setup; existing sources remain Legacy until explicitly changed.
Source preferences follow the stable source ID across connection switches.

Read `cli control dispatch_policy` and `cli control guide codex_create` before dispatch.
Callers SHOULD always provide optional `title` on `codex_create` and `agent_create`: a short human-readable task title of at most 120 characters, shown in task lists and notifications. Omitted or blank titles use the first non-empty prompt line, truncated to 120 characters; the receipt includes an actionable `titleHint`. A promptless `agent_create` has an empty fallback. Rename Codex tasks with `codex_thread` using `action:"name/set"` and `params:{threadId,name}`. Native `codex_thread` fork and `codex_call` thread/start or thread/fork use native metadata without an ARC `title` argument; name the returned thread with that same operation. No Agent rename op is exposed.

For ordinary work, explicitly provide `purpose:"task"` and `notify:null`.
Retain the returned receipt, thread, and turn identifiers.
Use the controller's background-command facility for the wait:

```sh
printf '%s' '{"threadId":"<threadId>","turnId":"<turnId>","until":"terminal-or-interaction","view":"summary"}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 1800
```

Session re-invocation depends on the controller's command facility, not shell backgrounding alone.
No notification binding or verification handshake is required.
`result.lastResult` contains the bounded outcome; timeout retains it under `error.lastResult` with `WAIT_TIMEOUT`.
A matched wait may contain a failed or interrupted task, so inspect its status and `next` before reviewing.
The summary excludes all inbox and cross-thread data.
It includes an 800-character final-message excerpt, up to 50 changed paths, diffstat, truncation flags, and `completeEvidence`.
Codex summaries reuse terminal Git snapshots, including committed work after a lane is removed, with native file changes as fallback.
Git evidence may include concurrent or pre-existing workspace changes. Unavailable evidence is null with a reason and correction hint rather than an empty successful diff.
Use `view:"summary"` on Codex/Agent reads and waits; Codex reads additionally accept `turnId`.
When `finalResponseTruncated:true`, follow `finalResponseNext` for the selected turn's immutable plain-text message snapshot. Continue `control_output` using each returned `nextOffset` until null; concatenate `text` directly without JSON parsing. Offsets count UTF-16 units and preserve Unicode scalar boundaries. Read promptly: snapshots share the one-hour, 64 MiB output cache.
Follow `completeEvidence` for full evidence before recording `codex_review` or `agent_review`.
An independent model review requires a separate dispatched task.

`cli skill install --target claude-code` installs both `arc-setup` and `arc-local-code`.
`cli stats control --since 1d` includes profile/transport cohorts under `profileSequences`.
Sequences use the existing five-minute inactivity threshold and are not conversation identities.
Compare guide-byte median/p95, calls before confirmed dispatch, and argument-error retries per 100 dispatch attempts.
