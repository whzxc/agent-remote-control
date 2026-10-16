# Development and builds

## Everyday development

Use Node 24.12+, npm, stable Rust, and the macOS/Windows platform SDK. Node runs development tools only; it is not a product runtime dependency.

```sh
npm run dev
```

This starts Vite at `http://127.0.0.1:5187` and the complete Tauri development application, including its independently launched shared Rust Core, local API, connections, Agents, tray, and usage rail. The desktop WebView and browser use the same development backend. No installed build is required. React/CSS changes hot-reload; Desktop Rust changes incrementally compile and restart the development app. Core changes require restarting the command so its standalone executable is rebuilt. Connection sessions restore after an ordinary restart; in-flight tasks are subject to the normal process lifecycle.

Development shares the packaged app’s persistent data by default: `~/.local/state/chatgpt-local-connector` on macOS and `%LOCALAPPDATA%/chatgpt-local-connector` on Windows. Connections, settings, and records carry over in both directions. Close all entrypoints built from other native builds before starting development against that data. Identical builds can share Core; only one Connector Desktop can be active. `CLC_STATE_DIR` optionally selects another directory for both desktop and Vite. Automatic installation of release updates remains disabled in development.

`npm run dev:ui` starts only Vite against the same state directory; it needs an already running desktop backend. The proxy retains loopback, origin, credential, and write-header checks. Initial compilation or a Rust restart can briefly make the API unavailable; Retry reconnects after startup. Stop a standalone Vite instance on port 5187 before starting the full `npm run dev` command.

## Code layout

- `ui/`: React pages, state types, and interactions.
- `native/`: Rust core for Desktop IPC, auxiliary Codex RPC, AgentHost and Pi/ACP processes, the shared MCP catalog, receipts, events, configuration, and Tunnel lifecycle.
- `desktop/`: Tauri entry point, tray, windows, OS integration, and updates; connects to the shared Rust Core.
- `tooling/`: development/build scripts, excluded from runtime resources.
- `tests/`: contract tests against the Rust core with an isolated simulated upstream; the test-only feature is excluded from release builds.

The Desktop executable's `stdio` subcommand forwards remote-ingress MCP requests to Core. It receives a local port and random credential through its parent environment and exposes no public interface. Connection configuration and credentials are not stored in browser storage.

Its `cli` subcommand provides configuration and diagnostics through the existing authenticated local transport without starting a second service. `cli guide` embeds the English `docs/codex-setup.md` and ships with the app version. See that guide for command conventions.

## UI languages

`ui/i18n.ts` owns translation, named interpolation, browser/system language selection, and English fallback. The small stores in `ui/state/store.ts` expose immutable snapshots through React's `useSyncExternalStore`; preferences persist in localStorage and subscribe to storage events. `ui/locales/en.json` defines messages; `zh-CN.json` supplies Simplified Chinese. Missing or invalid language preferences select Auto; unsupported system/browser languages resolve to English. Manual choices take priority. WebView and browser previews have separate storage origins.

Use `t(key, params)` for display text, with whole messages and named placeholders. Derive labels during rendering and subscribe each renderer root to the resolved locale so switching language updates all visible text. Dates use the resolved locale; filters and protocol state retain stable identifiers. `ui/messages.ts` translates recognized CLC messages at the rendering boundary, including retained feedback and service errors. Unknown third-party diagnostics remain verbatim. Do not apply it to user task content, identifiers, or entire API responses.

The main and usage-rail WebViews share locale and theme preferences. The renderer also sends its resolved locale to `desktop/src/i18n.rs` for native rail menu labels. Native labels default to English until the WebView reports its preference. This state is presentation-only: the service, MCP schemas/descriptions, error codes, and Agent/Codex contracts never read it. Text copied into ChatGPT as a model instruction or connection description stays English regardless of UI language.

