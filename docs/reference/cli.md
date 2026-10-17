# CLI reference

[Home](../../README.md) · [Automatic setup](../auto-setup.md)

## Executables

On macOS, use the bundled Core executable for local administration:

```sh
ARC_APP="/Applications/Agent Remote Control.app/Contents/Resources/bin/arc"
"$ARC_APP" cli help
"$ARC_APP" cli guide
```

ARC_APP is a shell convenience variable, not a runtime configuration field. Windows packages include `arc.exe` beside the desktop resources; use the installed executable path. Linux installs `arc` on PATH. The Desktop executable also accepts `cli <command>`.

Commands return a JSON envelope: `schemaVersion: 1`, `ok: true`, and `result`; errors use `ok: false` with code/message/usage. Read `result.markdown` for the guide. Stdin accepts a JSON object up to 16 KiB. `cli guide` embeds this reference. `cli help` exposes current command grammar, input fields, presets, and operational notes. Discover operation contracts before invoking them:

```sh
"$ARC_APP" cli capabilities
"$ARC_APP" cli schema app.status
```

Choose the operation name from capabilities; command names and catalog operation names are not interchangeable. `cli call <operation> --stdin` sends JSON input. `cli mcp` exposes the local management catalog over stdio, separate from remote execution tools.

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
App language preferences apply; Auto uses the locale resolved by the App, or
terminal locale when no App locale has been saved. `onboarding` supplies the
selected ingress URL and current verification prompt. `cliPath` and `stateDir`
identify the current instance for copied prompts; `dispatch` contains a saved
requestId, threadId and desktopUrl when setup has been sent to Codex.

`setup wait` defaults to 60 seconds (0–3600 accepted); timeout returns the
current step successfully. `setup reset` clears only setup choices, its start
time and dispatch reference, leaving ingresses intact. Repeated apply reuses an existing matching
ingress. Fixed-address choice and ChatGPT prerequisite confirmation prepare an
unstarted ingress before credential entry. Fixed addresses default to Cloudflare
named; select another provider in the existing connection form if needed.
`setup apply tunnel-credentials --stdin` accepts the non-secret
`{"tunnelId":"..."}`. Users enter runtime keys and provider credentials only in
the ARC form opened by `openUrl`, never in chat or command-line arguments.

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

The local setup agent prepares the loop-test prompt; the user sends it through
ARC from a Claude Code cloud session or a ChatGPT conversation. Completion is
observed with `setup wait`, not inferred from screenshots or local task creation.

## Command groups

| Group | Commands after `cli` |
| --- | --- |
| Discover | help, guide, capabilities, schema `<operation>` |
| Invoke | call `<operation>` [--stdin], mcp |
| App | app start/status/quit/restart |
| Setup | setup [next] [--goal `<goal>`], setup apply `<stepId>` --stdin, setup wait [--timeout `<sec>`], setup playbook `<id>`, setup reset |
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

config fields include httpsProvider, cloudflareMode, httpsUrl, httpsHost, httpsPort, cloudflareToken, ngrokAuthtoken, pinggyMode, pinggyToken, localxposeMode, localxposeAccessToken, localxposeRegion, tunnelId, apiKey, and tunnelBinary. Use `cli help` for current modes and requirements. A Bearer token is at least 32 printable ASCII characters. Secret input uses stdin or a protected file; status/list do not reveal it.

For OpenAI Tunnel, use controlSource chatgpt, transport openai-tunnel, auth openai, and config.tunnelId/apiKey. Register the identity through the official OpenAI flow. For HTTPS, choose a client-supported auth method and [provider](../guides/connections.md).

## Verify from the client

Read `cli onboarding` for the ingress's stage, URL/Tunnel ID, verificationPrompt, and executionPrompt. Ask the actual client to call connector_verify with the displayed code. Then dispatch a harmless task and read its final result. `--fresh` creates a new verification challenge; retain it for that client round.

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
| Desktop development (`npm run dev`) | `agent-remote-control-dev` under the platform state base; passed to its Vite child |
| Standalone Dev Web (`npm run dev:ui`) | Installed app state directory; connects to its existing Core and shares its data |
| Isolated preview | Set ARC_STATE_DIR to `agent-remote-control-preview` under that base |
| Build version | ARC_BUILD_VERSION; otherwise nearest reachable v-tag, then 0.0.0 |
| Linux installer | ARC_VERSION (v-prefixed tag), ARC_INSTALL_DIR |

ARC_NATIVE_PORT, ARC_NATIVE_TOKEN, and ARC_INGRESS_ID are private forwarding-process inputs. ARC_DEV_SUPERVISED is owned by the desktop development runner; ARC_FIXTURE_* belongs to test fixtures. Upstream variables such as CODEX_HOME retain their own meaning. See [Development](../dev/development.md) for builds and [Linux](linux.md) for daemon commands.

## Limits

Manage only the selected instance. An app restart/quit can stop the CLI's own host; reconnect before readback. Do not expose the authenticated local management API through a public tunnel. A successful settings write or local listener start still needs verification from the intended remote client.

## Permissions and readiness

`cli doctor` includes `permissions.items` with stable IDs, state, owning process and observation time. The existing `overview` tool includes the same report. Detection never requests consent. Use ARC Settings → Permissions & readiness locally to request access and open System Settings. FDA is heuristic (granted / missing / unknown); Codex command execution is probed separately from Core. No additional MCP tool is required.

For the bundled Desktop launch chain, grant Full Disk Access to ARC App: Core and its Codex app-server children inherit that responsible application. A standalone Core launched by a terminal can instead inherit that terminal's identity; its probe does not prove the App is ready.
