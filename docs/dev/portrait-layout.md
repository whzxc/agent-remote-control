# Portrait homepage layout

The homepage has two geometry solvers sharing entities, account attribution, persisted order, collapse overrides, task queues and stable-ID animation. `solve.ts` owns landscape geometry. `portrait.ts` owns portrait geometry; it never generates tentacles.

## Orientation

Display settings persist Layout: Auto / Landscape / Portrait, default Auto. Auto enters portrait at viewport width/height <= 0.85 and landscape at >= 1.0, retaining its current mode between thresholds (initially landscape). Evaluate 150ms after resizing stops; defer changes until pointer drags finish. Manual selection uses the same drag guard. `app.snapshot.model.topology` reports `orientation`, `source` (auto/manual), and pending orientation evaluation. `app_env.windowWidth` and `windowHeight` drive the viewport inputs.

Nodes and bubbles keep their IDs and spring to new slots in approximately 360ms. Reduced motion applies destinations directly and disables flow. Landscape geometry, earmuffs, tentacles and task bubbles retain their existing solver and renderer.

## Portrait geometry

Rail positions follow the [approved portrait and mobile sources](design.md#presentation-forms). Portrait omits visible node names, auto-compaction chips and capsule labels at every width. Node and capsule buttons retain accessible names. The rails reserve the icon radius, ring clearance and a symmetric window margin of 24px, or 16px at widths up to 520 CSS pixels. Account columns and task buses use the space inside the rails. The ARC mark keeps its landscape orientation. Its outer earmuffs straighten into horizontal lines extending outward from the left and right sides of the mark at its center height. The source line joins the upper source rail and the Agent line joins the lower Agent rail. The rails use rounded corners. Entry-point glyphs remain upright.

Wide portrait viewports fit the base hub radius to 8% of the viewport height, with a 56px minimum before applying the ring-size preference and 60% portrait scaling. Narrow portrait viewports use the mobile source's hub size and tighter row spacing, still honoring the ring-size preference. The base gaps above and below the hub shrink with its radius. Fitting scenes use spare height to widen the gaps along each rail and between the rails and the hub. Node logos have opaque canvas backgrounds so rails cannot show through them.

Source platforms follow persisted order down the left rail. Tree accounts fork inward to the right through rounded routes, with the same icon and row sizing as Agent accounts. Shared stems are painted once without a separate overlapping vertical bus. Each platform reserves its descendants' height.

Agent platforms descend the right rail. Tree accounts expand left through the same rounded fork routes into one account column. Each account has its own task bus farther left; horizontal final stubs terminate at bubble right edges. Inner routing uses rounded 10px corners. Single-account platforms skip the account level. Flat mode retains existing account semantics. Multi-account platform quota rings remain absent; account nodes carry their own rings. Claude Code nodes with both a session and weekly reading show two ring segments.

Active rows fit task stacks with existing density and 10px default gaps. Idle platforms use existing idle scale/opacity at the rail bottom, retaining persisted order within active and idle groups without rewriting preferences. Queue selection, five slots, aggregate slots, pending-first ordering and temporary expansion remain upstream responsibilities. Bubble width fills available space from a 16px left margin to the task buses, capped at 480px and normally floored at the narrow preference. At viewports too narrow for that floor plus hierarchy, available width wins to prevent horizontal scrolling. The scene scrolls vertically and reserves bottom dock clearance.

Task branches form complete rounded routes from the node through the bus column. Shared stems are painted once without a straight bus cutting across their bends. Each neutral branch ends horizontally at the exact start of its status stub. Only final task stubs carry status: accent/flow for running, green for completed, amber for input and border-strong for aggregates. External stubs are dashed. Buses remain neutral Agent color. All colors use theme tokens.

## Panels

Agent/account panels dock inside the right rail over the bubbles, from a 16px left margin to 40px before the selected node's stubs. Their vertical range fills the available viewport height, from the top panel margin to the dock clearance. The hub position and topology scroll offset do not constrain the panel height. A selected-node stub reaches the panel's right edge; bubbles and their stubs fade using existing panel state.

Source panels open to the right of the visible source and account nodes, inside the viewport and above the dock. They overlay the scene without reserving a vertical gap or moving the hub and Agent section. The shared panel scroll area contains long content. The selected source connects directly from the icon's right edge to the panel's left edge. Opening the panel keeps the selected node visible.

Portrait panels use the available rail area and omit the landscape width-expansion control. An explicit `app_env.taskPanelWidth` may narrow the Agent panel within that area.

Both modes reuse the existing nonmodal shell, open/close timing, outside-click, Escape and focus restoration. Header controls and the bottom-left dock retain their positions.

## Height-aware sibling groups

Landscape allocates height independently to each wing. Portrait uses one height budget for the visible scene. Reduce extra rail spacing before folding siblings. Fold idle descendant siblings before other roots. When a parent folds idle siblings, fold all eligible idle siblings together except the side's highest-ranked root. Fold other eligible siblings incrementally, lowest rank first. Portrait considers upper source roots before lower Agent roots. Each nonempty side retains its highest-ranked root. Selection, attention, pending input, running or selected tasks, and pinned descendants protect a branch. Ranking uses activity level, activity time and stable ID. Agent activity clocks survive bubble dismissal for the mounted homepage.

Each parent has at most one folded group, with at least two members. Kept siblings preserve relative order, followed by their capsule in the same column. The capsule identity derives from parent ID and side. Replace folded subtrees before solving geometry. A child capsule has one branch from its parent's outer arc; a root capsule has one branch from the earmuff. Portrait places root capsules on the rail. Folded members contribute no wires, ports or task branches.

The shared `ui/components/ui/TopologyGroup.tsx` implements the approved capsule. Same-brand pools show one mark, up to 12 per-member quota dots and the total count. Mixed groups show up to three distinct marks and a count. Dots derive the primary reading state: healthy readings use success, consumption of at least 50% or timing warnings use warning, and exhausted readings use danger. Unavailable readings use border-strong. Landscape labels sit below. Portrait capsules extend into the canvas, with the brand marks nearest their rail and the count toward the center.

Click or tap the capsule to unfold the real member nodes in place through the existing springs. Hover and keyboard focus leave the group folded. Enter or Space unfolds it and moves focus to the first member once interactive. Pointer input outside the capsule, its unfolded members, their branches and member-owned layers folds it. Portaled member menus and panels remain inside. Activating another capsule folds the previous group. Escape closes a member panel or popover before folding the group and restoring capsule focus. An explicitly opened group retains its membership through activity refresh until dismissal. Reduced motion applies positions directly.

Wide portrait viewports center the visible composition vertically. When both sides are visible and height compaction applies, use the midpoint of the visible task bubble group as the vertical anchor. A folded side releases its space and rail. Center the remaining nodes and ARC mark together vertically, preserving horizontal positions. Narrow portrait uses the mobile source's top inset and scrolls longer compositions below it. Folding a side resets the portrait scroll offset. Content above the scene margin remains reachable through vertical scrolling. The topology snapshot exposes `groups` with stable ID, parent, side, member IDs and `folded`; unfolded nodes expose `groupMember`. Task data and account identity remain upstream. Folded task bubbles are inert, and their pets remain hidden until the bubbles return.