To add a language, add its JSON resource with matching keys/placeholders, register the locale, option and language matching in `ui/i18n.ts`, and extend the tray resource selection in `desktop/src/i18n.rs`. Missing translated keys fall back to English. Check both languages' rendered pages, long labels, Auto/manual switching, persisted and invalid preferences, dates, retained errors, and tray labels. README and the three core user guides have English canonical versions and corresponding `zh-CN` translations; link each translation to its source. No translation pipeline is required.

## Extending ACP Agents

Add descriptions to `native/src/agents/builtins.json` after verifying the official entry point, version requirements, authentication ownership, and limits. Built-ins and Custom manifests share `manifest.rs`. Static descriptions are not negotiated capabilities; do not duplicate Driver/wait logic by brand. Discovery rules can specify aliases with identical arguments, installation locations, version probes, and CLI help conditions. Different argument entry points need separate Custom manifests. Keep built-in IDs unique and update the Agents support matrix and existing tool/list expectations; do not add test files or cases.

For real calls, use an isolated `CLC_STATE_DIR` and temporary working directory with the currently compiled AgentHost/transport. An installed old backend does not validate current source. Run harmless tasks only with existing authentication; do not automatically sign in or change providers. Retain receipts and use agent_wait to verify output, continuation/resumption, cancellation, and safely triggered permission interactions. Report missing installation or authentication as verification limits. Keep temporary evidence outside the repository; documentation describes current support and scope.

## UI controls

`ui/tokens.css` defines semantic colors, typography, spacing, radii, and sizing. Standard controls are 36px high; compact icon controls are 32px. Text uses 13px/14px defaults and the operating system font stack. Shared components in `ui/components/ui/index.tsx` consume these tokens; Radix owns complex interaction behavior. `Group` and `Row` arrange settings without overriding control appearance. See [UI components](ui.md) for information hierarchy, focus, and responsive rules.

## Checks

```sh
npm run check
npm test
npm run check:native
npm run build
cargo build --manifest-path desktop/Cargo.toml
cargo fmt --manifest-path native/Cargo.toml -- --check
cargo fmt --manifest-path desktop/Cargo.toml -- --check
```

Rust is pinned in `rust-toolchain.toml`; CI uses the same version. Dev uses
incremental compilation and `opt-level=0` for our crates, line tables for backtraces,
and no dependency debug information. Only JSON, image and compression hotspots
use level 3; other dependencies remain unoptimized. Release keeps level 3, 16 codegen units and no
cross-crate LTO. Workspace profiles live in the root `Cargo.toml`.

Native, desktop, contract fixture and release verifier share one workspace, root
`Cargo.lock` and `target/`. The fixture is excluded from default members; its test-only
feature is enabled only when explicitly building the fixture. The local
compiler-cache budget is 30 GiB: `npm run cache:prune -- --dry-run` previews
inactive profile groups and `npm run cache:prune` removes them. Busy/protected
outputs may temporarily exceed it. Bundles, binaries and user data are retained,
so this is not a cap on all of `target/`. Run pruning after direct Cargo commands;
normal npm development/build/test entries already check the budget.

`target` may be symlinked to an external disk. To return to internal storage, stop builds, run `unlink target`, then move the directory back to the repository as `target`.

Desktop IPC task management supports macOS Unix sockets and Windows named pipes. Windows uses the installed Microsoft Store Codex Desktop.

## Release builds

```sh
npm run desktop:build
npm run check:package
```

`desktop:build` rebuilds the frontend before native packaging; a prior `dist/ui` directory is not reused. macOS installers target Apple Silicon (arm64) and are written to `target/aarch64-apple-darwin/release/bundle/`. macOS builds need `uv` to run a pinned dmgbuild version for the drag-to-install layout without text; build dependencies are excluded from the app. `check:package` checks for Node, npm, node_modules, and old runtime directories and reports size; it accepts another artifact directory. Windows builds use NSIS `.exe`. The Chinese installer uses `desktop/installer/installer.nsi` and `pages.nsh`: one-click installation, expandable path selection, and a launch action on completion. Existing installations keep their location and connection configuration. The template retains passive/silent updater flags and WebView2 setup; update it alongside the Tauri CLI when its bundler contract changes.

