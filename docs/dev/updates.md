# Desktop updates

MUST means a requirement. SHOULD means the default. MAY means an option.

Desktop checks the configured Release feed and downloads available updates with the Tauri updater. Downloads MUST pass the updater signature check. Downloaded bytes stay in memory until installation or Desktop exit.

## Install

After download, the update panel shows **Update and restart**. Clicking it immediately starts installation. Desktop stops its Core, including attached local clients, calls the platform's Tauri installer with the already verified bytes, and requests an application restart. Normal startup restores connection intent from `desktop-session.json`.

Installation MUST NOT wait for task completion, classify task ownership, start a countdown, defer installation, enqueue dispatches, or submit a task continuation. ARC-owned running tasks are interrupted by shutdown. Users can resume eligible interrupted tasks through the ordinary task controls.

Update checks and downloads MAY run in the background. Installation always requires the update button. There is no automatic install policy.

The update panel contains Release notes, download progress, download cancellation, skip-version and the direct install action. Errors remain visible with the failed stage. A failed installation restores Core access so the user can retry or download an installer.

## Ownership

`desktop/src/updates.rs` owns acquisition and installation. `ui/state/updates.ts` reads Desktop's in-memory snapshot through `GET /api/updates`. Local management exposes `updates.status`, `updates.check`, `updates.download`, `updates.install` and `updates.cancel`. Install takes only the downloaded `version`.

There are no control-source update operations, detached replacement workers, durable update jobs, update task queues, automatic task recovery, application-health rollback controllers or replacement-history UI. Local build installation uses the repository's `desktop:install` command from an independent terminal.

## Validation

Run `npm test` for the direct install-button regression and frozen tool schemas. Use `npm run accept:ui` with the `updates-*` fixtures for panel layout and states. Run `npm run accept:updates` for signed-download and real install/restart acceptance in disposable application state.
