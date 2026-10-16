# Configure Local Connector with Codex

**English** | [简体中文](zh-CN/codex-setup.md)

This guide configures **remote ingresses**. For local ChatGPT Desktop plugin installation, use the [plugin guide](plugin.md) instead; do not request Tunnel credentials or run ingress verification for that route.

Use the CLI on the target computer. Start by reading `<app executable> cli help`, `cli status` and `cli ingress list`. Help, guide, capabilities, schema, ingress presets and offline logs work without Core. Use `cli app start` to launch the installed app; local management MCP also supports offline discovery and startup. Other operations report availability from their Core/Desktop owner. Do not overwrite another ingress or install over a running version without authorization. OpenAI Secure Tunnel remains the default ChatGPT onboarding path.

On macOS the usual executable is `/Applications/Local Connector.app/Contents/MacOS/local-connector-desktop`; on Windows use the installed `local-connector-desktop.exe`. Do not require Node/npm on users' machines. Every CLI response is JSON: `{schemaVersion:1,ok:true,result:...}` or `{schemaVersion:1,ok:false,error:{code,message}}`, with exit status 0 or 1. Read operation results and per-ingress state, not just the exit code of a diagnostic command.

## Commands

| Command after `cli` | Purpose |
| --- | --- |
| `ingress presets` | Offline curated source registry, recommended transport/auth, limitations and official docs |
| `ingress list` | Redacted configuration, runtime state, verification and preset metadata for every ingress |
| `ingress add --stdin` | Create an entry from JSON; omitted id is generated |
| `ingress update <id> --stdin` | Partial update; config fields merge; stop the target first |
| `ingress remove <id>` | Stop and remove one entry, preserving tasks and other entries |
| `ingress start <id>` / `ingress stop <id>` | Start/stop only that entry |
| `ingress start-all` / `ingress stop-all` | Operate on all entries; start skips disabled entries; results report each failure |
| `ingress token rotate <id>` | While stopped, generate a bearer secret and return it once in stdout; resets target verification |
| `ingress doctor <id>` | Configuration, runtime evidence and client setup instructions |
| `ingress verify <id> --fresh` | Generate a fresh challenge for only this entry |
| `ingress verify <id>` | Read the existing challenge without resetting it |
| `status` / `doctor` / `onboarding` | Global summary and per-ingress JSON; readiness is not inbound or execution proof |
| `network --stdin` | Global proxyMode/proxyUrl; existing ingress processes need reconnecting |
| `configure --stdin`, `connect`, `disconnect` | Primary ingress onboarding shortcuts; do not operate on all entries |
| `verify`, `verify --fresh` | Read all challenges, or explicitly reset all challenges |

Add requires controlSource, transport, auth and config. Name defaults to the preset display name (or unknown source label), with an available numeric suffix, enabled to true, toolPolicy to the default tool allowlist. `id` is immutable and contains ASCII letters, digits, hyphen or underscore. ControlSource is a descriptive client label, not an authenticated user identity. OpenAI Tunnel requires auth `openai`; HTTPS supports `none`, `bearer`, or `oauth`. Bearer requires a unique 32+ printable ASCII secret supplied through stdin. OAuth uses the local authorization server with PKCE and either dynamic or local preregistration; see [OAuth authentication](oauth.md). `toolPolicy` is `"all"` or `{"allowlist":["connector_verify","agents","agent_create","receipt","agent_read","agent_send","agent_wait","control_output"]}`. Both tool discovery and invocation enforce it. Include connector_verify to use challenge verification. This policy does not isolate tasks or filter native methods within a tool.

Configuration keys and limits are discoverable in help. No secret is accepted as a command argument. Pipe JSON from an authorized secure local source, or redirect a protected file. Do not put secrets in shell literals, chat, screenshots or logs. For rotation, arrange a private destination first (for example `umask 077` and stdout redirection to a local file); do not capture stdout into a conversation. Deliver the secret to the supported client credential field using authorized local interaction. Never substitute the desktop management token or provider credential for the ingress bearer token.

## Subscription and panel access

`subscriptions get` reads the in-memory snapshot without refreshing. `subscriptions
set --stdin` **replaces the complete settings**: first read `result.settings`, retain
all intended `enabled`, `refreshMinutes`, `providers` and `pinnedWindows` values, then submit that
object. `subscriptions refresh [providerId]` requests a real read for the selected,
eligible source (all such sources if omitted). Its `accepted`/revision receipt is
not fresh-data success; inspect `observedAt`, `state` and `error` with get.
`subscriptions open [providerId]` opens this instance's main Agent detail panel; use an ID from the snapshot, or omit it for the Agents panel.