Packages contain the Desktop executable, standalone Core executable, frontend static resources, icons, and applicable third-party license notices. Build scripts remap local user/repository paths in Rust source to generic build paths, avoiding private paths in binaries. Official Tunnel Client is downloaded and verified separately on first use. Codex uses the binary bundled in the user's Desktop installation rather than packaging another copy. Building does not overwrite the installed app.

macOS app packaging requires full Xcode 26 or later, including `actool`; Command Line Tools alone are insufficient. Select Xcode with `DEVELOPER_DIR` or `xcode-select`. Tauri compiles `desktop/icons/LocalConnector.icon` into `Assets.car` and sets `CFBundleIconName` to `Icon`. `CFBundleIconFile` uses the same extensionless name, with `desktop/icons/macos/Icon.icns` as the static fallback; both names must stay aligned so AppKit and Finder resolve the same icon. The Icon Composer document contains a light sage gradient, the system dark background, and a separate opaque character layer. macOS 26 controls the background shape, lighting, and icon appearance across Dock, Finder, and application launchers, independently of the app's UI theme. Older macOS versions use the bundled static ICNS; Windows uses ICO. On macOS, `dev` derives a light blue background from the same Icon Composer document, preserving all other layers and appearance settings. Xcode compiles its catalog and static fallback, and the Cargo runner launches `Local Connector Dev.app` from the build directory with frontend and Rust hot reload intact. Both build commands use `DEVELOPER_DIR` when set, otherwise the standard `/Applications/Xcode.app` installation when available. Edit the native source in Icon Composer; its `Assets/head.png` is copied from `ui/assets/local-connector-head.png` and should be updated together when the artwork changes. `desktop:build` checks the compiler before building and validates the compiled icon catalog before generating the DMG.

Release versions come from Git tags. Build tools inject `CLC_BUILD_VERSION` into the UI, native executables and installer metadata; without an override, development uses the nearest reachable version tag (or `0.0.0` without tags). The npm/Cargo/Tauri source versions remain internal `0.0.0` placeholders. Releases do not create version commits or edit a source changelog. Update URLs and the project public key are fixed in `desktop/tauri.conf.json`; release builds need `TAURI_SIGNING_PRIVATE_KEY` outside the repository. See [release maintenance](release.md).

## Subscription development

`npm run dev:ui` renders the same usage rail component inside the browser
viewport when subscription monitoring has selected providers. Its position is
saved in browser local storage. Drag the capsule or a ring to move it; hover or
focus a ring to inspect quota details, and click it to open Agent quota details.
The browser adapter supplies viewport layout and pointer state; the desktop
and browser share the rail renderer, shapes, animations, and quota components.
Drag into a viewport edge zone to preview left/right/top/bottom docking; drag
back into the interior to restore the floating capsule. Docked rails collapse to a sliver after the pointer leaves and expand when the
pointer returns to the edge wake zone. Floating rails and active drags stay expanded. This browser-only interaction does not move or configure
the native panel. Native screen management and notch behavior require the desktop window.

The usage rail is built from `ui/usage-rail.html`. Desktop views receive
`subscriptions:changed` events; browser previews receive snapshots through the authenticated
`/api/subscriptions/events` SSE route, proxied by Vite. Each completed provider refresh
publishes independently. Browser reconnection follows the native backend owner; polling
is a fallback when the stream is unavailable. Local token scans run with quota refreshes,
not a continuous log watcher.

 Subscription snapshots expose
`rawUsage`, the original successful quota API response for each provider. Authentication
files, request headers, and tokens are not part of this payload. The core retains
normalized quota windows for scheduling, expiry, and native alerts; display-only
fields such as plan names and available resets are extracted by the shared frontend
adapter in `ui/subscriptions/response.ts`. Changing that extraction does not require
a new native build when the existing endpoint already supplies the data. Account
changes clear both the normalized reading and the raw response. New native routes need
a matching development backend; `npm run dev` rebuilds it with Rust changes.
Use `CLC_STATE_DIR` to select an isolated persistent directory for desktop and browser together.
Packaged-build checks use the existing Tauri build `--config` override and `--state-dir`; ordinary UI and backend development do not require packaging.


