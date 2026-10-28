# Acceptance

[Development](development.md) · [CLI contracts](../reference/cli.md)

## Scope: fixtures first

UI/UX acceptance (layout, visual states, copy, light/dark, widths, panel and task interactions) MUST run on browser fixtures only: `npm run accept:ui -- --scenario=<name>` or `dev:ui` with `?scenario=`. It MUST NOT start `dev:isolated`, build packages or touch the installed app. A state without a fixture gets a new or extended fixture; it is not a reason to fall back to a running app. Remaining experience and visual polish is found by the user through real use after delivery, so acceptance favors early delivery over exhaustive runtime checks.

Isolated-instance runtime acceptance is reserved for behavior fixtures cannot simulate: native windows and focus, the replacement/update lifecycle, real Agent dispatch and resume, and notification delivery. Keep it to the scenarios the change affects.

## Focus policy

Acceptance MUST default to background operation. Development and isolated desktops start with visible, unfocused windows and do not activate the macOS app. Packaged acceptance fixtures MUST use the existing development bundle identifier, `com.whzxc.agent-remote-control.dev`, so both initial launch and replacement restart stay in the background. Explicit deep links, tray actions, OAuth, and permission flows still focus normally. Installed production startup is unchanged.

Steps that require keyboard shortcuts or focus-dependent behavior MUST first use `screen` with `front=auto`. It yields to user input within the last 60 seconds and restores the previous app after temporary activation. On `FOREGROUND_REQUIRED`, wait for at most three minutes before retrying. If the error persists, or avoiding focus would require many retries or contorted workarounds, use `front=always`. This bypasses the inactivity gate and restores the previous app afterwards. The acceptance report MUST name the step and the reason for using `front=always`. Explicit `raise` requests foreground activation rather than temporary focus.

## Instance environment

Acceptance MUST never modify host system settings. This includes accessibility,
appearance, language, date/time, network, notifications and privacy permissions.
Use `app_env` through the local CLI or the existing `act` tool. If ARC cannot vary
an input at its app/AX layer, report an acceptance gap. Do not open System Settings
or use OS configuration commands to work around the gap.

Overrides work in installed and isolated instances and are off by default. Target
the isolated instance with `cli --state-dir <absolute-directory>` before the command.
Never target the installed instance accidentally. The operation is not a Settings
UI preference and does not write exported preferences.

```sh
arc cli control app_env
printf '%s' '{"action":"set","ttlMs":900000,"reducedMotion":true,"colorScheme":"dark","locale":"zh-CN","windowWidth":320,"taskPanelWidth":320,"presence":"present","clock":{"freeze":true}}' | arc cli control app_env --stdin
printf '%s' '{"modelOnly":true}' | arc cli app snapshot --stdin
printf '%s' '{"action":"set","clock":{"advanceMs":15000}}' | arc cli control app_env --stdin
printf '%s' '{"action":"set","clock":{"speed":10}}' | arc cli control app_env --stdin
printf '%s' '{"action":"clear"}' | arc cli control app_env --stdin
```

`act({op:"app_env",args:{action:"read"}})` reads the same state. `set` merges supplied
fields and renews the real-time TTL: 15 minutes by default, at most one hour. Set
`presence:"absent"` to route immediately or `presence:"follow-system"` to resume
focus/visibility heartbeats. Presence applies to all routable requests in the
selected instance; verified notification paths and first-answer-wins still apply.
Freeze before creating a request when testing the complete countdown. Advancing
is not replay-safe; read back after an uncertain result before another advance.

The renderer observes changes within its 500 ms polling cadence. `app snapshot`
refreshes overrides before reading the model. Wait for `model.layoutSettled` and
inspect `model.env`: every field reports `value` and `source:system|override`.
Here `system` means normal application preference/OS resolution. Widths report
observed logical pixels in `value` and the override in `requested`; a closed task
panel has a null observed width. Viewport constraints can clamp a panel width.
Use a wider window when the task panel itself must measure 320 px. Overrides are
marked by `active`, `expiresAt` and `app_env` diagnostic logs.

