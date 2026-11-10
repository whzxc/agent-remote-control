# Desktop updates

MUST means a requirement. SHOULD means the default. MAY means an option.

The frontend uses the official `@tauri-apps/plugin-updater` `Update` resource. Tauri owns downloaded bytes, signature verification and platform installation. Download callbacks update the local UI directly. There is no update-status endpoint or polling protocol.

## Install

After download, the panel shows **Update and restart**. Clicking it pauses Desktop's Core client and closes Core through the still-running front door or authenticated private Core IPC. After Core exits, it holds the exclusive replacement lock and stops the front door, because the downloaded image may use a different protocol. It then calls `Update.install()` and invokes the official process plugin's `relaunch()`. Desktop remains paused while it owns the replacement path. Process exit releases the kernel lock. Normal startup restores connection intent from `desktop-session.json` whenever a new front door attaches. If preparation or installation fails, the lifecycle hook releases replacement ownership and resumes the installed Core, whose startup ensures a front door; the error stays in the panel.

`desktop:install` validates and stages the candidate, verifies its signature and archives the installed bundle before shutdown. It requests Desktop quit through the existing running endpoint, terminates Desktop and Core, and waits for both PIDs to exit. Only then does the candidate's `front-door-prepare --hold` acquire replacement ownership and stop an incompatible front door. A compatible front door remains running. The installer replaces the bundle, restores the previous bundle if the rename fails, releases replacement ownership and opens the runnable bundle. Preparation and replacement failures also release ownership and reopen the installed bundle. No failure after front-door shutdown leaves the former Core running without its front door.

Desktop/CLI automatic Core startup and `arc start` reuse a matching running Core through private IPC. They prepare an incompatible front door only when Core ownership is free; an active owner from another build requires its clients to close first. The compatibility check refuses to stop a front door under a live Core. Shared startup ownership prevents launch while an installer holds the replacement path. A live Core separately supervises front-door attachment, retries `ensure()` with a 250 ms to 8 s bounded exponential backoff, and restores remote intent for each new front-door generation.

Updates and restarts MUST preserve running Agent tasks. Codex execution stays in detached profile App Servers; Pi/ACP execution stays in detached task-host processes. Core disconnects from running turns and pending interactions, closes idle transports, and reattaches on startup. Quitting the final Core client uses the same policy. Task-host executables live in content-addressed state directories so installers can replace the application executable on Windows. Installation never waits for tasks, schedules a countdown or submits a continuation. A logged direct-stdio fallback lacks this continuity; see [transport limits](architecture.md#task-host-protocol-v1).

## Ownership

`ui/state/updates.ts` owns the Update resource, progress, check cadence, skip-version preference and basic operation exclusion. It releases superseded and skipped resources with `Update.close()`. Checks and downloads run at startup when due and hourly while the frontend is loaded. The existing main-window lifetime controller wakes an unloaded frontend invisibly at its hourly cadence. Pending updates keep their WebView alive until skipped, installed or Desktop exits.

`desktop/src/updates.rs` contains only Core lifecycle hooks and a proxy-aware check. ARC's per-scheme proxies, bypass rules and explicit direct mode require the Rust updater builder's client configuration. This check registers the official `Update` in the requesting WebView's resource table and returns its constructor metadata. Downloads and installation use the plugin commands directly. There is no ARC update-byte cache, custom progress event, update management API or download-cancellation channel.

The panel contains Release notes, official download progress, skip-version and the direct install action. Installation always requires the update button. Local builds use `desktop:install` from an independent terminal.

## Validation

Run `npm test` for the direct install-button regression and frozen tool schemas. Use `npm run accept:ui` with the `updates-*` fixtures for layout and states. `npm run accept:updates` builds two signed versions with a hidden local fixture WebView with a loopback feed. That fixture imports the production frontend controller and exercises the real official plugin commands, retryable errors, cached installation with the feed offline, Core shutdown and matching Desktop/Core fingerprints after restart. A synthetic ACP task holds a tool call across installation; the runner checks the same host PID, process creation token and Agent PID after restart, then releases the fixture and requires completion. It never replaces the installed production app.
