# Design sources

[UI conventions](ui.md) · [Asset mapping and status](design-assets.md) · [Acceptance](acceptance.md)

TSX sources in `design/` define ARC's visual direction. React implementations follow approved sources. [UI conventions](ui.md) owns behavior, data projection and layout logic.

The [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md) govern asset placement, ownership, naming, fixture separation and lifecycle. The [toolkit contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md) governs authoring, rendering, checks and viewer commands. Follow the asset rules when local guidance conflicts. Use the global ADG CLI **>=0.5.0**, as required by `adg.config.mjs`; ARC does not depend on the toolkit at runtime.

## Presentation forms

ARC uses warm neutral surfaces, restrained semantic tints, rounded shared controls and Lucide icons. `design/tokens.css` owns the palette, typography and dimensions; `ui/tokens.css` is the runtime sheet. Both themes use the same declared forms. Add a token for a value shared or semantically named across sources; keep single-use local dimensions in the owning part. Keep the homepage's ARC mark, earcup connections and topology, and the tile's neutral shell with a separate state tint. Phase labels use shared typography with semantic color on the label span.

The desktop targets are macOS and Windows. Headless Linux has no product UI. Each source uses one representative language; English and Simplified Chinese content follow its mapped fixture. Frame dimensions and capture viewports are declared in TSX. Landscape homepage forms use 1280×800, portrait forms use 640×800, expanded-single-task uses 640×1000, and `homepage-topology-mobile/narrow-two-tasks` uses 390×844. Portrait forms omit visible node and group labels and retain accessible names. The outer rails leave the center for account branches and task cards. Rails reserve node and quota-ring space; the date/time header stays centered.

The default exports declare presentations. Approved task-bearing homepage forms remain retained pending the two-mode migration below. Apply the toolkit's single-part and multi-part frame naming rules when the owning family is reviewed, updating all references together. Task bubbles retain compact, standard, detailed, row and row-attention; the Board header retains active and idle. Portrait topology retains expanded-empty, expanded-single-task, expanded-two-tasks, sources-compacted, sources-folded and agents-folded. The tasks-and-accounts form uses a 640×1000 frame to show task cards connected to an active account alongside folded sibling accounts. Setup retains standalone and nested flows, including distinct method and ready controls. AX Board retains open, closed and detail forms; detail replaces the list inside the same panel and can scroll beyond the viewport.

### ARC health

The upper arc shows ARC's remote connection health. The lower arc shows local Core availability. Each arc has two visual states. A healthy arc is continuous and uses its role color. An unhealthy arc uses the danger color and breaks at its midpoint. An arc is a status indicator. Hover or keyboard focus reveals a separate icon button outside that arc, and its hover region includes the space to the button. The healthy upper action opens Connections. The healthy lower action stops Core. Each unhealthy action opens recovery for its own service.

The upper arc reports unhealthy when any ARC-owned listener or transport expected to run is unavailable. An unconfigured or deliberately stopped remote connection adds no fault. The lower arc uses Desktop's authenticated check of Core and its management listener. Both reads exclude source and Agent state, OAuth, account state, task activity, and local client bridges. A source lifecycle action cannot change ARC's expected remote transport state. A client leaving or losing its lease cannot stop Core while Desktop owns it.

Remote recovery retries the remote check or restarts only the affected remote connection. Remote access depends on Core, so when Core is unavailable an expected remote connection also shows unhealthy. Its recovery panel directs the user to Core recovery. Core stop and recovery use a local Desktop action independent of Core request routing. An explicit stop is a host-level intent honored by all automatic start paths. The lower arc shows unavailable and offers Start Core. When a new Core passes its health check, it restores the last explicit ARC-managed remote connection intent. Each recovery keeps its fault treatment until the relevant check passes.

### Proposed two-mode homepage

**Proposed.** Topology presents ARC configuration; Tasks presents task execution.
A shared SingleChoice below the centered Board header selects Topology
or Tasks manually. Persist the choice; task activity never switches modes. In
Topology, the Tasks option shows the needs-me count. Node task-state activation
is explicit navigation to Tasks with a highlighted, clearable node filter, scroll
position and keyboard focus at its matching tasks. The filter is transient; manually
selecting Tasks opens all tasks.