Always clear overrides after acceptance. TTL uses real time even when the virtual
clock is frozen. Expired values are ignored and removed on the next read. Width
restoration retains the pre-override baseline across renderer/process restarts so
a temporary width saved by the window-state plugin is restored on the next UI
synchronization. Clear/expiry restores ordinary appearance and language without
changing saved preferences. Leaving an overridden clock cancels its remaining
routing delays; pause is never permission to answer a request.

The virtual clock covers request-routing delays, conversation/timeline/bubble
relative times, quota reset/pace displays, Relay last-seen labels and dispatch
"today" counts. It does not change native Codex time, provider/security expiry,
network polling/retries, updater/replacement lifecycle, persisted activity read
retention, animation durations, tooltip delays or copied-feedback durations.
Timezone/DST boundaries, notification delivery, OS permission prompts, real offline
behavior and native lifecycle timing still require separately authorized conditions or a reported
gap; acceptance never changes host settings to manufacture them.

## Local replacement

Use the [local app replacement protocol](../reference/app-replacement.md) for an authorized installed-build upgrade. Run the candidate Core's `cli app replace <bundle> --check` first, then `cli app replace <bundle> --now` as the dispatching turn's final command for an explicit user-directed installation. Omit `--now` when idle waiting and a restart countdown are desired. Do not call `app quit` before it. Reconnect from the control source and read `app replace --status`, `app status`, and `status`; compare Desktop/Core build hashes and then perform the requested connection or provider acceptance. A staged receipt or successful package check alone is not installed-app acceptance. Build-only or no-restart tasks must stop before the mutating replacement command.

For offline CLI regressions against a freshly built Core, run `npm run check:tests`, then `ARC_TEST_BINARY="/absolute/path/to/arc" node --test tests/app-replace.test.ts`. These tests use temporary state and do not launch or stop Desktop. The Rust `app_replace` regression covers the active-turn, active-command, pending-interaction, and unknown-observation drain decisions.

## UI scenarios

```sh
npm ci
npx playwright install chromium
npm run accept:ui
```

The script starts an isolated Vite page and captures widths 640 and 1280 at height 800. Stop the existing development service first if it owns port 5187. Scenario mode never connects to real Core. The script rejects all actual management API requests. For WebKit comparison:

```sh
npx playwright install webkit
npm run accept:ui -- --webkit
```

Artifacts live in `output/acceptance/ui/<timestamp>-<browser>/`:

- index.html compares current, previous, and pixel-diff images for all scenarios.
- report.json records missing baselines, changed pixels/ratios, and render errors.
- `<scenario>-<width>.png` / `.json` contain screenshots and live derived state.
- `*-before.png` / `*-diff.png` contain the prior baseline and pixel differences.

The first run creates a baseline. Later runs compare with the latest directory for the same browser. Changes require visual review and are not automatically defects. Render errors, unexpected real API requests, or missing scenario nodes cause nonzero exit. Git ignores baselines and reports.

