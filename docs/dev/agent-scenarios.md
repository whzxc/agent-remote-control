# Agent scenario catalog

[Acceptance](acceptance.md) · [Control-source contracts](../reference/tools.md)

The catalog makes Agent-visible behavior reviewable as individual scenarios. Each
scenario records an MCP call, the real ARC response obtained with a synthetic
upstream, and the conclusions an Agent should be able to draw. The static gallery
organizes the whole operation catalog even where scenario coverage is missing.
Approved responses form a separately versioned baseline for later structured diffs.

## Layout

- `arch/agent-scenarios/capabilities.json` assigns every operation in
  `native/src/catalog.json` to exactly one user-facing capability. Titles and
  descriptions are English; `label` supplies the Chinese display name.
- `arch/agent-scenarios/scenarios/<id>.json` owns the capability, exercised ops,
  title, setup calls, captured call, conclusions and known fixture artifacts.
- `arch/agent-scenarios/approved/<id>.json` holds user-approved normalized calls
  and complete `tools/call` results. The initial scenarios have no approvals.
- `tests/fixtures/codex-app-server.mjs` is the unchanged synthetic Codex App Server
  shared with `tests/control-mcp.test.ts`.
- `tooling/agent-scenarios.mjs` builds the fixture and Core CLI, executes scenarios,
  writes captures and produces the gallery. The library owns normalization,
  masking, JSON diffs and coverage. The gallery module generates static HTML.
- Ignored `output/agent-scenarios/` contains `current/` normalized captures,
  `raw/` original calls and MCP results, `sizes.json`, `coverage.json` and `index.html`.

## Commands

Run from the repository root with installed development dependencies, Node and
the Rust toolchain:

```sh
npm run agent-scenarios:capture
npm run agent-scenarios:check
# After the user approves the displayed responses:
npm run agent-scenarios:approve -- first-contact dispatch
```

The equivalent general entry point is `npm run agent-scenarios -- <mode> [ids...]`.
`capture` and `check` build `contract-fixture` with `cargo build --locked --quiet`
and use `prepareCoreBinary()` from the existing test helpers to build and stage
`arc`. They honor `CARGO_TARGET_DIR`, use the shared heavy-build lock, and prune
the compilation cache after the builds. Each scenario starts its own temporary
home, ARC state and App Server through the real MCP SDK stdio client. The ingress
and connection configuration follow `control-mcp.test.ts`. Fixture task settings
disable automatic Desktop opening. Closing a scenario stops its processes and
removes its temporary state. No installed instance is used.

Setup steps use MCP `call` objects and save their parsed results under `id`.
`${fixture}` resolves to the temporary workspace. `${stepId.field}` references a
previous setup result. An optional `until` condition names a result `path` with
either `equals` or `nonEmpty`. These conditions have a bounded 15-second readiness
wait. Write readiness reads its durable receipt; it never resubmits the write.
The captured call is made once. Setup failures abort capture.

`check` always captures fresh responses. It exits nonzero for invalid coverage
assignments, missing captures, missing approvals, removed approved scenarios or
changed approved calls/results. Changed JSON paths use JSON Pointer notation;
embedded MCP JSON text is decoded so paths identify the changed response field.
Uncovered operations are reported without making this first segment fail.

The runner is acceptance tooling. It is absent from `npm test` and
`npm run test:extended`. Pure-function unit cases run with daily tests.

## Normalization and masking

`tooling/agent-scenarios-lib.mjs` owns one normalization policy used by all modes.
It replaces UUIDs with stable, per-scenario placeholders while preserving repeated
identity references; ISO timestamps with `<iso-time>`; epoch seconds and
milliseconds in the current epoch range with `<epoch-s>` and `<epoch-ms>`; the
temporary fixture directory with `<fixture>`; and the fixture CLI path with `<cli>`.
Numeric timestamps and timestamps embedded in strings are both normalized.

The shared `MASKS` list replaces values with `<masked>` at `guideHash`,
`next.hash`, `phaseAgeMs`, `elapsedMs`, `snapshotHash`, `arcVersion` and `cliPath`.
Masks retain field presence. Other hashes, execution states, errors, counts,
continuations and content remain visible. Embedded JSON text is normalized and
serialized compactly, retaining the complete raw MCP envelope and its other
content blocks. Original responses remain in the ignored `raw/` directory.

The gallery shows pretty JSON for the Agent's text response, a disclosure of the
complete MCP result, and added/removed/changed paths with before/after values.
Character counts use the original compact Agent text (JavaScript string length).
Approximate tokens are `ceil(characters / 4)`, not a model tokenizer measurement.
The page follows the system light/dark preference and opens directly as a local
file without a server or dependencies.

## Approval flow

Capture, open `output/agent-scenarios/index.html`, and review each scenario's call,
response, intended conclusions and fixture artifacts. Obtain user approval for
specific scenario IDs. Only then run `approve <ids...>` to copy those current
normalized captures into `approved/` and commit the baseline. Approval does not
recapture: it promotes exactly the responses displayed for review. Capture and
check never create or replace approvals. Later capture/check runs show the diff
against that baseline and changed scenarios return to pending.

## Coverage rules

Every native catalog op must have exactly one capability assignment. Unassigned,
duplicate and removed/unknown assignments fail every mode. Scenario ops and
capability IDs must exist. Scenario IDs must be unique and match their filenames.
Negative-call scenarios may have an empty `ops` array when their attempted op is
intentionally absent from the catalog, as in `typo`.

Operation coverage counts setup calls as well as captured calls. A scenario can
therefore cover operations in several capabilities while its primary capability
owns its approval count. Reports list total and covered ops, uncovered ops, and
approved/pending/missing-capture scenario counts per owning capability. An
approved scenario matches its current capture; pending means a capture lacks an
approval or differs from it; missing means the defined scenario has no capture.
An op with no scenario remains explicitly missing in the navigation and coverage
report. It is separate from a defined scenario with a missing capture.

The notifications capability owns structured kinds `completed`, `failed`,
`interrupted`, `needs-input`, `handoff`, `recovered` and `ping`. Each kind must be
assigned once. Scenarios declare `notificationKinds` only when they capture that
pushed event. Reading inbox events during setup does not cover pushed delivery.
The initial five call scenarios leave all seven pushed kinds uncovered.

## Fixture limits

The synthetic server deterministically returns `pong`; it performs no real model
inference. Its question turn already contains a completed `agentMessage` while
the turn remains `inProgress` with an unanswered request. A question summary can
therefore contain both a final response and an input request. Review that payload
as fixture evidence. The temporary workspace has no Git baseline, so result and
question summaries can report unavailable change evidence. Completed fixture
turns also finish synchronously rather than reflecting model execution latency.
Production response shapes remain unchanged by this tooling.
