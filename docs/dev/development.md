# Development

[Architecture](architecture.md) · [UI](ui.md) · [Design sources](design.md) · [Release](release.md) · [Acceptance](acceptance.md)

## Local development

Use Node.js 24.12+ and the Go version in `go.mod`. Install dependencies with `npm ci`. macOS packaging requires full Xcode 26+ and `uv`. Windows installer packaging requires NSIS 3 with `makensis` on PATH or `ARC_MAKENSIS` set to its executable.

```sh
npm run dev
ARC_DEV_PORT=5190 npm run dev:isolated
npm run dev:ui
```

`dev` builds and starts the MyGo development Desktop and Core inside `tmp/arc-godev-home`. It watches Go and native resource inputs and starts a new generation after a successful build. Vite stays up and reconnects to the replacement Core. Ctrl+C stops the development Desktop and releases its Core. `dev:isolated` creates a fresh development home, state directory, bundle identifier and test URL scheme. Use the emitted state path and bundle ID to address the running instance. Use `--directory /absolute/evidence` to retain an isolated run under an existing evidence directory.

`dev:ui` starts DEV WEB only. It connects to a running Core from the state selected by `ARC_STATE_DIR`, or the installed default. `ARC_DEV_PORT` defaults to 5187. The Vite proxy accepts requests from the exact configured loopback host and origin and checks the registered Core's identity with a bounded health probe.

## Build and checks

```sh
npm run check
npm run check:go-format
npm run check:native
npm test
npm run test:extended
npm run build
```

`build` compiles Vite and embeds its browser entry point and assets in the CGO-free Go Core. The standalone executable is `dist/native/arc` or `dist/native/arc.exe`. Use `-- --target=GOOS/GOARCH` for a cross build. `desktop:prepare` stages the Vite output in `dist/ui` and prepares the Go embed inputs. `check:native` and `desktop:check` run Go formatting and vet across the platform-selected packages with the default and `arcfixture` tag sets.

`check` validates React and TypeScript. `npm test` runs the daily Node tests and policy checks within 30 seconds. `test:extended` adds both Go tag sets and native integration tests against standalone Core and the tagged contract fixture. See [Testing](testing.md) for a targeted native test command and [Acceptance](acceptance.md) for fixture coverage.

Go uses its shared compiler and module caches. `npm run cache:prune` reports the effective build-cache path and its size against the 30 GiB budget. Run it with `-- --apply` while other Go builds are idle to clear an over-budget build and test cache using `go clean`. Module downloads and packaged artifacts have their own lifecycles.

## Design sources

Use the globally installed `adg` CLI, version 0.14.1 or later:

```sh
adg check
adg render
adg open design --port=4311
```

Choose an unused viewer port other than 4310. The viewer opens independently of desktop development. Visual changes start in `design/`. [Design sources](design.md) owns ARC's governance and visual direction; [Asset mapping and status](design-assets.md) owns implementation and fixture mappings. Follow the [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md) and [toolkit contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md).

## Desktop artifacts

```sh
npm run desktop:build
npm run check:package
```

MyGo embeds the desktop frontend and packages the platform's signed bundle or Windows payload. Core, the macOS screen helper and source metadata are staged through `dist/mygo-input/bin`. Desktop packages live under `dist/desktop/<version>/<target>` for `darwin-arm64` and `windows-amd64`. Use `--output /absolute/directory` to choose another parent. The macOS directory contains `Agent Remote Control.app` and the DMG. The Windows directory contains the files installed by the NSIS EXE. `--development --no-image` builds an isolated identity for development. Production macOS packages use the configured code-signing certificate. `--adhoc` makes a local rehearsal package.

Install an authorized local build from an independent terminal:

```sh
npm run desktop:install -- "dist/desktop/X.Y.Z/darwin-arm64/Agent Remote Control.app"
```

The macOS installer validates the app, backs up the installed bundle, stops its Desktop and Core, replaces the bundle, and checks restarted Core readiness. `--test-destination /absolute/arc-godev-home/Name.app` exercises the same replacement and backup with a development bundle in a temporary home. It leaves the temporary app stopped for inspection.

Version precedence is `ARC_BUILD_VERSION`, nearest reachable v-tag, then 0.0.0. Go linker flags inject the version into Core and Desktop. Vite, MyGo metadata, and NSIS receive the same version.

## Native icons and branding

assets/brand owns brand source artwork. npm run brand -- primary generates uniform-stroke round-ended arcs. alternate generates the tapered alternative. All platform icons derive from these sources.

macOS uses an Icon Composer document, actool Assets.car, and a static ICNS fallback. CFBundleIconName and CFBundleIconFile share one extensionless name. DEVELOPER_DIR may select full Xcode. Standard Xcode installation is also supported. Development icons derive from the same layered source rather than a separate design.

## Subscription quota development

Core owns quota reads, refresh scheduling, and reading caches. React shares QuotaBubble, AgentIcon, and hover details. Desktop receives subscriptions:changed. Production browser clients receive snapshots through authenticated /api/subscriptions/events; disconnected streams follow the current owner again. DEV WEB uses the existing read endpoints instead of EventSource so concurrent previews cannot exhaust the browser's HTTP/1 connection pool. Connector state and visible Agent activity poll every two seconds; visible subscription state polls every thirty seconds. Native Desktop keeps its event delivery. The preview trades push immediacy for bounded polling latency without reserving persistent HTTP slots.

[Subscriptions](../reference/subscriptions.md) owns source, cache, and cadence rules. Verify native login, desktop events, and browser streams separately. Do not collect local usage logs, token statistics, or pricing data.

## Documentation maintenance

README and end-user onboarding/guides retain English primary files with complete Chinese counterparts. docs/reference and docs/dev are English only. Model-facing guides, catalog text, hints, errors, and generated notification text are English only. Original user input and upstream evidence retain their language. Use [terminology](terminology.md).

cli guide embeds docs/reference/cli.md. Path changes require a Core rebuild. Documentation describes current behavior, limitations, and procedures without acceptance records or personal environments. Check internal links, CLI output, and localized counterparts after edits. Commits use a single-line English Conventional Commit subject without rewriting history.

## Runtime state

On macOS and Linux the default state directory is `~/.agent-remote-control`. Windows retains its local application-data directory. `ARC_STATE_DIR` selects an explicit instance. Existing installations must be stopped before moving their state to the new default; preserve credentials, configuration and task associations, and update absolute paths in owned configuration before restarting. Native Agent sessions remain in their native homes. Startup does not implicitly migrate or delete state.

Development and acceptance temporary state stays under checkout `tmp/`; isolated instance state is retained there for inspection. The test runner redirects OS temporary files into `tmp/tests/` and bounds Git parent discovery to that directory. Heavy-build coordination uses the common Git directory, shared by all lanes. Native runtime data and signing credentials keep their separate locations.
