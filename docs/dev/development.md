# Development

[Architecture](architecture.md) · [UI](ui.md) · [Release](release.md) · [Acceptance](acceptance.md)

## Local development

Use Node.js 24.12+ and Rust. Install dependencies with npm ci.

```sh
npm run dev
```

Development uses the installed data directory. The launcher builds Core and Desktop before quitting the installed Desktop through its authenticated management API. It waits for Core to exit and release its state lock before starting the development build. Configuration, source identities, history, and connection state stay in place. Development writes affect installed data.

The supervisor watches native and desktop sources, embedded native resources, Cargo manifests, and desktop configuration. A successful build restarts development Desktop and Core together. Compile failures leave the current build running. Vite stays available across Core restarts, and DEV WEB reconnects to the new owner automatically. Saving another source change retries a failed build. Core persists explicit connection intent before starting or stopping an ingress. Interrupted and failed startup attempts remain scheduled for restoration on the next launch. Quitting development Desktop or pressing Ctrl+C stops development and restores the installed Desktop if it was running before takeover.

```sh
npm run dev:ui
```

This starts only DEV WEB at `http://127.0.0.1:5187/`. It uses installed data and connects to the running Core. It never starts, stops, or builds Core. Start the installed App first. An existing DEV WEB from the same checkout and state directory can remain open when `npm run dev` takes over.

Concurrent DEV WEB requests share an in-flight health probe for the same Core owner. A probe waits up to two seconds and reports missing ownership, timeout, identity change, or HTTP failure separately. Desktop checks the Core state lock before attempting recovery after a failed probe. A slow Core is not treated as permission to launch another owner. Development has the same control-source support as installed builds. Grok and Grok Bot share their configured ingress.

Both commands honor an explicit ARC_STATE_DIR for temporary acceptance instances. There is no separate default development data directory. Do not manually launch a development binary against an active installed instance. The supervisor preserves the single-Core lock and build-identity checks. Other local CLI/MCP clients must release Core before takeover or restart; the launcher reports an actionable error instead of terminating those clients. Core restarts temporarily interrupt connections and ARC-owned execution processes.

Set `ARC_DEV_PORT` to an unused integer from 1 to 65535 to keep an existing DEV WEB running while using a separate development instance. The default is 5187. The native development URL, its content security policy, and Vite use the selected port together. DEV WEB accepts API requests only for that exact loopback host and origin.

```sh
ARC_DEV_PORT=5190 npm run dev:isolated
```

`dev:isolated` allocates a new temporary state directory and unique development app identity. Use the emitted `stateDirectory` and `bundleId` to address its CLI and native window. It does not replace the installed app or reuse installed state. See [Acceptance](acceptance.md) for native acceptance and cleanup.

## Existing checks

```sh
npm run check
npm run check:format
npm run check:tests
npm test
npm run build
npm run desktop:check
```

check validates React/TypeScript. check:format validates Rust formatting. test first enforces test policy, then runs Rust and Node tests with isolated temporary state. build compiles the frontend, Core, and applicable screen helper. desktop:check checks the desktop crate. Tests must be tagged Contract, Regression or Property and assert public behavior. Rewrite or delete change detectors instead of updating implementation snapshots. The control source owns contract tests and policy exceptions. See [Testing](testing.md) for enforcement and monthly mutation/churn audits. Visual and layout checks belong to accept:ui scenarios. See [Acceptance](acceptance.md) for scenarios, cross-device checks, and artifact inspection.

After direct Cargo builds or tests:

```sh
npm run cache:prune
```

The workspace shares root Cargo.lock and target. The compilation-cache budget is 30 GiB. Pruning removes inactive profile groups while retaining running/protected artifacts and unique data. Preview with npm run cache:prune -- --dry-run. The budget is not a total-size cap for target.

## Desktop artifacts

```sh
npm run desktop:build
npm run check:package
```

