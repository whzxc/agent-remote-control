# Design sources

[UI conventions](ui.md) · [Asset status](design-assets.md) · [Acceptance](acceptance.md)

TSX sources in `design/` define ARC's visual direction. React implementations follow approved sources. [UI conventions](ui.md) owns behavior, data projection and layout logic.

The [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md) own generic placement, ownership, naming, frame admission, fixtures, review and lifecycle rules; this page keeps ARC-specific decisions. The [toolkit contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md) governs authoring, rendering, checks and viewer commands. Follow the asset rules when local guidance conflicts. Use the global ADG CLI **>=0.13.1**, as required by `adg.config.mjs`; ARC does not depend on the toolkit at runtime.

## Presentation forms

ARC uses warm neutral surfaces, restrained semantic tints, rounded shared controls and Lucide icons. `design/tokens.css` owns the palette, typography and dimensions; `ui/tokens.css` is the runtime sheet. Both themes use the same declared forms. [UI implementation policy](ui.md#shared-controls-and-paint) owns runtime paint and exception rules. Keep the homepage's ARC mark, earcup connections and topology, and the tile's neutral shell with a separate state tint. Phase labels use shared typography with semantic color on the label span.

The desktop targets are macOS and Windows. Headless Linux has no product UI. English and Simplified Chinese content follow its mapped fixture. Frame dimensions and capture viewports are declared in TSX. Landscape topology uses 1280×800 and portrait topology uses 640×800. Mobile forms are declared with their owning task or device surface. Rails reserve node and quota-ring space. The shared HomepageBar keeps the mode switch centered.

The default exports declare presentations. Task cards have summary and detail forms with an identical header. Setup retains standalone and nested flows, including distinct method and ready controls. AX Board retains open, closed and detail forms. Detail replaces the list inside the same panel and can scroll beyond the viewport.

### ARC health

The upper arc shows ARC's remote connection health. The lower arc shows local Core availability. Each arc stays continuous and uses its role color when healthy or the danger color when unhealthy. Hover or keyboard focus reveals icon buttons outside the arc. The hover region includes the space to the buttons. The upper arc always offers Connections and adds recovery when unhealthy. The lower arc offers Stop Core when healthy and Core recovery when unhealthy.

The upper arc reports unhealthy when health identifies an unavailable ARC-owned listener or transport expected to run. An unconfigured or deliberately stopped remote connection adds no fault. A check failure without an identified connection leaves Connections available in the regular arc state. The lower arc uses Desktop's authenticated check of Core and its management listener. Both reads exclude source and Agent state, OAuth, account state, task activity, and local client bridges. A source lifecycle action cannot change ARC's expected remote transport state. A client leaving or losing its lease cannot stop Core while Desktop owns it.

Remote recovery retries the remote check or restarts only the affected remote connection. Remote access depends on Core, so when Core is unavailable an expected remote connection also shows unhealthy. Its recovery panel directs the user to Core recovery. Core stop and recovery use a local Desktop action independent of Core request routing. An explicit stop is a host-level intent honored by all automatic start paths. The lower arc shows unavailable and offers Start Core. When a new Core passes its health check, it restores the last explicit ARC-managed remote connection intent. Each recovery keeps its fault treatment until the relevant check passes.

### Two-mode homepage

**Tasks presentation, the device level and the working node capsule are user-approved.**
Topology presents ARC configuration; Tasks presents task execution.
A shared SingleChoice centered in the one-row HomepageBar selects Topology
or Tasks manually. Clock and Board sit on the left. Compact widths omit the date.
Mode persists; activity never
switches modes. The mode switch has no needs-me badge. Node task-state activation
is explicit navigation to Tasks with a highlighted, clearable node filter, scroll
position and keyboard focus at its matching tasks. The filter is transient; manually
selecting Tasks opens all tasks.

Topology retains the left/right wings, ARC hub and earcups. Its layout inputs are
configuration, viewport and explicit structural disclosure. Task observations change
only the node capsule shell, task content and its outgoing wire port. Logo anchors,
labels, columns and branch rails stay fixed. Task activity in Topology appears inside
node capsules. The Tasks view owns execution previews and historical summaries.

Tasks groups cards by the local date of their latest recorded activity. A grid adapts
its column count to the available width. Today's tasks, active work and unread
completions show detail cards. Older history uses summary cards. Homepage, Agent,
control-source and Board task entries use the shared card. Its three rows show
the origin chain with time fixed at the right, the task title, then the recorded
execution spec, project name and turn count. Each row scrolls horizontally when
its single line exceeds the available width. Running detail cards use an Aurora
border colored by the active phase. Reduced motion keeps the phase tint static. The controller shows its member dispatches.
On the member, that controller is the source.

Full previews follow the newest native rows. Consecutive tools in a turn form a
single-line summary of recorded operations. Reasoning uses its icon and summary.
Replies render inline. Clicking a card or pressing Enter opens its detail in the
centered task layer. An older summary reads its timeline when opened.

#### Recorded task fields and presentation limits

| Detail | Existing source | Presentation rule |
| --- | --- | --- |
| Current activity, state and origin | `ui/types.ts`: AgentActivitySession phase, headline, recentSteps, interaction, origin, agentAccountId and dispatchSummary | Use the current observation. Explicit failure or interruption takes precedence. Inactive tasks without an explicit exception appear completed. |
| Recent step icons and short text | AgentTimelineEntry type, status, title/text, command, operation, commandActions and excerpt fields; `ui/state/taskProjection.ts` | Reading/editing derive from file operations; waiting requires an observed pending item. Keep chronological order in the bounded tail. |
| Elapsed time | AgentActivitySession turnStartedAt; AgentTimeline turnTimings; AgentTimelineEntry durationMs | Derive from recorded timing. Remote cards use the snapshot observation as their end time. Normalize numeric epoch seconds or milliseconds and omit unknown starts. Offline cards omit elapsed time. |
| Request and response state | AgentInteraction and AgentTimelineEntry response; `ui/state/activityModel.ts` approval submissions; native receipt state/result | Snapshots report the request and its controller routing state. Task details retain request handling. Pending/unconfirmed response state follows the receipt and is never inferred from the card. |
| Remote path and freshness | `native/src/device_link/controller.rs`: list path, latency and lastSeen; `native/src/device_link/records.rs`: device/task/source associations | Compose the origin chain with current device facts. On the member, the controller remains the source without a local-device wrapper. |
| Partial coverage | AgentTimeline coverage and executionEvidence | Detail surfaces disclose partial coverage. The task preview displays the available rows. |

No new canonical task field is assumed. The proposed card summary and node phase
aggregate are new derived UI projections over these existing reads; the local cross-task
card feed merges recent native Codex conversations, live activity and dispatch records
in `ui/state/homepageTasks.ts`. Timeline summaries retain at most
80 entries per task and use the existing recent-preview read. Remote cards join native controller-scoped `device/tasks` activity and up to 200
records. Remote timeline/response forwarding and account/quota inventory remain
management coverage gaps. The proposal assumes no ETA, live provider percentage,
invented step duration, or inferred waiting phase. All rendered content is fictional.

### Device level

The runtime topology owns one-hop device geometry and controller-source disclosure.
Device management forms remain in `modules/device-link.tsx`. Browser scenarios own
landscape, portrait, offline and merged-device coverage. The former hand-positioned
device branch and viewport matrix were removed because they no longer matched the solver.

#### Working node capsule

The quota ring is the capsule outline. An idle node is the existing 48px logo and
circular quota ring. A working node stretches that same ring into a 48px-high stadium:
a circle is a stadium with no straight run, so idle and working are one outline. Quota
arcs keep their meaning as fractions of the outline, starting at the top of the inner
cap and running clockwise; the elapsed tick stays on the outline. The pace trace stays
on the idle ring and in panels only. Plain devices draw a neutral track. A known exception uses an icon while retaining quota readings. The capsule fills with surface and grows
rightward on the executor wing and leftward, mirrored, on the control-source wing.

Content follows one rhythm. Every item is a 20px disc centered on the capsule's
midline at a 28px step. The logo is concentric with the inner cap and the last item
with the outer cap, so width is exactly 48px plus 28px per item. Item order from the
logo outward: the needs-me icon, one disc per running task showing that task's
current phase, then an overflow disc.

- Needs me: a shield-alert icon in the warning disc. Counts are available in the accessible summary.
- Running: each disc is one task. Its icon is the observed phase (reading, editing,
  command, thinking, waiting) on a subtle surface, tinted with the phase tokens;
  waiting is tertiary. A running task without an observed phase shows a loader.
- Overflow: a three-dot disc replaces the last running disc when the limit is
  reached. Exact counts and phase names are in the accessible summary.
- Completed unread: an accent dot on the outline at 45 degrees of the outer cap. It
  does not expand the node; an idle node with unread work stays a circle with the dot.
- Exception: the latest ended task can show a failure or interruption disc before the running phase discs.

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

Portrait 640×800 and mobile 390×844 retain the portrait solver, rails, compact node presentation and configuration group planner.
Explicit horizontal pan reveals deeper device/Agent/account columns without reflow;
HomepageBar and navigation stay fixed. The root, branch and account
viewport frames show this proposal. Pan never follows task activity. Remote sibling
accounts/profiles continue to fold with TopologyGroup.
The browser scenarios retain the narrow layout coverage. The separate Devices workspace, navigation entry and summary sources are retired.

## Ownership and project configuration

ARC uses ADG's default source directories. `design/components/` mirrors `ui/components/ui/`; modules map to feature components, and surfaces map to panels, workspaces, dialogs and homepage views. `design/implementation.json` is the sole counterpart record. [Asset status](design-assets.md) owns open proposals, retained exceptions, remaining gaps and artwork dimensions/budgets. The homepage feature lives in `design/modules/homepage-scene/`. Its `index.tsx` owns the frames and public exports, and sibling files own individual visual units. Fixture data lives in `design/fixtures/` with type-only references to defining visual owners; artwork lives in `design/art/`. There are no active studies or import-direction opt-outs.

Homepage node, mark, Board header and navigation parts live in shared components.
[Homepage topology](../../design/surfaces/homepage-topology.tsx), [account folds](../../design/surfaces/homepage-topology-accounts.tsx) and [portrait topology](../../design/surfaces/homepage-topology-portrait.tsx) compose the shared scene from fixture solver geometry. [Layer slots](../../design/surfaces/layers.tsx) cover content-fit and capped XL workspaces, the M node panel, a nested dialog and the portrait workspace. Current device branches use the same local and remote node components in their landscape and portrait fixtures. `adg.config.mjs` enables strict layers and lifecycle checks; `adg check` also checks implementation owners and shared consumers. Run `npm run design:topology` after changing topology solvers, painters, fixture configuration or node presentation. The command captures solver inputs from the same browser fixtures, then regenerates `design/fixtures/topology.ts` through the production solvers and painters. The daily regression test compares regenerated output and fixture inputs with the committed files.


`design/tsconfig.json` resolves generated declarations in ignored `design/.adg/`. `adg.config.mjs` owns paths and the browser fixture adapter. Generated output belongs in ignored `output/design/`. Runtime geometry remains owned by `ui/topology/solve.ts`, `compact.ts` and `portrait.ts`.

## Review procedure

[AGENTS.md](../../AGENTS.md) owns Claude Code CLI authorization and the pre-commit `adg check` requirement. The current authorized agent proposes and implements; the user reviews the result.

Layout and behavior changes may be implemented directly. New visual directions and redesigns start as proposed frames in the owning TSX source and require the user's approval of both-theme renders before implementation. Apply ADG's [status and lifecycle](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md#status-and-lifecycle) rules for bindings, source updates after acceptance, drift and retirement.

After implementation, run `adg compare` once on the affected frames as a review list. Rework missing or extra texts and offsets shared by many texts; accept isolated small offsets. Compare differences are review notes, not a gate. The user reviews the running result, or the gallery for new directions. Inspect `git show --stat HEAD` for unrelated files. Keep review evidence in ignored output or an external disposable directory; repository documentation keeps no batch history, check results or decision logs.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.node-panel .layer-custom-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove redundant base definitions from `ui/tokens.css` when `design/tokens.css` owns the same token. Keep the scoped `data-surface="mcp"` overrides that map semantic tokens to host colors.
- Avoid `font-variant-numeric` and `letter-spacing` values that the source does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes, visual statements in [UI conventions](ui.md) and their design counterparts in the same change.

## Implementation ownership

Migrating a surface aligns its runtime tokens with `design/tokens.css`. Move its visual statements out of [UI conventions](ui.md), retaining behavior there.

Feature presentation stays with its feature, including [timeline content](../../design/modules/timeline.tsx), [MCP services](../../design/modules/mcp-service.tsx), [device facts](../../design/modules/device-facts.tsx), [updates](../../design/modules/updates.tsx), [permissions](../../design/modules/permissions.tsx), [pets](../../design/modules/pets.tsx), [homepage chrome](../../design/modules/homepage-scene/index.tsx), and [quota details](../../design/modules/quota-detail.tsx). Shared [record details](../../design/components/record-detail.tsx), [entity inventory](../../design/components/entity-inventory.tsx), [SetupFlow](../../design/components/setup-flow.tsx), and [inspection popovers](../../design/components/inspection-popover.tsx) retain multiple feature consumers.

Runtime enforcement and exception ownership are documented in [UI implementation policy](ui.md#shared-controls-and-paint).