`panel get` returns saved `preferences` separately from a main-thread `runtime`
snapshot, without creating/showing the panel. `panel set --stdin` partially updates
only the appearance/position fields listed in help. `resetPosition:true` resets
placement and takes precedence over `dock` in the same update. Other fields remain
unchanged. For example, with `CLC_APP` set to the installed executable:

```sh
"$CLC_APP" cli subscriptions get
printf '%s' '{"dock":"top","size":"large","ends":"round"}' | "$CLC_APP" cli panel set --stdin
"$CLC_APP" cli panel get
"$CLC_APP" cli subscriptions open codex
```

A panel write reports `saved:true` and `application`: `saved` when there is no
native panel (including unsupported platforms), `deferred` while a gesture/menu
owns it, or `controller-applied`. These are not rendering acknowledgements.
Runtime distinguishes `not-created`, `hidden`, `visible` and `unsupported`; absent
panels have no invented frame. `expanded` is the controller target, and
`acceptedGeometry.matches` means only that matching geometry was received.
Frames use AppKit screen points with a bottom-left origin. Read again to observe
later state; there is no animation barrier or simulated input. Windows can save
preferences but reports unsupported native runtime. An unavailable target fails
without starting a core; a timed-out desktop write requires readback before retry.
The same local authentication, instance check and update-install write guard apply.

## Configuration examples

The following are configuration shapes, not real credentials. Replace secret fields through secure stdin input. Each represents a separate entry sharing the same Core and task IDs.

ChatGPT uses the official identity system:

```json
{"id":"chatgpt","name":"ChatGPT","controlSource":"chatgpt","transport":"openai-tunnel","auth":"openai","config":{"tunnelId":"tunnel_example","apiKey":"FROM_SECURE_LOCAL_SOURCE"}}
```

Obtain the Tunnel identity and runtime key through the official Platform flow and associate it with the intended workspace. Use the client's supported Tunnel connection UI. Personal sign-in, permissions, CAPTCHA and identity authorization remain user actions; do not bypass them.

Notion-labelled MCP access via an ngrok-assigned endpoint:

```json
{"id":"notion","controlSource":"notion","transport":"https","auth":"bearer","bearerToken":"FROM_SECURE_LOCAL_SOURCE_32_PLUS_CHARS","config":{"httpsProvider":"ngrok","ngrokAuthtoken":"FROM_SECURE_LOCAL_SOURCE"}}
```

Cursor MCP access via Cloudflare Fixed:

```json
{"id":"cursor","controlSource":"cursor","transport":"https","auth":"bearer","bearerToken":"FROM_ANOTHER_SECURE_LOCAL_SOURCE_32_PLUS_CHARS","config":{"httpsProvider":"cloudflare","cloudflareMode":"named","httpsUrl":"https://connector.example.com/mcp","httpsPort":8788,"cloudflareToken":"FROM_SECURE_LOCAL_SOURCE"}}
```

Set that Cloudflare tunnel's service route to `http://127.0.0.1:8788`. Each Fixed ingress needs its own route/port and Tunnel identity; do not reuse an identity to load-balance incompatible authentication contexts. Cloudflare stores remote-managed routing on its server; CLC does not change it with a Tunnel token. See [official routing setup](https://developers.cloudflare.com/tunnel/get-started/).

For Quick Tunnel use cloudflareMode quick, without a fixed URL or provider token. Use it for temporary trials. Prefer fixed addresses plus authentication for long-lived clients supporting static bearer. For Custom Domain use httpsProvider custom, httpsUrl, httpsHost and httpsPort, and configure the TLS reverse proxy separately. The listener is HTTP behind TLS termination; never expose the desktop management listener.

See the [control source matrix](control-sources.md) before choosing auth. Slackbot does not accept this static Bearer setup; use OAuth with dynamic or locally preregistered clients and local app consent via clc:// or authenticated CLI consent. Claude organization request-header beta and Copilot Studio API-key Header remain conditional Bearer paths; OAuth is a separate option. Never silently downgrade authentication. `ingress presets` exposes these boundaries offline; do not mistake a local probe for official client acceptance.

## Complete an authorized setup

For “add a Notion ngrok + bearer ingress”: inspect ingress list; preserve existing entries; prepare a protected bearer secret and the user's ngrok credential; add through stdin; start that id; poll its doctor until ready; read its public URL; securely configure the supported MCP client. Do not silently select a temporary URL if long-term use was requested. Report provider account/endpoint limits explicitly if startup fails.