Topology retains the left/right wings, ARC hub and earcups. Its layout inputs are
configuration, viewport and explicit structural disclosure. Task observations change
badges only. Task bubbles, queues, task-only tentacles/outer arcs, task-driven layout
and focus-to-expand task overlays are removed from the proposed homepage.

Tasks mode makes task cards primary. Compact origin icons identify source, remote
device when applicable, Agent and account, without wires. The controller shows only
tasks it dispatched to a member. A controller-dispatched task on that member uses the
controller device as its source. Needs me precedes Running and Completed unread;
Unconfirmed follows, then optional collapsed Recent completed. Offline device tasks
use unconfirmed state and last-seen metadata, without live verbs or counts.

Tasks uses the full available content width. At 1500px and wider, groups can use
three columns and show five recent steps; standard landscape uses two columns and
three steps. Portrait/mobile use one column, with compact cards and explicit in-place
Activity expansion showing four steps. The title opens task detail independently.
Answer and Review approval entries preserve the existing request interaction; completed
unread cards retain their separate check action. Only Needs me and Running reorder.
Recent completed starts collapsed. The header remains available while groups scroll.
`modules/tasks.tsx`, `modules/task-activity.tsx`, and `surfaces/homepage-tasks.tsx` own
these Proposed forms. Existing task-bearing topology sources remain pending retirement.

#### Recorded task fields and presentation limits

| Proposed detail | Existing source | Presentation rule |
| --- | --- | --- |
| Current activity, state and origin | `ui/types.ts`: AgentActivitySession phase, headline, recentSteps, interaction, origin, agentAccountId and dispatchSummary | Use the current observation; unconfirmed tasks show no live verbs or counters. |
| Recent step icons and short text | AgentTimelineEntry type, status, title/text, command, operation, commandActions and excerpt fields; `ui/state/taskProjection.ts` | Reading/editing derive from file operations; waiting requires an observed pending item. Keep chronological order in the bounded tail. |
| Elapsed time | AgentActivitySession turnStartedAt; AgentTimeline turnTimings; AgentTimelineEntry durationMs | Derive from recorded timing. Omit when unavailable; do not tick an offline task. |
| Plan progress | AgentTimelineEntry plan item content and status | Count completed plan items over known items. Show the current item; omit absent/empty plans. This is not an overall task completion estimate. |
| Latest file, command and diff summary | AgentTimelineEntry path, operation, command, changes added/removed/diff, input/output and exitCode | Render recorded summaries and available counts; truncate with full accessible values. |
| Request and response state | AgentInteraction and AgentTimelineEntry response; `ui/state/activityModel.ts` approval submissions; native receipt state/result | The inline entry opens the existing request UI. Pending/unconfirmed response state follows the receipt and is never inferred from the card. |
| Remote path and freshness | `native/src/device_link/controller.rs`: list path, latency and lastSeen; `native/src/device_link/records.rs`: device/task/source associations | Compose the origin chain with current device facts. On the member, the controller remains the source without a local-device wrapper. |
| Partial coverage | AgentTimeline coverage and executionEvidence | Mark partial history and omit unavailable details. An activity snapshot alone does not promise timeline text. |

No new canonical task field is assumed. The proposed card summary and node phase
aggregate are new derived UI projections over these existing reads; a joined cross-task
card feed is not present. Implementation still needs bounded timeline reads, provider
coverage and remote joins. The proposal assumes no ETA, live provider percentage,
invented step duration, or inferred waiting phase. All rendered content is fictional.

### Proposed device level

`surfaces/device-link-topology.tsx` composes the proposed paired-device level using
`modules/device-topology.tsx`. Static landscape frames cover LAN, Tunnel, offline, merged
single-Agent collapse/expansion, the device panel and the member controller source
with optional upstream sources off/on. Portrait 640×800 and mobile 390×844 fold remote
accounts/profiles with TopologyGroup and retain accessible node names without visible
labels. Device nodes retain the existing 48px graphic size. The ARC mark, earcups,
local tier-1 Agents and shared navigation capsule remain part of the homepage.
Task activity changes task pills only. Task bubbles, queues and task arcs are absent;
a task pill opens Tasks mode scoped to the node. Offline task pills show unconfirmed.

