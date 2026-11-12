# Design sources

[UI conventions](ui.md) · [Asset mapping and status](design-assets.md) · [Acceptance](acceptance.md)

TSX sources in `design/` define ARC's visual direction. React implementations follow approved sources. [UI conventions](ui.md) owns behavior, data projection and layout logic.

The [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md) govern asset placement, ownership, naming, fixture separation and lifecycle. The [toolkit contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md) governs authoring, rendering, checks and viewer commands. Follow the asset rules when local guidance conflicts. Use the global ADG CLI **>=0.5.0**, as required by `adg.config.mjs`; ARC does not depend on the toolkit at runtime.

## Presentation forms

ARC uses warm neutral surfaces, restrained semantic tints, rounded shared controls and Lucide icons. `design/tokens.css` owns the palette, typography and dimensions; `ui/tokens.css` is the runtime sheet. Both themes use the same declared forms. Add a token for a value shared or semantically named across sources; keep single-use local dimensions in the owning part. Keep the homepage's ARC mark, earcup connections and topology, and the tile's neutral shell with a separate state tint. Phase labels use shared typography with semantic color on the label span.

The desktop targets are macOS and Windows. Headless Linux has no product UI. Each source uses one representative language; English and Simplified Chinese content follow its mapped fixture. Frame dimensions and capture viewports are declared in TSX. Landscape homepage forms use 1280×800, portrait forms use 640×800, expanded-single-task uses 640×1000, and `homepage-topology-mobile/narrow-two-tasks` uses 390×844. Portrait forms omit visible node and group labels and retain accessible names. The outer rails leave the center for account branches and task cards. Rails reserve node and quota-ring space; the date/time header stays centered.

The default exports declare presentations. Approved task-bearing homepage forms remain retained pending the two-mode migration below. Apply the toolkit's single-part and multi-part frame naming rules when the owning family is reviewed, updating all references together. Task bubbles retain compact, standard, detailed, row and row-attention; the Board header retains active and idle. Portrait topology retains expanded-empty, expanded-single-task, expanded-two-tasks, sources-compacted, sources-folded and agents-folded. The tasks-and-accounts form uses a 640×1000 frame to show task cards connected to an active account alongside folded sibling accounts. Setup retains standalone and nested flows, including distinct method and ready controls. AX Board retains open, closed and detail forms; detail replaces the list inside the same panel and can scroll beyond the viewport.

### ARC health

The upper arc shows ARC's remote connection health. The lower arc shows local Core availability. Each arc stays continuous and uses its role color when healthy or the danger color when unhealthy. Hover or keyboard focus reveals icon buttons outside the arc. The hover region includes the space to the buttons. The upper arc always offers Connections and adds recovery when unhealthy. The lower arc offers Stop Core when healthy and Core recovery when unhealthy.

The upper arc reports unhealthy when health identifies an unavailable ARC-owned listener or transport expected to run. An unconfigured or deliberately stopped remote connection adds no fault. A check failure without an identified connection leaves Connections available in the regular arc state. The lower arc uses Desktop's authenticated check of Core and its management listener. Both reads exclude source and Agent state, OAuth, account state, task activity, and local client bridges. A source lifecycle action cannot change ARC's expected remote transport state. A client leaving or losing its lease cannot stop Core while Desktop owns it.

Remote recovery retries the remote check or restarts only the affected remote connection. Remote access depends on Core, so when Core is unavailable an expected remote connection also shows unhealthy. Its recovery panel directs the user to Core recovery. Core stop and recovery use a local Desktop action independent of Core request routing. An explicit stop is a host-level intent honored by all automatic start paths. The lower arc shows unavailable and offers Start Core. When a new Core passes its health check, it restores the last explicit ARC-managed remote connection intent. Each recovery keeps its fault treatment until the relevant check passes.

### Two-mode homepage

