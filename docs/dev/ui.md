# UI conventions

[Design sources](design.md) · [Remote link design and phases](remote-link.md) · [Development](development.md) · [Architecture](architecture.md)

[Design sources](design.md) own visual appearance. This document owns behavior, data projection and layout logic.

React renders. Tauri/Rust owns configuration, connections, tasks, authentication, native windows, and updates. The main window shares semantic tokens, preferences, and controls.

Activity model badges retain their intrinsic width. Codex project labels use the native project catalog, shared with project resolution through a 30-second cache. Explicit project IDs take precedence; directory matching requires an unambiguous deepest root. The filesystem directory remains separate from its display name. Task details show the project beside the Agent name, with duration, source, and model in the metadata row. All task surfaces share running, waiting-for-input, completed, failed, interrupted and unconfirmed execution states. Activity absence and native idle metadata are not completion evidence. Historical dispatches use their bound turn, never a later turn in the same conversation. Model and effort share one pill.

Timeline groups follow native turn IDs regardless of dispatch origin. External Codex history remains readable after the activity monitor no longer retains the session. History read failures stay visible and retryable instead of becoming a cached partial result. Only actual coverage limits show a partial-history notice; external origin alone does not imply missing history. Incomplete coverage is distinct from a clipped output excerpt, whose notice stays beside that output. Previous turns expand from their summary and collapse from their title control. The turn header keeps its execution duration beside the operation count. The task header sums known turn execution spans and excludes gaps between turns. Native lifecycle timestamps backfill historical turn timing; missing timing is not inferred from the time the panel opened. Reasoning rows show their available summary and disappear when it is empty.

The timeline owns vertical scrolling. Tables, code blocks, file lists, diffs and command logs scroll horizontally within the stream and expand to their full content height. Wheel gestures over these blocks send horizontal deltas to the block and vertical deltas to the timeline, including diagonal gestures. Unconsumed boundary events retain native scroll chaining.

## Homepage and layout

The homepage presentation follows the approved `homepage-topology-*` surfaces and the `board-header`, `topology-scene`, `topology-mark` and `topology-node` component assets. Palette preferences apply to the control-source and Agent sides.

Portrait orientation, rails and panel placement follow [Portrait layout](portrait-layout.md). The geometry below describes landscape.

ui/topology/solve.ts is the pure geometry owner. Wings share a mirrored algorithm. Initialize SVG and ResizeObserver after container refs commit. Solve only after a nonzero real viewport exists. Resizing recomputes geometry with spring transitions. Ports follow target direction with angular spacing. Earcups/outer arcs fit port ranges. Primary/secondary tentacles widen toward the root by arc length. Connecting shows root fade and moving dashes. Errors use semantic error color and background breaks. Disconnected/disabled nodes have no primary line and faded icons/names. Center-dot entry points do not participate in connections. Primary tentacles end at earcups with space before the dots.

The animator integrates stable-key center/radius, DOT scales, earcup extent, node position/scale/opacity/ports, wire opacity/availability, outer arcs, and task primitives with stiffness 210, damping 26, and roughly 8ms substeps. Each frame recomputes tentacles/arcs. One SVG draws connections. HTML nodes and fixed-size bubbles receive same-frame transforms through refs. The Board header follows the animated hub's horizontal center in the same frame while retaining its top offset and viewport clearance. Topology animation neither renders React each frame nor reads node DOM coordinates or uses layout projection. rAF stops when stationary. reduced-motion switches positions directly and stops flow. Runtime media-query changes apply immediately.

Platform, connector, Agent and Agent-profile nodes share one size, defaulting to 42px and adjustable from 32 to 60px. Activity and hierarchy do not change icon size. Icons, quota rings, endpoints, and outer arcs scale together. Idle Agents may fade and indent when tasks occupy the wing; their size remains unchanged. Row and column compression accommodates limited space.