Run `ingress verify <id> --fresh`. Call connector_verify with that code from the actual control source and read back that entry's challengeVerifiedAt, ingressId and controlSource. A successful local probe proves local transport only. Ordinary tools update historical verifiedAt but cannot satisfy a fresh challenge. Verification on another ingress must not count. Resume interrupted setup using the existing code rather than generating another one.

For full execution acceptance, create a harmless task through that source, using a unique UUID requestId and a prompt that uses no tools and only replies CLC_ONBOARDING_OK. Read the persistent receipt and taskId/threadId, then agent_wait/codex_wait and the terminal output. Unknown results require readback with the original requestId, never a fresh write. To check shared task namespace, read/send/wait the same task through another permitted ingress. Stopping an ingress must not stop Pi/ACP or Desktop tasks.

In a supplied authenticated browser, use visible supported controls to configure the connection and refresh tools; prefer the in-app Browser unless a browser was specified. Do not extract cookies or use private platform APIs. If client sign-in or authorization is required, complete independent local work and identify the precise remaining client-side action.

## Boundaries

No-auth allows any reachable caller to invoke allowed tools. Bearer authenticates possession, not a person. Namespace is globally shared; no task/user RBAC exists. OAuth supports PKCE, DCR or preregistration, local app consent via clc:// or authenticated CLI consent, refresh and revocation; see [OAuth authentication](oauth.md). Slack Identity and service-specific APIs are outside this implementation. Local listener request processing permits 300-second waits; external proxies and provider plans may impose shorter limits, which require their own verification/configuration. Shorter waits can be repeated with the same task ID; timeout never stops a task.

An ingress failure is local to that entry. Read its error and redacted logs before changing configuration. App shutdown closes ingress resources, then AgentHost and Control; ordinary disconnect does not. The home page shows a running count and one line per entry. Credentials, policies and provider details primarily belong in the CLI.

## Monitoring tasks

After create/send, obtain the original taskId/threadId and turnId from the receipt. Codex should call agent_wait/codex_wait in 20–30-second slices (default timeoutMs=30000): on timeout, keep the same IDs and pass the previous snapshotHash as expectedHash to the next wait, until completed/failed/cancelled or interaction-required. Do not recreate a task or resend its prompt after timeout. Timeout or cancelling a wait only ends that wait; unconfirmed is not task failure. expectedHash controls changed comparison, never suppressing terminal or interaction results.

This is bounded event-driven long polling: each slice uses event wakeups and fresh owner-state checks, not repeated read/sleep polling. ChatGPT, Notion, Slack and other MCP clients may impose different outer tool-call timeouts. Use the shared 30-second default; ordinary Chat and general MCP clients should not block for minutes by default. codex_wait caps timeoutMs at 90000 to leave remote gateway headroom; agent_wait still permits 300000 when the upstream client supports it; the OpenAI Tunnel stdio adapter retains a 330-second forwarding budget and HTTPS MCP does not impose a shorter execution deadline. CLC cannot extend external client/proxy timeouts.

## Read-only context and diagnostics

`cli context --stdin` accepts the same JSON as `agent_context`, for example `{"agent":"pi","taskId":"<existing-task-id>","view":"handoff"}`. It uses the authenticated local management channel, returns the existing JSON envelope, and does not write a file or create/resume a task. The running app must contain this command's implementation.

`status`, `doctor`, `ingress doctor <id>` and `onboarding` include shared structured `diagnostics.findings` with stable codes, scoped targets and suggested user actions. `checks.execution.state=not_checked` distinguishes missing execution evidence from failure; the legacy `executionVerified:false` alone is not a failed check. Transport ready, authentication configured, inbound verified and execution proof are separate observations. Remote-client state remains unknown without evidence. Diagnostics do not restart, rotate credentials or replay an unknown write; read its original requestId first.

Global diagnostics reuse existing Codex task receipt reads and point unconfirmed writes back to their original requestId. This receipt check does not cover other Agent drivers.

## Agent administration

UI, CLI and local management MCP use the same Core/Desktop operations. Run
`cli capabilities` for the complete operation catalog, configuration descriptors
and preference defaults; `cli schema <operation>` returns its input schema.
`cli call <operation> --stdin` accepts that JSON object. Resource identifiers are
outside `body`; operation parameters are inside `body`. For example:

```sh
printf '%s' '{"id":"my-ingress"}' | "$CLC_APP" cli call ingress.restart --stdin
printf '%s' '{"body":{"ingressId":"my-ingress","level":"ERROR","limit":100}}' | "$CLC_APP" cli call logs.query --stdin
printf '%s' '{"body":{"ingressId":"my-ingress","state":"ready","timeoutMs":30000}}' | "$CLC_APP" cli call state.wait --stdin
```