**Tasks presentation, the device level and the working node capsule are user-approved.**
Topology presents ARC configuration; Tasks presents task execution.
A shared SingleChoice below the centered Board header selects Topology
or Tasks manually. Persist the choice; task activity never switches modes. In
Topology, the Tasks option shows the needs-me count. Node task-state activation
is explicit navigation to Tasks with a highlighted, clearable node filter, scroll
position and keyboard focus at its matching tasks. The filter is transient; manually
selecting Tasks opens all tasks.

Topology retains the left/right wings, ARC hub and earcups. Its layout inputs are
configuration, viewport and explicit structural disclosure. Task observations change
only the node capsule shell, task content and its outgoing wire port. Logo anchors,
labels, columns and branch rails stay fixed. Task bubbles, queues, task-only tentacles
and outer arcs, task-driven layout and focus-to-expand task overlays are removed from the proposed homepage.

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
these user-approved Tasks forms. Historical task-bearing sources remain retained for history presentation. Their homepage task-layout consumers are retired.

#### Recorded task fields and presentation limits

| Detail | Existing source | Presentation rule |
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
aggregate are new derived UI projections over these existing reads; the local cross-task
card feed is derived in `ui/state/homepageTasks.ts`. Timeline summaries retain at most
80 entries per task and use the existing recent-preview read. Remote cards join native controller-scoped `device/tasks` activity and up to 200
records. Remote timeline/response forwarding and account/quota inventory remain
management coverage gaps. The proposal assumes no ETA, live provider percentage,
invented step duration, or inferred waiting phase. All rendered content is fictional.

### Device level

`surfaces/device-link-topology.tsx` composes the proposed paired-device level using
`modules/device-topology.tsx`. Static landscape frames cover LAN, Tunnel, offline, merged
single-Agent collapse/expansion, the device panel and the member controller source
with optional upstream sources off/on. The ARC mark, earcups, local tier-1 Agents and
shared navigation capsule remain part of the homepage. Device management temporarily
folds its child branch while the panel is open, using explicit structural disclosure.

#### Working node capsule

The quota ring is the capsule outline. An idle node is the existing 48px logo and
circular quota ring. A working node stretches that same ring into a 48px-high stadium:
a circle is a stadium with no straight run, so idle and working are one outline. Quota
arcs keep their meaning as fractions of the outline, starting at the top of the inner
cap and running clockwise; the elapsed tick stays on the outline. The pace trace stays
on the idle ring and in panels only. Plain devices draw a neutral track; unconfirmed
draws a dashed neutral track with no quota. The capsule fills with surface and grows
rightward on the executor wing and leftward, mirrored, on the control-source wing.

Content follows one rhythm. Every item is a 22px disc centered on the capsule's
midline at a 28px step. The logo is concentric with the inner cap and the last item
with the outer cap, so width is exactly 48px plus 28px per item. Item order from the
logo outward: the needs-me count, one disc per running task showing that task's
current phase, then an overflow disc.

- Needs me: a solid warning disc with the count (9+ cap), matching the Tasks badge in
  the mode switch. It is the only number in the capsule.
- Running: each disc is one task. Its icon is the observed phase (reading, editing,
  command, thinking, waiting) on a subtle surface, tinted with the phase tokens;
  waiting is tertiary. A running task without an observed phase shows a loader.
- Overflow: a three-dot disc replaces the last running disc when the limit is
  reached. Exact counts and phase names are in the accessible summary.
- Completed unread: an accent dot on the outline at 45 degrees of the outer cap. It
  does not expand the node; an idle node with unread work stays a circle with the dot.
- Unconfirmed: one help disc, the logo at reduced opacity, and the dashed outline.

The account capsule stays distinct: it is 40px high with a 1px border, brand marks,
quota dots and a member count; the working capsule is 48px with the 3px quota outline
and phase discs.

At most five items fit landscape (188px) and two fit portrait/mobile (104px). Reserve
the maximum width in every configuration column, even at idle, with column pitches of
260px and 152px respectively. Device capsules aggregate only the controller-visible
task scope. Local/remote Agents and merged device+Agent nodes keep their quota on the
outline; plain devices have no invented quota.