### Subscription sources and usage estimates

Cursor reads the desktop login from its local state database (or macOS Keychain), then
queries DashboardService GetPlanInfo and GetCurrentPeriodUsage. REST usage-summary is
a quota fallback. Free is a reported plan, not an inference from missing usage. Expired
Cursor credentials require refreshing the login in Cursor.

Antigravity discovers the running language server or agy CLI and reads quota summaries
over loopback. On macOS it can also use the existing gemini/antigravity Keychain OAuth
access token with Google Cloud Code. Token renewal is handled by Antigravity; CLC does
not bundle OAuth client credentials. If the token expires, open Antigravity and refresh
its login. Only loopback language-server TLS permits a self-signed
certificate; remote services retain certificate validation. Windows supports running
language-server discovery; closed-app Keychain fallback is macOS-only. Quota buckets
remain separate for Gemini and third-party models, with 5h and weekly windows. Legacy
model responses supply only 5h windows; missing fractions never become a full allowance.

Grok reads `/rest/grok/credits` using its existing native login and reads the reported
subscription tier from the CLI settings endpoint. Weekly and monthly periods follow
the upstream response; missing percentages remain unknown.

Quota-less successful responses retain their raw data so that plan names remain available.
Agent management groups Cursor subscription information with Cursor Agent, and Antigravity
subscription information with Gemini CLI. Execution keeps the original adapter identifiers.
Usage settings select which history periods appear in both the rail and detail panels.

Codex local rollout accounting, Antigravity conversation SQLite accounting, and Cursor's
token CSV export supply Today, Yesterday, Last 7 Days, and Last 30 Days (including today). Local sources describe this device's logs, not a complete current-account invoice.
Only token accounting is retained; prompts and responses are not exposed. Changed local
files are rescanned, bounded records are used, and skipped records mark estimates incomplete.
Codex child replay and duplicated rollout events are excluded.

Dollar values are API-equivalent USD estimates, not subscription charges. Input, cache
reads, cache writes, and output are priced separately; Codex priority and long-context
rules apply to individual requests. Unknown models retain token counts and mark the
estimate incomplete rather than receiving an invented price. Cursor CSV rows are
aggregated and therefore use base rates, without inferring per-request context tiers.
The bundled pricing snapshot and aliases derive from OpenUsage's MIT-licensed catalogs
(LiteLLM, models.dev, and its supplement); attribution is in shared/pricing/LICENSE.OpenUsage.
Prices load from bundled snapshots and the local cache, with background revalidation once
per hour. Failed sources retry after 30 minutes without replacing last-good prices. The
OpenUsage supplement takes precedence over LiteLLM, which takes precedence over models.dev.
Conditional requests use ETags; bounded downloads follow the application network proxy.
The next usage scan reprices cached token events using a consistent price snapshot; the
price data timestamp is returned alongside history. No credentials or usage records are
sent to pricing feeds.

Quota bubbles project consumption from the elapsed reset window and used quota.
Projection starts after at least 60 seconds or 1% of the window; near-empty meters
(under 5% used) suppress unstable over-limit warnings. An even-pace tick follows
the Used/Remaining display mode, and the warning respects countdown/absolute time.
Expired or stale readings do not produce pace forecasts. Cursor uses reported billing
cycle dates when available; monthly windows otherwise use the same 30-day convention
as OpenUsage.

Plugin sources, development servers and packaging are owned by the independent [Usage](https://github.com/whzxc/chatgpt-usage-plugin) and [Kanban](https://github.com/whzxc/chatgpt-kanban-plugin) repositories. Connector builds no plugin resources or ZIPs.
