# Desktop updates

MUST means a requirement. SHOULD means the default. MAY means an option.

The frontend uses the official `@tauri-apps/plugin-updater` `Update` resource. Tauri owns downloaded bytes, signature verification and platform installation. Download callbacks update the local UI directly. There is no update-status endpoint or polling protocol.

## Install

After download, the panel shows **Update and restart**. Clicking it closes Core, calls `Update.install()`, and invokes the official process plugin's `relaunch()`. Normal startup restores connection intent from `desktop-session.json`. If installation fails, the Core lifecycle hook restores access and the error stays in the panel.

Updates and restarts MUST preserve running Agent tasks. Codex execution stays in detached profile App Servers; Pi/ACP execution stays in detached task-host processes. Core disconnects from running turns and pending interactions, closes idle transports, and reattaches on startup. Quitting the final Core client uses the same policy. Task-host executables live in content-addressed state directories so installers can replace the application executable on Windows. Installation never waits for tasks, schedules a countdown or submits a continuation. A logged direct-stdio fallback lacks this continuity; see [transport limits](architecture.md#task-host-protocol-v1).

## Ownership

`ui/state/updates.ts` owns the Update resource, progress, check cadence, skip-version preference and basic operation exclusion. It releases superseded and skipped resources with `Update.close()`. Checks and downloads run at startup when due and hourly while the frontend is loaded. The existing main-window lifetime controller wakes an unloaded frontend invisibly at its hourly cadence. Pending updates keep their WebView alive until skipped, installed or Desktop exits.

`desktop/src/updates.rs` contains only Core lifecycle hooks and a proxy-aware check. ARC's per-scheme proxies, bypass rules and explicit direct mode require the Rust updater builder's client configuration. This check registers the official `Update` in the requesting WebView's resource table and returns its constructor metadata. Downloads and installation use the plugin commands directly. There is no ARC update-byte cache, custom progress event, update management API or download-cancellation channel.

The panel contains Release notes, official download progress, skip-version and the direct install action. Installation always requires the update button. Local builds use `desktop:install` from an independent terminal.

## Validation

Run `npm test` for the direct install-button regression and frozen tool schemas. Use `npm run accept:ui` with the `updates-*` fixtures for layout and states. `npm run accept:updates` builds two signed versions with a hidden local fixture WebView with a loopback feed. That fixture imports the production frontend controller and exercises the real official plugin commands, retryable errors, cached installation with the feed offline, Core shutdown and matching Desktop/Core fingerprints after restart. A synthetic ACP task holds a tool call across installation; the runner checks the same host PID, process creation token and Agent PID after restart, then releases the fixture and requires completion. It never replaces the installed production app.
