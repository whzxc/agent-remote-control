# Saved project settings and dispatch policy

Use the [MacBook setup](../installed.md). In main Desktop select the test project. Record the native home, the project's two saved permission choices (legacy and modern, including absence), the Codex configuration default, configured MCP servers, enabled plugins, and a redacted account identity. Save the original settings for restoration. Use a disposable project and test-only scratch files both inside and outside its workspace to distinguish read-only, workspace-write and full access. Record effective sandbox, approval and capability results from a reference task. Quit main and verify its process exit before independent dispatch. For each row resolve the create receipt, confirm the independent writer, and inspect the original turn.

## Saved permission cases

| Case | Starting state | Expected effective permission on a successful dispatch without overrides |
| --- | --- | --- |
| project-parity | Save read-only in both places. Set the configuration default to workspace-write. | The agreed saved choice. |
| missing-legacy | MacBook state: legacy absent, modern full access, configuration default full access. Repeat with workspace-write as the configuration default. | The configuration default in each trial. The MacBook trial alone cannot distinguish which source supplied full access. |
| missing-modern | Modern absent, legacy read-only, configuration default workspace-write. | The configuration default. |
| saved-disagreement | Set legacy read-only, modern full access, default workspace-write. Swap the two saved choices on a fresh trial. | The configuration default. |
| composer-choice | Keep both saved choices in agreement. Select a different permission in an unsent main-window composer. Confirm the saved choices did not change. Dispatch once without overrides, then create a fresh task explicitly supplying the unsent choice. | The first task follows the saved choice. The second follows the explicit choice. |

**same-settings** — For one exercised row, require an accepted dispatch and a native turn whose effective permission matches that row, including the result of the distinguishing file operation. Read the project configuration via native `config/read` and compare the matching turn in `codex_read({threadId, view:"full"})`, including its native-persisted `effectiveConfiguration`. For the MacBook modern choice, inspect only the active account’s local permission selection in the native Desktop settings. Record each saved value or confirmed absence separately. An unreadable setting is a gap. Compare effective MCP server and plugin membership by ID and the account identity for the same home and project. Exercise a read-only capability where configured. An unavailable saved-state or effective-settings readback leaves the affected comparison open. Restore original settings after the trial.

## installed-policy-parity

**model-from-policy** — Save the effective ARC policy and selected pack. Exercise three fresh creates for the same project. Omit model, effort and speed in the first. Select a pack with distinct defaults and omit the three arguments in the second. Keep the pack and supply explicit values in the third. For each, first dispatch through main Desktop, then quit main and dispatch identical arguments through the independent instance. Verify both routes. Compare receipt and submitted turn model, reasoning effort and service tier against the policy default, pack default or explicit choice for that row. Use a distinguishable speed setting when testing precedence. The executable cases exercise this same argument selection at a fixture native endpoint. Installed comparison establishes parity between routes.

**listed-in-main** — For one independently dispatched task, launch main, refresh its normal task list and find the unique title without a deep link. Open that entry and verify the original thread ID and marker.

The three executable policy rows exercise an existing selection contract and may already pass on the baseline. Installed independent-route parity requires the candidate.