Build recompiles the frontend and creates native packages without installing or replacing the local App. macOS artifacts live under target/aarch64-apple-darwin/release/bundle. Windows uses x64 NSIS. check:package validates versions, native signatures, and icon assets, rejecting legacy Node/npm runtime resources. See [Release](release.md) for signing and publication.

Packages contain Desktop, standalone Core, static frontend, icons, and licenses. Tunnel Client is prepared on demand from official sources. External Agents use native installations. The Claude ACP adapter is prepared separately after explicit enablement. Build scripts remap Rust source paths to avoid embedding maintainer paths.

Packaged production-identity builds support automatic updates even when built with the debug profile. The separate development bundle identity does not install production updates.

For a fast signed local macOS package, use `npm run desktop:build -- --debug`. This builds without installing. Desktop, Core, and the screen helper use the required packaging certificate regardless of the Rust profile. Missing or conflicting signing identities fail before compilation. Check the bundle under `target/aarch64-apple-darwin/debug/bundle/macos/Agent Remote Control.app`.

Install only when local replacement is authorized. From an ARC-dispatched task, use the candidate CLI so the first upgrade also works with an older installed Core:

```sh
NEW_APP="$PWD/target/aarch64-apple-darwin/debug/bundle/macos/Agent Remote Control.app"
"$NEW_APP/Contents/Resources/bin/arc" cli app replace "$NEW_APP" --check
"$NEW_APP/Contents/Resources/bin/arc" cli app replace "$NEW_APP" --now
```

Save the receipt and end the turn after the second command. Do not quit ARC first or launch an installer script with `nohup` through `command`. The native launchd helper stages and validates the package, keeps the latest backup outside Applications in ARC state and cleans recovered copies, skips idle waiting with --now, replaces it, and rolls back on startup failure. Query `arc cli app replace --status` from a new turn after reconnecting. See [Local app replacement](../reference/app-replacement.md) for the exact protocol and recovery limits.

Version precedence is ARC_BUILD_VERSION, nearest reachable v-tag, then 0.0.0. package.json, Cargo, and Tauri use 0.0.0 as an internal placeholder. Formal artifacts inject versions into existing feature commits without version-bump commits.

## Native icons and branding

assets/brand owns brand source artwork. npm run brand -- primary generates uniform-stroke round-ended arcs. alternate generates the tapered alternative. All platform icons derive from these sources.

macOS uses an Icon Composer document, actool Assets.car, and a static ICNS fallback. CFBundleIconName and CFBundleIconFile share one extensionless name. DEVELOPER_DIR may select full Xcode. Standard Xcode installation is also supported. Development icons derive from the same layered source rather than a separate design.

## Subscription quota development

Core owns quota reads, refresh scheduling, and reading caches. React shares QuotaBubble, QuotaRing, and hover details. Desktop receives subscriptions:changed. Production browser clients receive snapshots through authenticated /api/subscriptions/events; disconnected streams follow the current owner again. DEV WEB uses the existing read endpoints instead of EventSource so concurrent previews cannot exhaust the browser's HTTP/1 connection pool. Connector state and visible Agent activity poll every two seconds; visible subscription state polls every thirty seconds. Native Desktop keeps its event delivery. The preview trades push immediacy for bounded polling latency without reserving persistent HTTP slots.

[Subscriptions](../reference/subscriptions.md) owns source, cache, and cadence rules. Verify native login, desktop events, and browser streams separately. Do not collect local usage logs, token statistics, or pricing data.

## Documentation maintenance

README and end-user onboarding/guides retain English primary files with complete Chinese counterparts. docs/reference and docs/dev are English only. Model-facing guides, catalog text, hints, errors, and generated notification text are English only. Original user input and upstream evidence retain their language. Use [terminology](terminology.md).

cli guide embeds docs/reference/cli.md. Path changes require a Core rebuild. Documentation describes current behavior, limitations, and procedures without acceptance records or personal environments. Check internal links, CLI output, and localized counterparts after edits. Commits use a single-line English Conventional Commit subject without rewriting history.