Scenarios in tooling/acceptance/scenarios/*.json include idle, single-task, parallel-seven, approval, long-multilingual, narrow-tentacles, left-panel, right-panel, light, and dark. Left and right panels are captured separately under the product's single-panel rule. The `p3-*` scenarios cover source setup (including empty, local, and fixed-connection entry), standalone and stacked connection methods/configuration/ready, Welcome, and owned/joined Connection detail in both themes. Fixtures use `sourceSetup`, `connectionSetup`, `remoteLink`, and `relayProgress` to select real renderer states without contacting Core. Copy scenario JSON to change Agents, phases, text, themes, language, and panels without unit tests.

Task-detail fixtures use sanitized payloads matching `AgentTimeline` / `AgentInteraction` in `ui/types.ts`. Ownership follows `control::observe_ownership` and `claude_notify::ownership`; request routing follows `claude_notify::routing`. No fixture contains real task content or provider identities.

| Scenario | Target |
| --- | --- |
| `task-owner-connector` | Confirmed ARC ownership shows a static owner chip. |
| `task-owner-desktop` | Confirmed Desktop ownership shows a static owner chip. |
| `task-routing-deferred` | A 15-second countdown with pause and handoff controls. |
| `task-routing-paused` | Paused routing with resume and handoff controls. |
| `task-routing-routed` | Routed status without delay controls. |
| `task-routing-not-routable` | Next-check status without delay controls. |
| `task-turn-failed` | Native failed turn, Retry card, and empty footer. |
| `task-turn-interrupted` | Native cancelled turn, Resume card, and empty footer. |
| `task-long-question` | Long question with 16 described options; options scroll while Submit and routing stay pinned. |
| `task-long-approval` | Long native approval preview; preview scrolls while decision actions and routing stay pinned. |
| `task-wide-markdown` | Completed answer with a ten-column table and a long unwrapped code line; horizontal wheel stays in the hovered content. |

Task dialogs take their accessible name from the visible native task-title heading; returning to the Agent overview restores the Agent name.

At narrow panel widths, open the needs-you banner to inspect the capped bottom sheet in either long-input scenario.

Target one fixture with `npm run accept:ui -- --scenario=task-owner-desktop` from main. The runner uses browser fixtures and screenshots. A missing route fails readiness with its method and path in `scenario.missingRoutes` and `data-scenario-error`.

`task-states` covers all six execution states in the Agent panel. `dispatch-states` covers turn-bound historical results and separate submission states. `task-review-unavailable` keeps a completed execution readable while optional review retrieval fails.

`bubbles-origins` places direct and dispatched Codex tasks together, with running command/file phases and an unread completed task. Open any task to inspect the shared compact execution-spec pill and metadata chips.

For manual inspection, run npm run dev:ui and open `http://127.0.0.1:5187/?scenario=<scenario>`. Only Vite development loads scenarios. Release builds exclude fixture modules. Fixed time and reduced animation support layout comparison. These screenshots are the evidence for UI/UX acceptance; they do not cover real Agent or native-window behavior, which follows the runtime scope above.

## Notification reachability and guides

```sh
node tooling/acceptance/notifications.mjs
```

Acceptance uses temporary state, the MCP fixture, simulated native Agent processes, and a fake local Claude CLI. Every dispatch MUST use purpose:"self-test". It covers new targets, successful sends without acknowledgement, one-time acknowledgement/replay, restart persistence, handshake timeout, delivery failure/recovery, and wait branches for four dispatch receipts. Historical duration uses synthetic records. Timeout checks change only temporary-state deadlines. It checks source-specific schemas, guide indexes, and default dispatch_policy filtering. Output defaults to output/acceptance/notifications/ and accepts an output-directory argument. No real accounts or notification targets are used. Actual cloud receipt and acknowledgement need separate evidence.

## Dispatch decision view

```sh
node tooling/acceptance/dispatch-policy.mjs
```

This isolated MCP scenario checks decision/full views, criteria hash reuse and invalidation, grouped duration medians and outcomes, self-test exclusion, defaults and restrictions, shared quota references, stale timestamps, and inventory filtering. It seeds synthetic history and native responses without dispatching real work. Output defaults to output/acceptance/dispatch-policy/. An optional argument selects another output directory.

## Installed App snapshots

```sh
arc cli app start
arc cli app snapshot --out ./output/acceptance/manual
printf '%s' '{"width":1280,"height":800,"panel":{"kind":"agent","id":"codex"}}' | arc cli app snapshot --out ./output/acceptance/agent --stdin
```

Without a shim, use the bundled CLI's absolute path. macOS cli install-shim idempotently creates ~/.local/bin/arc and stops rather than overwriting another file. Inspect pathHint for noninteractive-shell PATH. Its zsh command may be copied when needed. Shell configuration is never changed automatically. The check starts `$SHELL -c` with a minimal system PATH to avoid inherited interactive additions. It does not prove a customized SSH environment.

macOS snapshots use WKWebView without Screen Recording permission. Output includes snapshot.png and view-model.json with absolute paths in the result. Omitted --out uses the target state directory's acceptance/<unique-id>/. Windows/Linux desktops can export rendered state but return NOT_SUPPORTED for PNG. Headless Linux has no WebView. layoutSettled is always boolean. Check png.ok and layoutSettled rather than assuming command success proves a complete image.

panel.kind is agent, source, or none. The first two require node id. Window size and panel selection persist in the App. State and screenshots are captured sequentially, so active tasks may change between them.

## Cross-device acceptance

The target needs a macOS App with acceptance commands, working Codex login, and noninteractive SSH access through the selected alias. The script first finds arc in PATH, then checks standard App locations.

```sh
node tooling/acceptance/remote.mjs --host <host>
node tooling/acceptance/remote.mjs --host <host> --project /path/to/project --out ./output/acceptance/remote-manual
```

The script starts App-managed Core through app start, reads doctor, dispatches a local-cli read-only self-test that replies only ARC_ACCEPTANCE_OK, waits for creation and terminal receipts, checks records/origin/activity, and captures the App. It starts no independent headless daemon. Target-side cli wait performs bounded waiting without host-side SSH polling loops. Per-request approval:bypass does not change global target settings.

Default output is output/acceptance/remote/<timestamp>/. Each step's CLI JSON, report.json, view-model.json, and snapshot.png share that directory. Failed assertions are defects. Missing CLI capability, connection failures, or tasks too fast to capture activity are evidenceGaps. Exit 0 means complete evidence, 1 means defects, and 2 means evidence gaps only.

Assertions match rendered tasks to the dispatch by threadId/taskId, confirm local-cli origin and layoutSettled:true, and require PNG luminance variance above 1 after compositing on white. Explicit mismatches are defects. Missing data or undecodable PNGs are evidence gaps. Task failure still triggers a screenshot attempt. Tasks and original target screenshots remain available through report IDs and paths.

## Self-test trace retention

Archiving ended self-test threads is optional. Acceptance is complete when the requested checks and evidence are complete; archival is not a completion step. Threads may remain available for later observation, and users may archive them periodically. When archival is chosen for explicitly selected threads, use `codex_archive` and follow its native owner and active-turn recovery guidance. Clear any injected acceptance faults before normal observation, whether or not the thread is archived.

## Control source and waiting

```sh
arc cli control guide
arc cli control guide codex_create
printf '%s' '{"prompt":"Do not call tools. Reply ARC_ACCEPTANCE_OK.","mode":"read-only","purpose":"self-test","notify":null}' | arc cli control codex_create --stdin
printf '%s' '{"threadId":"<thread-id>","turnId":"<turn-id>","until":"terminal"}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 60
arc cli wait --op status --until '/core/desktop/state=="ready"' --timeout 20
```

Multiple --until conditions are ANDed. JSON Pointer supports ==, !=, and exists. String comparison values need JSON double quotes. On timeout, read error.lastResult. Waiting never cancels or redispatches tasks. Read full parameters through cli schema and cli control guide <op>.

## Native update and replacement regression acceptance

Run `npm run accept:updates -- /path/to/verified-release-artifacts` on an Apple Silicon Mac with the normal package-signing prerequisites. The directory must contain a published `latest.json` and its signed macOS updater archive. The runner builds a debug package with a loopback-only updater fixture, verifies real signed download bytes, exercises concurrent checks/downloads and failure recovery, and replaces a disposable app with different Desktop/Core build fingerprints after interrupting its Desktop. It uses a private state directory and never installs the published payload or replaces the user's installed app.

The fixture build enables the upstream single-instance plugin's semver namespace at versions `0.0.0` and `0.0.1` so it can run alongside the installed app. This feature is limited to the acceptance build; product build configuration is unchanged. Successful runs remove the disposable app and state. Failed runs retain their temporary directory for diagnosis. Reports and build logs live under `output/acceptance/updates-*`.

For replacement-only lifecycle acceptance, build a signed disposable fixture with `ARC_BUILD_VERSION=0.0.0 npm run desktop:build -- --debug --features tauri-plugin-single-instance/semver --config <fixture-config.json>`. Set the fixture `identifier` to `com.whzxc.agent-remote-control.dev`. Set the fixture updater endpoint to `http://127.0.0.1:9/latest.json` and `dangerousInsecureTransportProtocol:true` to avoid public update checks. Then run `node tooling/acceptance/replacement.mjs <fixture.app>`. The runner requires version `0.0.0`, copies both candidate and target into temporary storage, and verifies normal countdown, immediate replacement, native notification submission, and rollback after deliberately invalidating only the disposable staged executable. Successful runs remove fixture data and backups; failures preserve evidence under the reported paths. Rebuild without the fixture version, feature or configuration before local installation.