These frames are Proposed. Existing approved summary and workspace sources remain
retained until topology implementation replaces their consumers. See the mapping for
retirement scope and Known gaps.

## Ownership and project configuration

ADG discovers `components`, `modules` and `surfaces` in that order. The [mapping](design-assets.md) owns per-part feature responsibility, implementation counterparts, review/adoption status and retained exceptions. `fixtures/` owns representative data with type-only references to defining visual owners. `art/` owns artwork and content images with display dimensions and budgets in the mapping. There are no active studies or import-direction opt-outs.

`modules/homepage-topology.tsx` owns TopologyScreen and Scene. Homepage node, mark, canvas, Board header and navigation parts live in their defining modules. `fixtures/topology.ts` owns scene records; `fixtures/topology-mobile.ts` owns the narrow layout. Type-only references point to the defining visual owner. All production compositions participate in default discovery.


`design/tsconfig.json` resolves generated declarations in ignored `design/.adg/`. `adg.config.mjs` owns paths and the browser fixture adapter. Generated output belongs in ignored `output/design/`. `TopologyScene` accepts fixture coordinates inside `data-free`; runtime geometry remains owned by `ui/topology/solve.ts`.

## Review and adoption

Review roles do not authorize dispatch to Claude Code CLI. Launching or resuming work there requires explicit user authorization for the task or a clearly defined scope. Without it, the current authorized agent reviews the sources and renders and reports any remaining review gap.

Codex proposes and implements each batch. The current control source reviews ownership, mappings and both-theme renders unless the user assigns autonomous structural release. The user approves visual changes in the gallery. The control source approves structural-only batches under the pixel and crop/part-frame criteria below. A crop or part frame is structural only when every existing render, including its parent, is pixel-identical in both themes and every differing pixel belongs to one of these classes: (a) imperceptible, channel delta at most 2 with no count limit; (b) antialiasing on shape, glyph or corner edges, below 0.5% of the crop area with maximum channel delta at most 48, only when the part's element, layout and color snapshots match the parent region; (c) boundary bleed from parent-scene content outside the part, including connectors, neighbors or seams, within 2 device pixels of the crop edge; (d) bitmap resampling, any channel delta inside the box of a raster image element (img or SVG image), only when snapshots match and below 0.1% of the crop area. Report per-frame class counts in the comparison output. Any geometry or snapshot mismatch, other difference, shifted box, changed fill or token, or missing or added element inside the part stops the turn with a gallery URL. Otherwise continue. Other visual differences or open decisions go to the user's gallery review. Record current review/adoption status and remaining gaps in the mapping; keep batch history, check results and decision logs outside repository documentation.

For user-assigned autonomous governance, pixel-only crop differences with matching snapshots may remain Known gaps while work continues. Existing render changes and checks that cannot be fixed structurally remain stop conditions.

Work on one cohesive family, feature module or composed surface at a time. The active scope and queued responsibilities are in the mapping. Before editing, render affected frames from the batch base commit in a disposable copy outside the checkout and report its path. After editing, run `adg check`, render and inspect every affected frame in both themes, and compare each with its baseline. Token edits include all dependent frames. A structural comparison uses decoded pixel equality, including dimensions. Implementation comparison uses the fixture/capture adapter described in the mapping.

Commit the scoped changes with a single-line Conventional Commits subject and inspect `git show --stat HEAD` for unrelated files. For visual differences or open decisions, open `adg open <lane>/design --port=<free-port>` and provide the gallery URL; do not use port 4310. Keep review evidence in ignored output or an external disposable directory. Update current mapping/status at each batch boundary. Implementation edits and runtime acceptance require their own assigned scope.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.elastic-panel .dialog-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove redundant base definitions from `ui/tokens.css` when `design/tokens.css` owns the same token. Keep the scoped `data-surface="mcp"` overrides that map semantic tokens to host colors.
- Avoid `font-variant-numeric` and `letter-spacing` values that the source does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes and visual statements in [UI conventions](ui.md) in the same change.

## Migration

- A surface without an approved source keeps its current implementation. Its next visual change starts by writing its source.
- `ui/tokens.css` is the runtime token sheet. Migrating a surface aligns the tokens it uses with `design/tokens.css`.
- Migrating a surface deletes its visual statements from [UI conventions](ui.md) and keeps its behavior statements.