Incoming wires end at the fixed inner logo edge. Outgoing wires start at the actual
capsule outer edge. Width, task-area reveal and the outgoing port interpolate together
with the existing topology spring (stiffness 210, damping 26, approximately 8ms
integration steps); logo, label and branch rails do not animate with activity. Reduced
motion sets the endpoint directly and disables the running pulse. Logo activation
opens the existing node panel; task-area activation opens Tasks filtered to that node.
The idle and working frames specify endpoints. Runtime width and outgoing ports share
the topology spring integrator with stiffness 210, damping 26 and 8ms substeps.

Portrait 640×800 and mobile 390×844 retain node labels and fixed compact columns.
Explicit horizontal pan reveals deeper device/Agent/account columns without reflow;
the Board header, mode switch and navigation stay fixed. The root, branch and account
viewport frames show this proposal. Pan never follows task activity. Remote sibling
accounts/profiles continue to fold with TopologyGroup.
These frames are user-approved. The separate Devices workspace, navigation entry and summary sources are retired. See the mapping for
retirement scope and Known gaps.

## Ownership and project configuration

ADG discovers `components`, `modules` and `surfaces` in that order. The [mapping](design-assets.md) owns per-part feature responsibility, implementation counterparts, review/adoption status and retained exceptions. `fixtures/` owns representative data with type-only references to defining visual owners. `art/` owns artwork and content images with display dimensions and budgets in the mapping. There are no active studies or import-direction opt-outs.

`modules/homepage-topology.tsx` owns TopologyScreen and Scene. Homepage node, mark, canvas, Board header and navigation parts live in their defining modules. `fixtures/topology.ts` owns scene records; `fixtures/topology-mobile.ts` owns the narrow layout. Type-only references point to the defining visual owner. All production compositions participate in default discovery.


`design/tsconfig.json` resolves generated declarations in ignored `design/.adg/`. `adg.config.mjs` owns paths and the browser fixture adapter. Generated output belongs in ignored `output/design/`. `TopologyScene` accepts fixture coordinates inside `data-free`; runtime geometry remains owned by `ui/topology/layout.ts`.

## Review and adoption

Review roles do not authorize dispatch to Claude Code CLI. Launching or resuming work there requires explicit user authorization for the task or a clearly defined scope. Without it, the current authorized agent reviews the sources and renders and reports any remaining review gap.

Layout and behavior changes MAY be implemented directly.
The owning TSX source SHOULD be updated to match once the user accepts the result.
New visual directions and redesigns SHOULD start in the owning TSX source.
The user approves their renders before implementation.
Approved frames describe the intended result.
`adg compare` differences are review notes, not a gate.

Work on one cohesive family, feature module or composed surface at a time.
Keep current ownership, mappings, review status and known gaps in the mapping.
Keep batch history, check results and decision logs outside repository documentation.

After implementation, run `adg compare` once on the affected frames as a review list.
Rework missing or extra texts and offsets shared by many texts.
Accept isolated small offsets.
The user reviews the running result, or the gallery for new directions.
Run `adg check` before committing.

Commit scoped changes with a single-line Conventional Commits subject.
Inspect `git show --stat HEAD` for unrelated files.
Keep review evidence in ignored output or an external disposable directory.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.node-panel .layer-custom-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove redundant base definitions from `ui/tokens.css` when `design/tokens.css` owns the same token. Keep the scoped `data-surface="mcp"` overrides that map semantic tokens to host colors.
- Avoid `font-variant-numeric` and `letter-spacing` values that the source does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes and visual statements in [UI conventions](ui.md) in the same change.

## Migration

- Existing surfaces MAY receive layout and behavior changes directly.
- Update their owning source once the user accepts the result.
- `ui/tokens.css` is the runtime token sheet. Migrating a surface aligns the tokens it uses with `design/tokens.css`.
- Migrating a surface deletes its visual statements from [UI conventions](ui.md) and keeps its behavior statements.