Launch `<app executable> cli mcp` as a local stdio MCP server. Its
`connector_capabilities` and `connector_call` tools use this same catalog.
Administrative access is local OS-user authority; it is deliberately not added
to public ingress `toolPolicy: all`. Existing public MCP execution tools retain
per-ingress authorization. No browser or management-token extraction is needed.

The catalog includes Agent enablement, task approvals/settings, subscriptions,
network, panel, appearance, autostart, preferences, ingress drafts/OAuth,
provider probes, update check/download/install/cancel/status and app lifecycle.
`app.start` works with the app closed; `app.quit` and `app.restart` return acceptance,
so read back `app.status`/`health` to confirm the new process and build.
Platform-specific operations report unsupported instead of simulating success.
Updates use the existing signed updater; its status includes progress and last
check. A successful download is not an installed upgrade.

`operations.submit` accepts an operation, arguments and unique `requestId` for
long-running writes. `operations.get` reads its durable receipt. Reusing the same
ID and input never replays; a different input conflicts. An interrupted write is
`unconfirmed`, requiring resource readback. Receipt files do not retain returned
secrets; call token rotation/registration synchronously and capture stdout to a
protected local file.

`logs.query` returns objects, cursor, retention bounds, `hasMore` and `gap`.
Without a time range or cursor it starts at the recent tail; specify `since` or
`until` to page retained history forward. Keep its cursor and filters while paging;
a gap means the cursor is no longer
retained. `cli logs --follow` emits JSON lines; `cli logs --offline` reads retained
disk logs even when Core is unavailable. Redirect stdout to export.
`cli watch` and `state.wait` provide resumable current-state snapshots: unchanged
state waits up to 30 seconds. A timeout does not cancel or recreate an operation.
Use logs for retained transitions, not snapshot cursors as an event archive.

`ingress.probe` separates DNS/edge discovery, provider readiness, public TLS/HTTP,
OAuth metadata and execution evidence. HTTP 401 means authentication is needed;
it is not a transport outage or proof of a completed OAuth login. Cloudflare
Fake-IP DNS can collapse its edge pool; exclude its edge discovery domains from
Fake-IP rewriting in the DNS owner. The managed provider refreshes edge discovery
by restarting after sustained failure, with a 60–300 second backoff, and records
transitions rather than healthy polling.

## Claude cloud follow-ups

`codex_create` and `codex_send` accept `notifyClaudeSession`, a Claude Code cloud session ID (`session_…`, `cse_…`) or `claude.ai/code/<id>` URL. Use the dispatching Claude session's ID. The local Claude CLI must already be signed in with `claude auth login`.

CLC binds the accepted thread and turn, independently observes it with the Codex waiter, and sends a fixed Chinese message containing only the project directory name, thread ID, turn ID, and status (completed, failed, interrupted, awaiting approval or awaiting input). No task output, error text, approval command or custom message is sent. An interaction notification does not stop observation; a terminal notification follows once. The immediately following turn inherits an interrupted turn's binding, including a continuation started in Desktop. Explicit bindings or `notifyClaudeSession: null` unbindings take precedence. Other new turns remain unbound. Steering the same turn preserves its binding when the parameter is omitted; an explicit session replaces the target while preserving deduplication history.

`codex_read` includes `turns[].claudeNotification` with `sessionId` and `deliveries` (`state`, `status`); unbound turns return null. Use the normal read rather than `statusOnly` to retrieve turn details. Delivery status is `sending`, `delivered`, or `failed`.

Bindings and deduplication records are private JSON files in `claude-notifications/` under the CLC state directory (`CLC_STATE_DIR` overrides it). Each filename hashes the thread/turn pair. The observer resumes on Core startup. CLI discovery reuses the agent executable search, including PATH, user-local installations, Homebrew and npm/version-manager locations. Delivery uses argument arrays with a 30-second timeout. Only `ok:true` with the matching session ID confirms delivery. Failed or uncertain attempts trigger a macOS system notification and are never retried. An interrupted in-flight delivery is marked failed on restart; this favors avoiding duplicate messages over guaranteed delivery. macOS notification permissions and system notification settings still apply. Other platforms retain the failed delivery status but have no system-notification fallback.

Binding failure does not fail an already dispatched task: the receipt includes `claudeNotification: "bind-failed"` and `claudeNotificationError`, and a WARN includes the reason. Delivery failures log the thread/turn and CLI failure reason locally without adding it to the notification message. Records expire seven days after creation, regardless of terminal state; expiration deletes the record and stops observation. CLI delivery and system notifications run outside the binding lock.
