# Desktop updates

MUST means a requirement. SHOULD means the default. MAY means an option.

The frontend uses the official `@tauri-apps/plugin-updater` `Update` resource. Tauri owns downloaded bytes, signature verification and platform installation. Download callbacks update the local UI directly. There is no update-status endpoint or polling protocol.

## Install

After download, the panel shows **Update and restart**. Clicking it closes Core, calls `Update.install()`, and invokes the official process plugin's `relaunch()`. Normal startup restores connection intent from `desktop-session.json`. If installation fails, the Core lifecycle hook restores access and the error stays in the panel.

ARC-owned running tasks are interrupted by shutdown. Users resume eligible interrupted tasks through the ordinary task controls. Installation never waits for tasks, schedules a countdown or submits a continuation.

## Ownership

`ui/state/updates.ts` owns the Update resource, progress, check cadence, skip-version preference and basic operation exclusion. It releases superseded and skipped resources with `Update.close()`. Checks and downloads run at startup when due and hourly while the frontend is loaded. The existing main-window lifetime controller wakes an unloaded frontend invisibly at its hourly cadence. Pending updates keep their WebView alive until skipped, installed or Desktop exits.

`desktop/src/updates.rs` contains only Core lifecycle hooks and a proxy-aware check. ARC's per-scheme proxies, bypass rules and explicit direct mode require the Rust updater builder's client configuration. This check registers the official `Update` in the requesting WebView's resource table and returns its constructor metadata. Downloads and installation use the plugin commands directly. There is no ARC update-byte cache, custom progress event, update management API or download-cancellation channel.

The panel contains Release notes, official download progress, skip-version and the direct install action. Installation always requires the update button. Local builds use `desktop:install` from an independent terminal.

## Validation

Run `npm test` for the direct install-button regression and frozen tool schemas. Use `npm run accept:ui` with the `updates-*` fixtures for layout and states. `npm run accept:updates` builds two signed versions with a hidden local fixture WebView with a loopback feed. That fixture imports the production frontend controller and exercises the real official plugin commands, retryable errors, cached installation with the feed offline, Core shutdown and matching Desktop/Core fingerprints after restart. It never replaces the installed production app.