Height pressure folds eligible siblings at every depth into the shared [TopologyGroup](../../ui/components/ui/TopologyGroup.tsx), following [sibling group behavior](portrait-layout.md#height-aware-sibling-groups). The homepage accepts Agent count limits of 4, 6, 8 or 10 before compaction and falls back to 4 for other values. Idle descendant groups fold before roots. All eligible idle siblings of a parent fold together. Each parent has at most one capsule with at least two members and one branch. Pinned branches and each side's highest-ranked root remain visible. Click or tap unfolds real members in place. Hover and focus leave a capsule folded. Enter or Space unfolds it and focuses the first member once interactive. Pointer input outside the group folds it; member branches and member-owned portaled panels and popovers count as inside. Activating another capsule switches the open group. Escape dismisses an open member layer first, then folds the group and restores capsule focus. Activity refresh preserves an explicitly opened group's membership. Capsule quota dots use success for healthy readings, warning for consumption of at least 50% or timing warnings, danger for exhausted readings, and border-strong when unavailable.

Wings independently compress rows. Active row height fits the sum of task heights and inter-task gaps, with 12px gaps between Agent rows. Scene height is max(viewport height, larger wing height + 140). Column spacing defaults to 2.6, adjustable 2.0-3.2. Columns center vertically. Horizontal fitting keeps the hub at the viewport center while both wings fit inside the viewport margins or dock boundary. A wing reaching its boundary displaces the hub only as far as needed. When translation alone cannot fit both wings, fitting first reduces the ring to at least 0.6 of its preferred radius. If space is still insufficient, both column distances compress by an equal ratio down to the configured minimum. Returning space restores the centered layout. The viewport margin defaults to 40px. Remaining overflow preserves the left wing and clips the right, with vertical scrolling. The center retains brand assets and earcup spacing.

The bottom navigation starts with Settings, followed by Platforms and Permissions. An enabled Pets feature adds its own entry. Tasks remain accessible through Agent panels; request logs have no standalone UI page. The upper hub action opens Connections with connection URLs, status, editing, removal, and Add connection. One device connection is recommended for all products and platforms; existing multiple connections remain manageable.

Add/manage controls occupy the ARC endpoint dots outside sorting. Do not add trailing helper buttons, coordinates, or empty-column placeholders. Pointer Events update solver drag inputs directly. Items follow both axes, but only vertical changes reorder. Other items yield through springs. Dragging does not change center balance/column spacing. Release saves only a changed order and springs back to the column. Homepage dragging uses no Motion Reorder or layout projection. Tasks reorder only within their node and pending-priority group. Aggregate slots cannot reorder. Nodes/tasks support up/down keys. Suppress click after drag. Escape/pointer cancellation restores order. Source order persists. Enabled Agent order is shared with management. Hidden items keep relative order. Task order is frontend-local. Pending tasks remain first. Hub controls keep simple tactile state changes without permanent text, outer glow, or star decoration.

Source, add, Agent, and management nodes can expand into panels. Agent outer arcs and secondary tentacles connect task bubbles at the selected width and density. Collapsed queues show up to five slots, with overflow summarized in the fifth. Overflowing queues always keep unfinished tasks ahead of completed tasks. Pointer and keyboard moves apply within each completion group; cross-group moves settle inside the task's own group while preserving other tasks' relative order. The overflow summary temporarily expands the entire queue in place. Clicking outside the queue or pressing Escape collapses it again. Width defaults to 264px and density to 76px; display settings offer 232/264/304px widths and 54/76/100px heights. More than four tasks reduces density one level when auto-compact is enabled. Narrow windows clip the right with a 32px fade. Every task bubble opens details, including external sessions, without a whole-bubble tooltip or trailing time arrow. Native-app navigation uses header icons in Agent/task views. Task tentacles, phase tiles, labels, attention feedback and step trails follow execution state regardless of dispatch origin. A recorded control source adds only its small source icon to the bubble. Read-only timelines and summaries retain their control boundaries. Ongoing sessions show contrasting 3px flow dots on secondary tentacles. The second line prefers current content, then readable text/command/file, then title/user message. Fallback text uses text-tertiary. ARC questions/approvals appear only at the bottom of details without stacked/expanded/count badges.

Completed unread bubbles expose a solid success-color Mark as read button over the check tile. Its contrasting check and repeating ring identify the action without changing any bubble width or height. Reduced motion uses a static ring. The button owns pointer capture and tolerates up to 6px of jitter. Larger movement hands the original pointer and grab point to the normal topology drag; releasing after a drag never marks read or opens details. Pointer cancellation cancels the gesture. Native Enter/Space activation remains available. A click immediately starts dismissal without opening details. The rest of the bubble opens details and preserves the focus origin until those details close.

Collapsed timeline turns expand from any point on the card. Expanded turns collapse only from the padded title bar. Markdown links distinguish web/app URLs, local heading anchors, and file references. File references resolve through local management against the task's native project metadata; the frontend cannot supply a project root. Images share the existing project/thread-visualization path boundary and bounded decoder. Local files reveal in the host file manager. Failed, missing, or unsupported images render an image icon. Remote images use HTTP(S) without a referrer. Raw HTML and executable URL schemes remain inactive.

Codex subagents use their native nickname as the display title in activity, conversation lists and task details. External Codex activity without a nickname reads conversation titles from the native session index. An incremental rollout reader retains the first readable user message as a fallback, plus creation time and project metadata outside the bounded headline tail. Fast uses an explicit turn service tier when present, otherwise the thread setting captured at that turn's start. Later settings do not change earlier turn summaries.

Source and connector nodes use the left M Panel slot, and Agent, platform and task details use the right M slot. The slot fixes the horizontal position and 560px width, independently of the trigger. `layerFrame` always centers the current height between the top line and bottom margin. Growth and allowed shrink move both edges symmetrically around that fixed center. Height fits content, retains its largest value until a whole-view replacement, and caps with a scrolling body under fixed headers and footers. Below 760px or in portrait, all panels share the collapsed full-width slot. Same-slot navigation retains the shell and crossfades content while height and y animate together over `--motion-base`. Different slots exit and enter concurrently. Entry and exit use opacity fades. Reduced motion swaps instantly. Closing restores the latest trigger.

Node panels have no scrim, scene scroll lock or background inert. Nodes and the navigation capsule are marked panel switchers and use the layer store for replacement and toggling. A clean panel closes on outside pointer input or Escape, consuming the outside click. Dirty or busy panels show the shared dismissal footer with its safe action focused. The selected node hides its visible label while retaining its accessible name and logo action. Closing restores trigger focus, falling back to the owning node. Node panels pause topology dragging and keyboard sorting while open. The solver receives one horizontal boundary reserving `--layer-m` plus the side margin on the selected side. Expanded and collapsed panels overlay the scene without a horizontal reservation. Existing task branches, outer arcs and focus overlays keep their current behavior until the approved homepage implementation replaces them.

Opening an Agent panel fades all task bubbles/secondary tentacles slightly toward nodes while preserving secondary outer arcs. Nonselected nodes with running tasks show counts, using warning for pending work. Selected nodes retain their normal scale without an outline or halo. Their primary tentacle becomes brighter and a secondary tentacle connects to the panel edge. The selected node retains an outer arc even without task branches, on both sides of the topology. Closing restores bubbles. Agent views merge live tasks with unarchived conversation metadata. Sticky sections group tasks needing input, running tasks, unread completed tasks, conversations created today, yesterday, each remaining date in the current Monday-based week, and earlier conversations, with loaded counts. Unread appears immediately after Running and uses the shared completion read state. Opening an unread task moves it to its creation-date group. Empty sections are omitted. Date boundaries use the local calendar. Metadata without live evidence reads the recorded turn result. Missing terminal evidence shows an unconfirmed tile. Only explicit cancelled, interrupted or aborted evidence shows pause. It has no inferred duration, live phase, model, or source. Conversation rows retain the project, latest observed model/effort/Fast, turn count and creation date. The full local creation timestamp is available on hover. Missing configuration is omitted. Each section orders by creation time, newest first, without manual task order. The local agents/conversations endpoint returns 20 metadata rows per request, capped at 50, with an opaque nextCursor. Codex reads native unarchived threads. Other Agents expose ARC-stored tasks only because their drivers have no native history/archive contract. The frontend appends pages near the scroll boundary, memoizes rows, and sizes cards from their content. A delayed generic loading indicator appears only before any visible conversation is available; account-filtered pages keep that initial indicator continuous. Later pages retain visible rows without flashing a loading message. The list exposes request progress through aria-busy. Hidden lists stop requesting pages. Metadata stays mounted across details/back navigation. Timelines load only after selection; listing never resumes sessions or builds each conversation timeline. Codex list metadata reuses the incremental native-record scanner for turn configuration and distinct turn IDs, with a bounded in-memory cache of scan offsets. Other Agents read persisted task configuration and turn metadata without retaining output payloads. Metadata observed while the panel is mounted remains available after a live task disappears from the activity snapshot, even before it appears in a history page.

Source panels use the fixed left M Panel and shared focus behavior; [source-panel.tsx](../../design/surfaces/source-panel.tsx) defines their presentation. Left/right views are mutually exclusive and switch directly across sides. Left panels reserve the M slot width plus the side margin through one available-width input to topology layout. Expanded panels overlay the scene without reserving space. The selected source's secondary arc meets the nearest panel edge. Right bubbles remain visible with existing clipping/fade. The selected source retains its normal scale without an outline or halo, with a brighter primary tentacle and flowing connection to the panel edge. Narrow/reduced-motion behavior matches Agent views.

Panel links keep their existing topology form and attach from the selected outer arc to the fixed panel edge nearest the node. Shared Panel geometry reports the measured frame to the existing painter; it never derives the shell position or width from a node, spring or connector. Closing releases the fixed reservation immediately. No trigger copy or node-following close animation remains.

The Platforms workspace selects a platform family and lists its connector instances. [platforms.tsx](../../design/surfaces/platforms.tsx) defines its connected and empty forms. Add control source in the selected platform's header opens the shared setup dialog at Connection with the product preselected. Platforms with multiple products expose one Add action per product in a menu. Setup and its stacked Add connection dialog are hosted at the application level so the platform workspace remains the return destination when cancelled. ARC receives connector instances after authorization in external products. Each source ID retains its own card, even when several instances share a product or account. Cards show available product/client facts, connection and timestamps, plus authorization-provided identity fields when present. Local Agent account data never fills absent connector identity. Edit and remove remain available in each connector header. Edit replaces the name with an inline form: Enter saves, Escape cancels, errors stay with the input, and finishing restores edit-trigger focus. A pending save keeps its control in place and disables sibling actions. Connection state accompanies the name; related authorization facts share metadata lines without dropping unavailable-field distinctions.

Homepage source-side platform roots open the same connector information. Connector nodes open activity scoped to their source ID. The platform logo opens connector information. Width and close controls retain their shell behavior. Source sections reuse Agent headings and the shared task-row forms. Dispatch rows open their bound turn only when it exists; pre-dispatch operation states remain visible without an open action. Source activity does not aggregate other connectors through account membership.

Local Agents remain on the Agent side. Multiple profiles open an Agent account selector containing email and quota; selecting an alias opens that profile's activity. Single profiles open activity directly. Agent selectors do not navigate into Platforms. Account refresh belongs to its account heading and updates that account’s displayed quota; it disables profile selection until settled. A native Agent without provider accounts retains refresh and settings beside its readiness message. Width controls, Escape and focus restoration retain the existing shell behavior. [agent-platform.tsx](../../design/surfaces/agent-platform.tsx) defines both forms.

The homepage reads the source management API and renders one node per non-pending, non-revoked source, including several sources on one connection. Node selection, persisted ordering, and dispatch filtering use source IDs. Client self-reported names are diagnostic facts, never identity keys. Do not infer provenance for older unattributed records.

Outer arcs share an action fan across hub, platform, connector, Agent and profile nodes. Entering the node, arc, or outgoing tentacle rectangle reveals compact buttons that move slightly outward from evenly spaced origins. The rectangle starts at the icon's inner edge and ends at the outgoing branch endpoints; its vertical extent includes the icon label and complete branch span. Incoming primary wires do not reveal the node's actions. One scene-level pointer check owns disclosure, so crossing icons, strokes, labels or empty space inside the rectangle never dismisses the actions. Smaller nested rectangles take precedence. Rectangles follow animated geometry without intercepting node or bubble input. Expanded centers keep equal separation and sufficient room for each button. A hover bridge and short dismissal delay preserve access while moving from arc to button. Buttons have no tooltips. Accessible labels remain on every action. Keyboard focus also reveals the actions; Escape returns focus to the owning node or hub entry. Touch taps toggle the fan. Reduced motion removes the transition. Collapse is available for nodes with children or tasks. Mark all as read appears only when the node or its descendants contain unread completed tasks, including folded branches and overflow queues. Source attribution prefers the recorded source ID over historical account membership. Unread source leaves retain an outer arc for this action.

The hub's two outer arcs fold the entire source or Agent wing. At most one wing is folded. Folding closes that side's detail panel, preserves its nested collapse preferences, and retains the arc's expand action. Selecting a task or node in a folded wing expands it; an empty opposite wing also restores it. Wing state uses the existing topology collapse preference. Both landscape and portrait controls follow the animated ear geometry.

Studio lighting changes the backdrop while panels retain the shared design theme. The Board header uses the same three rows in standard and Studio display. The date and weekday sit above the minute-resolution local clock. The bottom row opens the Board and shows the current running and actionable pending task counts or the Board label when idle. Counts use the same execution and response projection as task bubbles. Completed, interrupted, failed and unconfirmed tasks do not enter either count. Submitted or history-resolved requests do not remain pending. Activity read failures replace stale counts with an unavailable state.

Recent dispatches reveal eight more rows near the scroll boundary. Existing APIs expose Codex dispatches only. Only the latest dispatch per conversation links current status, including newer dispatches from another source. Activity snapshots precede tasks/runtime/{id}. A completed receipt is not task completion. Missing fresh runtime evidence shows unconfirmed status. Running/readable pending rows enter Agent task details across sides. Do not add a separate all-records action.

Remote link opens Connection management, defined by [connections.tsx](../../design/surfaces/connections.tsx). The list includes every external ingress, including unused ones. Add connection lives in the panel header. Each card shows its name, state and associated source icons with visible names, followed by its address, provider and connection method. Relay Worker version remains beside its provider information. Cards expose copy, dedicated-tunnel editing, relay retry/update and joined-relay Leave. Edit precedes removal. Cards do not open a secondary detail view or offer source creation. Removal names affected sources and preserves their names and history as disconnected. Cross-connection migration uses the existing Connection, Update address and Reauthorize dialog. Relay sharing, member devices, and owner Delete belong exclusively to the Relay hosting capsule entry. Joined relays remain connections.

Creating and approving follow [setup.tsx](../../design/surfaces/setup.tsx) and [Remote link › Placement rule](remote-link.md#placement-rule). Add control source, Add connection and Change connection reuse the shared dialog, choices, fields and copy control. Dialog owns modal focus containment and consumes outside pointer input. A stacked Add connection retains its parent in place beneath the scrim. Both dialogs use the unified M viewport dialog slot. Connection context alone does not create a stacked layer. Canceling a stacked Add connection preserves the mounted parent draft and restores its focus. Source completion highlights the new homepage node for two seconds; reduced motion keeps a static ring for the same duration. The method step uses close for dismissal; success keeps the action to add another source or continue with the connection. Empty connection selection offers creation methods without a disabled Continue action.

Relay methods retain cancellation, retry and account selection. Running steps combine state and duration, with the active spinner in the step tile. During setup deployment the footer contains Cancel and the busy action; Back is unavailable until the operation ends. Cancel calls the relay cancellation operation and restores configuration. Waiting for a client also uses a busy footer action. Own address and Secure Tunnel reuse IngressDialog's configuration logic without a platform picker. Credential links accompany their field labels. Domain and connection name stay together, and tool counts accompany the capability disclosure. Form submission retains native validation, field error associations and focus on the first invalid field. Ready cards group state and source count under the connection name before the address label and copy field.

Inline approval groups the pairing code with its comparison instruction and combines the client self-reported name with permission scope. The account field and Approve/Deny actions retain their associations and submission behavior. Reauthorization and connection switching preserve source claims and history. Pending requests remain individually selectable. Non-OAuth connections disclose that pairing-code approval does not apply and carry one source. They reach success only after an observed client connection, rather than listener readiness. Welcome follows the welcome form in [setup.tsx](../../design/surfaces/setup.tsx): local and remote choices open the matching product group; Codex and permission readiness share one status line while keeping their separate actions. Automatic Welcome waits until the source API has loaded and only opens when there are no non-pending, non-revoked sources and no other setup or detail is open.

Activity phases never change ordering. Completed unread bubbles remain until marked as read or their details are viewed. Mark as read dismisses immediately. After leaving details, bubbles remain about 2s then fade. Completion while details are open counts as read immediately. Details retain acquired results until that layer is left. Read acknowledgements persist across reloads and app restarts in WebView storage, bounded to 30 days and the newest 1000 agent/task records. A new observed turn clears its prior acknowledgement. Native-app badges remain separate. reduced-motion switches directly and stops flow. See [Task tracking](task-tracking.md#homepage-ui).

Workspaces use the shared nonmodal [Panel](../../ui/components/ui/Panel.tsx). Settings, Platforms, Permissions, Pets, Relay hosting, Devices, Connections, Agents management, Coordination Board and MCP hub all use the center XL slot at 960px, capped by both 16px viewport margins. There is no per-surface size prop. The explicit width toggle expands to the available width and its state carries across workspace switches. The top line is 48px on desktop or 20px in the browser. The current height always stays centered vertically between that line and the bottom margin. Growth, allowed shrink and content replacement move both edges symmetrically with a shared height and y transition. Header and footer stay fixed while the body scrolls at the cap. Capsule switches replace content inside one mounted shell without entry or exit animations. Nested dialogs keep the parent visible and stationary beneath their scrim.

The layer store permits one panel. Opening another replaces it. The navigation capsule remains available as the workspace switcher. Another capsule entry replaces a clean workspace and shows its discard or running footer when needed; the active entry toggles it closed. Keep editing or Keep open withdraws a pending switch. Other outside pointer input closes a clean workspace and consumes the release and click. Workspaces without ordinary actions create a footer only for dismissal states.

The bottom-left capsule sizes to its visible controls with compact, equal edge padding. It contains Settings at the left edge, then Platforms and Permissions & readiness. Pets adds a paw entry only while enabled; it opens the pet library in the shared workspace Panel with normal width, close, Escape and focus-restoration behavior. Disabling pets removes the entry and closes its workspace if open. Homepage topology tuning adds a slider entry while enabled. Display settings appears when the studio background is enabled, followed by the update entry when available. Display settings shares the capsule's hover and keyboard behavior and opens lighting and fullscreen controls above its trigger. Platforms lists supported platform families as logo-and-name menu items and shows their authorized connector instances as cards. GitHub products belong to Microsoft. Each card exposes observed authorization facts and timestamps, a custom name, and removal that revokes access while retaining history. Local Agents and their accounts are separate from platform connectors. Connections are managed from the upper hub arc. Settings contains behavior, general preferences, network, and About, with an Experimental action beside the repository link. Relay hosting adds a cloud entry while enabled and uses the shared workspace Panel. The permission workspace shares readiness with its icon and requests authorization only through explicit actions.

The center dots open Add a control source and Agent management. The upper and lower arcs show remote transport and local Core availability independently. Hover or keyboard focus reveals each arc's actions. Connections is available in every upper-arc state, including an empty connection list. An unavailable service offers its own recovery action. The read-only browser exposes connection management reads. [Design sources](design.md#arc-health) owns the mark and recovery forms. Hovering the mark or keyboard-focusing either dot reveals both symbols. Dot growth shortens the nearby arc ends to preserve cap clearance. Reduced motion applies the geometry directly.

Topology follows [Accounts → Topology](accounts.md#topology). Source trees use platform roots and one child per connector ID; flat mode keeps those instance identities and labels. Local Agent profiles retain account-scoped quotas and task attribution. Source-ID task attribution takes priority over historical account attribution, so two connectors sharing an account do not light each other's paths. Tree and Flat share persisted order and collapse overrides. The account read adapter remains responsible for local Agent quota/profile data. Single-account Agents retain Agent-wide native history and shared quota fallback; multi-account views remain explicitly scoped. Collapse controls appear only for nodes with children or tasks. Wire, node and task dimming share the animator; reduced motion switches directly.

The `?scenario=topology-accounts` development fixture supplies two shared Claude identities, a shared ChatGPT/Codex identity, a single-account dsh Agent and running, pending and completed tasks. Multiple source connections share one Claude account; two additional source-only `Unidentified` accounts have distinct IDs and identical aliases. Reads and preference writes stay inside the development scenario; unsupported actions fail locally. Use this scenario from the main checkout after landing; coding lanes do not run the app or acceptance.

## Experimental features

About contains one action named Experimental. Activating it directly opens the switch list inside the Settings workspace, with no intermediate Extras page or sub-navigation. Its header keeps width and close controls, adds a back arrow, and reads Settings / Experimental. Back or Escape returns to Settings and restores focus to the Experimental action. Content switches without morphing the workspace shell.

Experimental rows contain enable switches only, with descriptions of their effects. Enabling a feature with configuration or interactive controls adds its entry to the shared navigation capsule; its controls live behind that entry rather than inside Experimental or a separate floating launcher.

Relay hosting is off by default. Its switch controls visibility of the capsule entry and management workspace, without stopping or deleting hosted relays. Disabling it closes an open hosting workspace and removes the entry. Connection cards have no separate hosting shortcut.

Relay hosting lists only owned relays. Its empty state follows [relay-hosting.tsx](../../design/surfaces/relay-hosting.tsx), grouping the title, empty message and Deploy new relay action. Deployment reuses Cloudflare login and connection progress, including account selection, cancellation and retry. The first Relay list read may delay shell entry by up to 200ms. Retained height starts from the first visible content, avoiding an empty workspace sized by a brief loading state. The workspace height follows its content and scrolls when constrained by the viewport.

Each relay has a bordered 12px card: a 36px cloud icon tile, an ellipsized monospace hostname, Cloudflare Workers with Worker version readiness or Update, and a Running or Offline pill. Tokenized connection addresses and invite links are never rendered here. The subtle footer contains Invite link, its purpose, Copy invite link, and Reset. Reset confirms that the old link stops working while existing devices remain connected; the replacement link is copied separately.

Connected devices has a privacy description, an icon-only refresh action, and a bordered Device / Joined / Last seen table. Dates use compact local time; activity within two minutes reads just now. The management API identifies the self instance by its cryptographic instance ID. Its row displays status.deviceName and This computer, with no Remove action. Other members retain their registered names and have a ghost Remove action with confirmation. Create and join register the computer's device name independently of the relay's display label.

A separated bottom danger zone contains Delete this relay, the consequence for every connected device including this computer, and an outline danger Delete action. Reset, Remove, and Delete use the shared Dialog. The switch list also contains maintainer mode, homepage topology tuning, pets and studio display.

## Experimental topology controls

Settings → About → Experimental → Homepage topology tuning enables a slider entry in the navigation capsule. Activating that entry opens a Radix popover above it while keeping the topology visible. The parameter list scrolls within the available viewport height. Close or Escape dismisses the controls and restores trigger focus. Outside interaction dismisses the controls while preserving the clicked target. Opening a workspace or another modal closes the popover without stealing its focus. Disabling the feature removes the entry. The entry stays anchored to the capsule and has no draggable position or persisted open state.

solve.ts PARAMETERS owns keys, groups, localized labels, ranges, steps, and defaults. Six groups show sliders and number inputs. Right-side line arrows expand groups/JSON import with 160ms height/opacity transitions, direct under reduced-motion. Dots mark overrides. Reset works per item or globally. Sliders support arrows/Home/End. Preview immediately and save on release, keyboard change, or input completion. Position/shape changes use existing springs with same-frame connection geometry. reduced-motion takes precedence over slow motion.

Preferences store `{ "schemaVersion": 1, "overrides": {} }`, only for nondefault values. Untouched values follow upgraded defaults. Disabling topology tuning hides its entry without disabling saved parameters. Guides and slow motion are session-only.

Copy JSON exports overrides. Import replaces the entire override set, restoring omitted defaults. Reject invalid JSON, unknown versions/fields, and nonfinite values without partial application. Clamp finite out-of-range values and explain. Number inputs also clamp. Empty/nonnumeric input restores that default with feedback. Slider step controls increments without snapping valid typed values.

SVG guides show current control points, tangents, viewport center, and center offset. L/R shows target equivalent wing widths and column-spacing ratios. Slow motion ×0.25 slows geometry springs and line flow while dragged items follow the pointer normally. Guides ignore hit testing. Stationary scenes stop rAF.

## Controls and forms

Reuse Button, Input, Slider, Field, SingleChoice, Switch, Dialog, Tooltip, Popover, menus, tables, and feedback from ui/components/ui/index.tsx. Radix owns selection, keyboard, focus, dismissal layers, Portal, and modal interaction. Layout components only arrange content.

- SingleChoice uses pills for at most five options when space permits, otherwise dropdowns. Its tabs form provides panel navigation with the same Radix keyboard selection and narrow-space fallback. Platform selection uses its navigation form; resource scope can request its dropdown form directly. [single-choice.tsx](../../design/components/single-choice.tsx) defines the forms. Remote-link product and connection choices retain Radix navigation.
- Native forms default to one column with labels above. Only short related fields share rows.
- Field errors remain associated with inputs. Failed submission focuses the first error and preserves input.
- Dialog has an accessible title, a fixed header and footer, and a scrolling body at the content-height cap. Its width is the shared M slot width. `layerFrame` owns stateless viewport geometry. Dialogs stay horizontally and vertically centered for their current height. The top line is 48px on desktop and 20px in the browser. Narrow and portrait dialogs fill the viewport width minus both 16px side margins.
- `TransientLayer` preserves each portaled transient's layer owner. The layer store owns scrim, dialog and transient stacking order. A transient sits above its owner and below a stacked child dialog. Select in either position, menus, popovers and tooltips share this rule. Input inside an owned transient belongs to its owning layer's input boundary.
- `ui/state/layers.ts` owns the open-layer registry, immediate clean switching, deferred dirty or busy switching, dismissal and focus restoration. At most two dialogs are stacked. First-level layers have no scrim; only a dialog over another panel or dialog dims everything beneath it. Modal focus containment and consumed outside dismissal stay active without a scrim. A child retains its parent's mounted content and viewport position beneath the scrim. Only the top layer handles Escape or outside pointer input. Clean layers close. Edited input means changes not yet submitted. A submitted value whose attempt has finished, with any result, is clean until edited again. Edited input replaces footer actions with a discard confirmation focused on Keep editing. Running work replaces footer actions with a pending-close message focused on Keep open. Cancellable work also offers Stop and close. A pending close completes when the work finishes unless Keep open withdrew it. Close and Cancel close clean or dirty layers directly. During running work they show the same pending-close footer as outside input. Closing restores trigger focus, falling back to the layer below. Outside dismissal consumes the pointer release and click.
- Icon buttons have accessible names. Disabled/loading/empty/expired/failure/success states reflect real responses.

`UiProvider` owns explicit physical Panel slot hosts.
`PanelRoute` retains the committed React owner while its keyed replacement prepares.
Panel content stays in its feature context and switches without host timers or an external React-content registry.
The shell observes one natural content container and listens for viewport changes.
Nested scroll views register their intrinsic content and cache fixed chrome when their structure changes.
Streaming text does not trigger subtree mutation scans or temporary body-style changes.
The layer registry owns the sole outside-pointer dismissal path and its shared switcher selector.

## Theme and motion

design/tokens.css is the token source. ui/tokens.css imports it and adds runtime-only tokens for spacing, hover tints, soft state colors, brand artwork, charts and the topology. ui/theme.ts follows the system by default and applies explicit light/dark overrides. The Agent theme color tints only the topology Agent side; controls use the design accent. IDs/credentials use shared monospace styling.

Agent artwork is resolved by `ui/assets/brand-reserve/magpie/manifest.json`. Agent roots, account children, panels, and quota views use the same mapping. Control-source products and provider platforms use separate mappings, even when they reuse the same SVG. The product picker reads the shared control-source registry; remote MCP clients are grouped under Remote connections.

Functional icons use shared Icon with Lucide and a 1.75px rendered stroke at every size. Icon buttons stay circular; local overrides change only `--icon-button-size`. Brands retain their assets. ui/style.css owns controls. ui/product.css owns product layout.

Motion owns layer entry, exit, content crossfades and geometry transitions. Every dialog and panel enters and exits with an opacity fade. The trigger is used only for focus restoration. `layerFrame` computes the current height and y from the slot and viewport without placement history. Geometry settles instantly during the entry fade, including content arriving after the first measurement. After entry, height and y transition together over `--motion-base` with `--ease-enter`, keeping the vertical center fixed throughout growth, allowed shrink, view reset and content replacement. Retained height still applies within one panel view. Same-slot replacement keeps the shell mounted and crossfades its header and body. Cross-slot switches fade out and in concurrently. Reduced motion applies geometry and opacity changes instantly. Related tooltips remain mounted and move/resize continuously between triggers. HoverScope uses shared token-driven highlights following pointer, keyboard, and Radix state.

## Functional pages

Agent panels retain task rows and execution details. [design/surfaces/agent-panel.tsx](../../design/surfaces/agent-panel.tsx) defines the overview and empty forms, and [task presentation](../../design/modules/task-presentation.tsx) defines TaskBubble and TaskRow. [Agent activity](../../design/modules/agent-activity.tsx) and [source activity](../../design/modules/source-activity.tsx) own their grouping, metadata and disclosure policy. There is no standalone Tasks page. React renders titles, code, and lists without executing raw HTML.

Request logs remain available through native management interfaces; there is no standalone Records page.

Connections expose editing directly on their cards. Forms own provider/domain/credentials/authentication. Tool lists are views inside their owning dialog. Back and Escape return to the retained form and restore focus to the tool-list trigger. The header shows the owner title as a breadcrumb. Content crossfades while the shell keeps its slot and size. Tool changes remain in the owner draft and participate in its dirty state. Name/policy/auto-start edits preserve OAuth grants and live connections. Fixed tools remain guide/query/act. Lists target ops, showing query/act ownership and local availability. Domain fields accept hostnames or full HTTP(S) URLs, extracting the hostname and omitting port/path/query. Service assembles MCP URLs. Credentials, authentication and operation policy fields are shown directly. Blank existing-secret fields retain values. OAuth consent, denial, and revocation are explicit actions.

The settings, Agents, Agent details, display and Experimental forms follow [settings.tsx](../../design/surfaces/settings.tsx). Each setting occupies one row, with its name and effect on the left and its control on the right. Sections group settings by their scope. Task-bubble preview occupies its own area above the density and width rows. Single-choice controls use their dropdown form when the row cannot fit pills. Agent details retain versions, official setup, discovery errors, quota and dispatch defaults. Homepage follows Agent order rather than provider order. Installed enabled Agents support pointer reordering. The list toolbar opens quota overview and display settings; the header provides the single inventory refresh action. Drag starts only outside clickable controls. Icons/links/switches retain clicks. Focused cards also support arrow sorting. Management/homepage share persisted order. Full versions remain available on hover. Uninstalled entries link official installation. Display settings control task bubble density, width and auto-compact, homepage Agent count, and quota presentation. The Agent panel settings action opens display settings directly. Agent, Agent platform, account and control-source overviews fit their content within the viewport. They use fixed M slots at the center of the available vertical interval and retain their largest height while open. The header stays visible while the body scrolls at the cap. Initial opening waits up to 200ms for the first required history page, account list, dispatch feed or connector list. A slow read shows Loading in the affected body, and a failed read shows Retry there. Task details and connection editing fit content up to the bottom margin.

## Subscription quota

The homepage Agent icon summarizes the selected quota window. Agent panels show the available quota windows in the shared [Agent icon](../../design/components/agent-icon.tsx). A single ring marks elapsed time in used mode and remaining time in remaining mode. An inset dashed arc joins the tick to the quota endpoint. It uses danger when consumption is ahead of elapsed time and success when consumption is behind. Equal progress and unknown timing omit the dashed arc. Two windows use left and right arcs. Remaining quota stays anchored at the bottom of each half, and consumption advances from the top. Three windows use equal sectors in session, week and month order. Each segment marks elapsed time within its own window, including windows with no consumption. When timing is unknown, the muted tick sits at the start of its arc and the icon reports that timing is unavailable. Agent settings use brand marks. Quota windows retain reset countdowns or times and remaining or used percentages. Both bars mark time progress from their own known period and reset time, including windows with no consumption. Each window shows its own pace or estimated exhaustion hint beside its percentage. Exhaustion estimates require a usable reset time and enough elapsed consumption; estimates are shown when the window is projected to exhaust before resetting. Agent activity refresh updates its displayed account or provider quota and retains the initiating control while pending. Agent panels and account quota sections share `AgentQuota`. Account-scoped panels use the account alias and that account's quota; platform panels retain platform subscription data. Providers without a usable window show one muted line. Settings quota follows [quota-overview.tsx](../../design/surfaces/quota-overview.tsx). QuotaBubble retains plan links, other window readings, reset times, pace, time ticks, credit-expiry details, and product usage. Overview refresh updates every visible enabled provider and reports failures; individual Agent details retain provider refresh. UsageHistory owns hover/focus spring following, collision placement, and layered Escape. Quota detail tooltips remain reachable by hover and keyboard focus. No historical charts are drawn.

Settings retain homepage count, remaining/used, countdown/date, enablement, and refresh interval. Sources participate automatically by Agent. Quota data appears by default when available. Homepage rings use weekly quota only and disappear without it. Details retain other upstream windows. No local usage periods, tokens, or money display.

## Pet library

[pets-settings.tsx](../../design/surfaces/pets-settings.tsx) defines the pet workspace. Community links precede the import form. URL import, ZIP import and package removal show pending state on the action being performed and disable conflicting actions. Installed pets retain default selection, removal eligibility, provenance, preview and rights information. The homepage pet layer and node assignments keep their existing behavior.

## Update notification

[updates.tsx](../../design/surfaces/updates.tsx) defines the update panel and About forms. Release notes scroll independently of the header and actions. Installing retains the release notes and footer, changes the primary action to a non-interactive pending button, and disables Skip this version. The button announces installation progress without a duplicate body status or restart advisory. Shared Button busy uses the full-strength pending form in [button.tsx](../../design/components/button.tsx), with its spinner and disabled interaction. Downloading shows byte progress from the official updater events. A ready download exposes **Update and restart**, which immediately installs and restarts without a timing picker, task-impact groups, countdown or confirmation. Running ARC tasks are interrupted. `?scenario=updates-long-notes` supplies long Release notes for this layout.

## Verification

Check light/dark, narrow windows, long Chinese/English text, keyboard traversal, layered Escape, focus restoration, and field errors. Run existing checks without adding unit tests. Browsers verify rendering. Installed WebView, tray, and lifecycle require separate real acceptance.

## Execution specifications

Task bubbles, Agent conversations, task headers, and model and effort picker triggers share the [dispatch spec](../../design/modules/model-configuration.tsx). The [effort gauge](../../design/modules/model-configuration.tsx) uses the matching model's ordered levels and points to the recorded or previewed level. A value outside that model's available catalog stays readable as text. Fast reflects the recorded service tier. Editable defaults retain the stepped slider and preview the selected level with the same gauge.

## Task detail projection

Task detail presentation composes [timeline parts](../../design/modules/timeline.tsx) in [task-detail.tsx](../../design/surfaces/task-detail.tsx); request sheets follow [request module](../../design/modules/request.tsx), and task model selection follows [model configuration](../../design/modules/model-configuration.tsx). Shared question choices, effort selection and actionable routing follow [single-choice.tsx](../../design/components/single-choice.tsx), [effort slider](../../design/modules/model-configuration.tsx) and [request routing](../../design/modules/request.tsx).

Successful turns fold their process; failed and interrupted turns start expanded and honor subsequent disclosure choices. Previous turns start collapsed. Expanded previous turns omit the duplicate final-reply preview and put the process disclosure beside the turn metadata. Process summaries omit duration and facts already shown by the turn header. Tool disclosures remain independent keyboard targets when grouped on one line. Running commands retain their live log behind the run disclosure and keep a separate command-details control. The latest thinking summary belongs with the latest narrative; a thinking-only turn keeps it independently. A plan label and its step share a row. A failed turn shows its failure evidence once in the outcome, with the failed tool disclosure beside the outcome title. Changed-file summaries join the count and filename when one file is recorded; longer lists show the first three and disclose the rest. Added and deleted files carry native operation evidence; later edits retain a recorded creation marker.

Pending execution questions and permission requests show a request dock for every source, including ARC-local turns, while execution is running. The header derives attention from the same answerable, unsubmitted request set. An unanswered interaction appears in the dock rather than duplicating its entry in the timeline. Resolved history overrides stale activity requests and remains readable in the timeline. Each request has its own card. Passive routing describes the sheet or dock under its title. Actionable routing sits immediately above the request's final action row. Permission scope appears under the request title. Question options, the associated Other field, and actions stay in reading and keyboard order. Submitting keeps the action row mounted, sets Button busy on the active action and disables siblings; failures and uncertain results remain visible without discarding drafts. Requests disappear after resolution or execution ends.

At 360px of panel width or below, the pending-request entry opens the shared viewport Dialog. All request dialogs use the M slot. Outside input and Escape follow the shared dirty/running dismissal rules. Close preserves selections and free-text drafts and restores focus to Open after any running submission finishes. Long question fields and permission previews scroll while the footer actions remain fixed. The inline dock uses at most 60% of panel height, leaving the timeline its own scroll area. The overflow menu retains native-open and width controls.

Prompt source labels use recorded provenance; prompts without a source omit that metadata. Header duration follows the metadata pills inline, separated only by their gap. The header reuses the bubble execution-spec pill for model, effort and optional fast mode. Task model selection affects later turns only when the dispatcher omits a model. Its model menu opens next to its trigger with viewport collision handling; effort commits on release and retains keyboard slider controls. Escape dismisses the picker before reaching the task model dialog. Pending autosaves show the shared running-work footer when dismissal is requested and survive explicit Close and reopening. Review feedback is optional supplementary information. Missing feedback creates no awaiting-review state. Read failures announce an alert and remain retryable inside that region; they do not affect execution state, sorting, notifications or task controls.

Control sources own dispatch, queue changes, interruption, and review. Task details expose no composer, purpose selector, stop, or review actions. The latest failed turn offers Retry inside its outcome; the latest interrupted Codex turn offers Resume there. Retry sends an explicit continuation in the same task and retains its receipt requestId on uncertain retries. The continuation asks the Agent to inspect existing work and avoid repeating side effects. Chinese UI durations separate numbers and units with spaces.

Development scenarios mock task receipts, queue/review reads and explicit actions in memory. Open `?scenario=task-actions` in the Vite development UI for read-only queue/review state and execution question/permission controls. `timeline-multi-turn` also supports these task operations. Mock control-source sends complete immediately when idle so continuation and review states remain inspectable without running an Agent. Responses and resulting timeline/queue/review state can be read again; reloading resets the scenario. Unsupported mutations fail locally and never fall through to Core. Fixtures exercise UI behavior, not native execution ownership or provider acceptance.

## Account privacy and development scenarios

The persisted `arc.privacy` preference masks emails, organization names, identity keys, notification session names, and connection addresses. Settings > General owns two SingleChoice icon options for showing or hiding sensitive information; Accounts and source-panel headers have no separate toggle. Aliases, topology labels, task titles, prompts, and task bubbles remain readable.

Render sensitive fields and each part of compound email/organization lines with `Sensitive`. Hidden fields contain deterministic stand-in letters, preserving whitespace, `@` and `.`, with a soft inline blur and reduced opacity in both themes. Off-DOM font measurement reserves the original text width and scales stand-ins to fit it; narrow containers clip the inline run. Multiline identity fields use `wrap` to let both visible text and masked stand-ins wrap naturally within the card instead of reserving a fixed inline width. Never keep raw values in hidden elements, titles, accessibility labels, input values, or data attributes. Plain-text tooltips and upstream notices use bullet masking for known identities and email substrings. Reduced motion disables the short blur-in animation.

`SensitiveInput` displays bullet stand-ins and becomes read-only while masked; turn privacy off to edit. Copy buttons continue to copy the real value from React state. Turning privacy off restores the exact original text. Snapshot requests and development scenarios enable privacy before rendering; AX and management responses remain unchanged.

`?scenario=accounts` opens the account workspace in English/light mode. `?scenario=source-panel` opens a source panel with pending and running dispatches in Chinese/dark mode. Both use invented example.com identities and in-memory management responses. Claude and Codex sign-in complete after four accounts list reads; only Claude accepts an example code. API-key login remains unfinished with native guidance. Detection lists observed profiles without inventing a single completed identity. Rename, default selection, reauthentication, notification binding/testing, removal, source correction, enablement, and connection switching have readable fixture state. Unsupported mutations fail locally. The scenarios do not authenticate with a provider.

`ui/types.ts` owns the native account types and `accountsApi` in `ui/api.ts` owns management routes. Login polling reads the list's `login` field and code submission receipts do not imply completion. Notification tests send to an explicit session target; manual binding assigns a host route and does not verify delivery. MCP Events exposes observed reachability without Claude notification actions. Unidentified sources retain their native alias and have no inferred identity or fake reauthorization recovery. `defaultFor` selects a replacement default; clearing a default has no operation. Current native limitations also include API-key authentication through each Agent's CLI and no provider identity claims from MCP OAuth grants.

## Execution evidence and supplementary feedback

Homepage bubbles, Agent rows, detail headers, topology wires and bound source-dispatch rows use the same execution-state projection. Only a current activity observation establishes running or waiting for input. A recorded terminal turn establishes completion, failure or interruption. A disappearing activity retains an unconfirmed task until native history supplies its result. An idle runtime alone establishes no outcome. Background history reads are shared per Agent/task and do not acquire execution ownership. New turns invalidate the previous turn's live presentation.

Only running tasks show thinking, command, file, tool or response phases. Interaction is represented by waiting for input, and idle has no phase label. Source-dispatch approval, submission, nonexecution and submission uncertainty remain operation states before a bound execution result is available. Historical dispatch rows remain openable and retain their own turn result while the conversation continues. Opening a dispatch selects its bound turn, labels that turn and its duration in the header and expands its timeline turn without borrowing a newer turn's live state.

A held writer with a confirmed ARC or Desktop owner may show a compact ownership label. Unknown owners and unidentified external writers have no inferred identity label. The task UI has no handoff-history popover. Native writer authorization and recovery keep their existing boundaries.

Reviews retain their recorded verdict, author, timestamp and optional note. They do not certify execution completion. Review reads are on demand. Review availability never blocks dispatch or mutates another execution state. A rework verdict does not automatically classify the next dispatch as rework.

[Task relationships](../../design/modules/task-relationships.tsx) defines the shared family trunk, relationship labels and parent navigation. Task activity exposes `parentSessionId` and `relationKind` from native evidence. Codex subagents use `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` with `relationKind:subagent`. Attached side chats use `attached_thread:true` and `forked_from_id` with `relationKind:side-chat`. A fork ID alone does not establish a side chat. The scanner retains both fields independently of the bounded activity tail and merges them into live sessions.

The UI resolves native session aliases within the same Agent. Descendants follow their parent in both topology orientations. Each family shares one neutral trunk; task bubbles and detail headers retain the type independently of execution state. A collapsed family shows three immediate children, plus children awaiting input or selected in the detail panel. Overflow belongs to the nearest visible ancestor and expands that family without opening a panel or expanding other families. Root overflow retains the full-queue action. Escape collapses it and restores trigger focus. Independent roots retain their own queue slots. Reordering is limited to siblings. Detail headers provide parent navigation, including a metadata lookup when the parent has left the activity list. Missing parents and cyclic references remain independent roots; titles, directories and dispatch origins do not establish ancestry. Claude sidechain exclusion remains unchanged because those files do not enter the current activity feed.

## Coordination Board

[coordination.tsx](../../design/surfaces/coordination.tsx) declares Current, empty, Activity gap and unavailable regions; [modules/board.tsx](../../design/modules/board.tsx) owns their parts and presentation. Current and Activity are panel navigation after the title; refresh joins the close action. Current filters by status and resource scope in that order. Activity uses only the resource scope, which remains available even when no resources have been observed.

Overview rows retain complete titles and combine owner, time, coverage and resource names into metadata. Observation coverage qualifies the attention section without replacing its retained records. Notices keep their error detail and recovery action; absent joined values add no separator. Refresh, retry, cursor reset and pagination retain the initiating control in a pending state and disable sibling filters and actions until settled. Closing and layered Escape retain focus restoration. Loading is also exposed through the Board region’s `aria-busy` state.

## Experimental MCP hub

The MCP hub switch is disabled by default and lives only in Settings → About → Experimental.
Enabling it adds the MCP hub workspace to the shared navigation capsule.
Disabling it closes that workspace and retains configuration.
The upper arc represents ARC-owned remote transport health.
The MCP hub uses the XL center Panel. Its height fits content and is capped at the bottom margin. The body scrolls beneath its fixed header; filtering and refresh retain the largest open height.

The summary counts servers, available servers, failing servers and enabled tools.
Search filters servers by name and tools by name or description, and opens matching tool lists.
Servers retain their transport, command or endpoint and observed state.
Cards offer reconnect, remove and an enable switch; removal confirms its consequence in a Dialog.
Facts show the tool count disclosure, configured env and header names, attribution and the last check time.
Tool descriptions and Read-only or Destructive hints repeat downstream annotations.
A failing card explains the failure category in plain language, keeps the native error readable and copies a fix prompt for an Agent.
[design/surfaces/mcp-hub.tsx](../../design/surfaces/mcp-hub.tsx) defines the ready, failed and empty forms.
There are no add or edit forms; Agents configure servers through `mcp_configure`.
Add server opens a Dialog of copyable Agent prompts for import, Streamable HTTP and stdio servers.
The empty state offers the import prompt with a product choice.
Privacy mode leaves server names, commands, endpoints and prompts readable; env and header values are never rendered.
See [MCP hub](mcp-hub.md) for ownership and session behavior.

## Navigation and interruption

Pending OAuth requests appear in Board attention. They never open a dialog automatically. A user-started setup or connection-switch flow may advance into its approval step. Opening an approval from Board is an explicit action.

Board-to-task navigation retains an explicit Back action to the Board and restores the originating row. Closing task details closes the panel. Add connection opened from Connections retains the parent panel, visible and stationary under its dialog scrim, and returns focus to Add connection.

Tray and deep-link navigation received while a dialog is open becomes actionable Board attention. It does not discard, replace or navigate behind that dialog. The user opens the deferred target from Board after closing the dialog.

## Layer contract

- ARC MUST classify every overlay as exactly one kind: panel, dialog, transient or toast.
- A panel is nonmodal working space: workspaces and node panels.
- A dialog is a modal task: confirmation, edit form or multi-step flow.
- A transient layer is a popover, menu, select list, tooltip or hover preview.
- A toast is a short message about something outside the current layer.
- At most one panel MUST be open.
- Opening a panel MUST replace the open panel.
- Navigation from one panel to another MUST keep a Back control to the previous panel instead of closing and reopening surfaces.
- At most two dialogs MUST be stacked.
- A child dialog MUST stack on its parent and MUST NOT unmount it.
- A stacked parent MUST stay visible under the scrim and MUST NOT move, scale or hide.
- Only a user action MAY open a panel or dialog.
- System events MUST surface as Board attention, a capsule badge or a native notification.
- Welcome MAY open automatically when there are no sources and no other panel or dialog is open.
- A flow the user started MAY advance to its next step automatically, including OAuth approval inside that flow.
- External navigation from the tray or a deep link MUST NOT discard an open dialog; its target becomes attention until the dialog closes.

### Placement

- Placement MUST depend only on the layer kind, the panel side and the viewport.
- The trigger position MUST NOT change where a panel or dialog appears.
- The top line is the window's top inset: 48px on desktop windows and 20px in the browser.
- The side margin is 16px.
- The left panel slot MUST hold source-side node panels, aligned to the left side margin.
- The right panel slot MUST hold Agent-side node panels and task details, aligned to the right side margin.
- The center panel slot MUST hold workspaces: Settings, Platforms, Permissions, Pets, Relay hosting, Devices, MCP hub, Connections, Coordination Board and Agents management.
- The center panel slot MUST be horizontally centered.
- Node panels MUST NOT follow the vertical position of their node.
- Dialogs MUST be horizontally centered on the viewport.
- Every layer MUST stay vertically centered between the top line and bottom margin for its current height.
- Height and y MUST transition together so both edges move symmetrically.
- Placement MUST be independent of history and trigger geometry.
- A stacked child dialog MUST use the same horizontal slot and width as its parent dialog.
- A dialog opened from a panel MUST use the dialog slot, not the panel's center.
- Transient layers MUST anchor to their trigger with collision handling.
- Only transient layers MAY be positioned by their trigger.
- Toasts MUST appear in one fixed region at the top center below the top line.
- Panels and dialogs MUST NOT be draggable.
- A layer MAY move after opening only when the viewport resizes.
- Below 760px wide and in portrait layouts, all panel slots MUST collapse into one full-width slot, and dialogs MUST span the viewport width minus both side margins.

### Sizing

- The slot MUST determine width without a per-surface size prop.
- Per-surface width literals MUST NOT be used.
- `--layer-m` is 560px for every dialog and left or right node panel.
- `--layer-xl` is 960px for every center workspace.
- Panels MAY expand to the viewport width minus both side margins through an explicit width toggle.
- Dialogs MUST NOT expand.
- Widths MUST be capped at the viewport width minus both side margins.
- Height MUST fit content.
- Height MUST be capped at the full interval between the top line and bottom margin.
- Layers MUST NOT stretch to the available height when content is shorter.
- Headers and footers MUST stay fixed while the body scrolls at the cap.
- A panel's height MUST NOT shrink while it stays open, so filters, tabs and refreshes do not move its bottom edge.
- A view change that replaces the whole panel content MAY reset the height.
- Opening MAY wait up to 200ms for the first required data, as it does today.

### Motion

- Motion tokens MUST own every duration and easing outside the topology animator.
- `--motion-fast` is 120ms for hover, press, tooltip and toast.
- `--motion-base` is 160ms for dialog and transient entry, content swaps, and synchronized height and y transitions.
- `--motion-panel` is 180ms for panel opacity entry.
- Exit durations MUST be at most their entry durations.
- `--ease-enter` and `--ease-exit` MUST be the only easing curves outside the topology springs.
- Every panel and dialog MUST enter and exit with an opacity fade only.
- The trigger MUST be used only for focus restoration.
- Transient layers MUST enter with a fade.
- Content swaps inside one layer MUST crossfade while the shell stays centered for its current height.
- Trigger morphing, visual copies of triggers, automatic shell morphing on content change and overshoot curves MUST be removed.
- Infinite animations MUST only indicate a running state, with at most one per element.
- Reduced motion MUST apply geometry and opacity changes instantly.

### Dismissal, focus and feedback

- Pointer input outside a panel, dialog or transient layer MUST produce a visible response.
- Escape MUST act only on the topmost layer and MUST follow the same rules as outside pointer input.
- Outside input MUST close a layer that holds no edited input and no running work.
- Outside input on a layer with edited input MUST show a discard confirmation instead of closing.
- Edited input means changes not yet submitted; a submitted value whose attempt has finished, with any result, is clean until the user edits it again.
- Outside input on a layer with running work MUST show that work's state instead of closing.
- When running work can be cancelled, that state MUST offer to stop the work and close.
- When running work cannot be cancelled, that state MUST say that the layer closes after the work finishes.
- Running-work states MUST offer to keep the layer open, and a layer whose close was requested MUST close when its work finishes unless the user chose to keep it open.
- Confirmations and running-work states MUST appear inside the layer, replacing its footer actions, without opening another layer.
- The confirmation MUST focus the action that keeps the layer open.
- Close and Cancel controls MUST close clean or dirty layers directly.
- Close and Cancel controls on a layer with running work MUST show the same running-work state as outside input, focus Keep open, offer Stop and close when cancellable, and close when the work finishes unless Keep open withdraws the close request.
- The navigation capsule and topology nodes MUST act as panel switchers: another entry replaces a clean panel, edited or running work shows its dismissal footer, and the active entry toggles it closed.
- Dismissal MUST NOT activate the element under the pointer.
- Closing a layer MUST restore focus to its trigger, falling back to the layer below it.
- Field errors MUST stay with their fields.
- The result of an action MUST appear inside the layer that started it.
- A toast MUST only report a background event or the result of an action whose layer has closed.
- A success toast MUST disappear after 4 seconds.
- An error toast MUST stay until dismissed, and an actionable error MUST also appear in Board attention.
- Copy confirmation MUST use one shared control state.
- Help on hover MUST use the shared Tooltip, not native `title`.


The layer registry in `ui/state/layers.ts` owns stacking, exclusivity, dismissal and focus restoration. `layerFrame` owns pure geometry. Panel and Dialog share one shell implementation. Portaled transient content retains its owning layer identity and a stack level above that layer.

### Retained panel replacement

The shared Panel provider keeps one shell mounted for each physical slot.
A same-slot switch replaces the header and body with a `--motion-fast` crossfade and animates height and y together around the fixed available-area center.
The width remains unchanged during a same-slot switch.
Narrow and portrait viewports treat all panel switches as same-slot replacements.
Different slots exit and enter concurrently without an empty frame.
Dirty and busy layers resolve their footer before switching.
Keep editing or Keep open withdraws the switch.
The active trigger toggles its panel closed.
New content receives focus and closing restores the latest trigger.
The workspace width-toggle state carries across workspace switches.
Reduced motion replaces content and geometry instantly.

First-level panels and dialogs have no scrim.
A dialog above a panel or dialog uses the existing 24% light or 60% dark scrim over everything beneath it.
Dialog focus containment, aria-modal and consumed outside dismissal remain active without a scrim.
The layer store starts clean switches immediately and coordinates deferred dirty or busy switches without waiting for the old close to finish.
