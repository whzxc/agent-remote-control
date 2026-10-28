# Portrait homepage layout

The homepage has two geometry solvers sharing entities, account attribution, persisted order, collapse overrides, task queues and stable-ID animation. `solve.ts` owns landscape geometry. `portrait.ts` owns portrait geometry; it never generates tentacles.

## Orientation

Display settings persist Layout: Auto / Landscape / Portrait, default Auto. Auto enters portrait at viewport width/height <= 0.85 and landscape at >= 1.0, retaining its current mode between thresholds (initially landscape). Evaluate 150ms after resizing stops; defer changes until pointer drags finish. Manual selection uses the same drag guard. `app.snapshot.model.topology` reports `orientation`, `source` (auto/manual), and pending orientation evaluation. `app_env.windowWidth` and `windowHeight` drive the viewport inputs.

Nodes and bubbles keep their IDs and spring to new slots in approximately 360ms. Reduced motion applies destinations directly and disables flow. Landscape geometry, earmuffs, tentacles and task bubbles retain their existing solver and renderer.

## Portrait geometry

Rail positions follow measured labels, including node scale and optional auto-compaction chips. The source rail sits to the right of the widest outer source label with a 16px left margin. The Agent rail sits to the left of the widest outer Agent label with a 16px right margin; its account column, task buses and bubble column move together. The ARC mark keeps its landscape orientation. Its outer earmuffs straighten into horizontal lines extending outward from the left and right sides of the mark at its center height. The source line joins the upper source rail and the Agent line joins the lower Agent rail. The rails use rounded corners. The mark, straight ears, their offsets and stroke weights use 60% of the previous portrait radius after applying the ring-size preference. Entry-point glyphs remain upright.

The base hub radius fits 8% of the viewport height, with a 56px minimum before applying the ring-size preference and portrait scaling. The gaps above and below the hub shrink with its radius. Node logos have opaque canvas backgrounds so rails cannot show through them.

Source platforms follow persisted order down the left rail. Their labels sit outside, right-aligned. Tree accounts fork inward to the right through rounded routes, with 42px nodes, at least 24px of vertical clearance between account icons, and centered labels below icons, matching Agent account nodes. Account rows reserve the complete label height. Shared stems are painted once without a separate overlapping vertical bus. Each platform reserves its descendants' height.

Agent platforms descend the right rail. Their names and optional auto-compaction chips sit outside. Tree accounts expand left through the same rounded fork routes into one account column, with labels below nodes. Each account has its own task bus farther left; horizontal final stubs terminate at bubble right edges. Inner routing uses rounded 10px corners. Single-account platforms skip the account level. Flat mode retains existing account semantics. Multi-account platform quota rings remain absent; account nodes carry their own rings.

Active rows fit task stacks with existing density and 10px default gaps. Idle platforms use existing idle scale/opacity at the rail bottom, retaining persisted order within active and idle groups without rewriting preferences. Queue selection, five slots, aggregate slots, pending-first ordering and temporary expansion remain upstream responsibilities. Bubble width fills available space from a 16px left margin to the task buses, capped at 480px and normally floored at the narrow preference. At viewports too narrow for that floor plus hierarchy, available width wins to prevent horizontal scrolling. The scene scrolls vertically and reserves bottom dock clearance.

Labels remain complete within the viewport. Keep outer Agent labels on one line while the minimum bubble width and hierarchy fit; otherwise permit two lines using measured wrapping widths before shrinking bubbles below their narrow preference. Source labels wrap only when their full source/account row cannot fit. Account labels use their available inward space, and rows reserve their label height. Never ellipsize portrait labels or chips.

Task branches form complete rounded routes from the node through the bus column. Shared stems are painted once without a straight bus cutting across their bends. Each neutral branch ends horizontally at the exact start of its status stub. Only final task stubs carry status: accent/flow for running, green for completed, amber for input and border-strong for aggregates. External stubs are dashed. Buses remain neutral Agent color. All colors use theme tokens.

## Panels

Agent/account panels dock inside the right rail over the bubbles, from a 16px left margin to 40px before the selected node's stubs. Their vertical range starts below the lower earmuff and ends above the dock. A selected-node stub reaches the panel's right edge; bubbles and their stubs fade using existing panel state.

Source panels open to the right of the visible source nodes and account labels, inside the viewport and above the dock. They overlay the scene without reserving a vertical gap or moving the hub and Agent section. The shared panel scroll area contains long content. The selected source connects directly from the icon's right edge to the panel's left edge, clear of the labels below account nodes. Opening the panel keeps the selected node visible.

Portrait panels use the available rail area and omit the landscape width-expansion control. An explicit `app_env.taskPanelWidth` may narrow the Agent panel within that area.

Both modes reuse the existing nonmodal shell, open/close timing, outside-click, Escape and focus restoration. Header controls and the bottom-left dock retain their positions.

## Height-aware node stacks

Both orientations allocate height independently to each wing. Portrait gives the source and Agent wings equal budgets after reserving the hub and outer margins. Each nonempty side always retains its highest-ranked root. Selected roots and roots containing pending decisions remain visible. Ranking uses pending input, running work, connection activity and the most recent observed activity timestamp, with stable IDs breaking ties. Agent activity clocks survive bubble dismissal for the mounted homepage.

The complete tree is solved before compaction. Low-activity root groups retain their real nodes, parent edges and inward depth columns. Nodes at each depth overlap along a single vertical axis, with no diagonal icon fan. The remaining roots preserve their relative order. Hover unfolds these same nodes directly in the topology; no separate panel is created. A continuous hit region and short leave delay cover the space traversed by the unfolding nodes. Focus and touch also unfold the stack. Escape folds it again. Selecting a member protects its branch while its panel is open.

Both portrait wings have equal reserved height, centered around the unrotated hub. Protected content or an unfolded stack can enlarge the scene; scrolling remains available instead of clipping content. Stack membership and folded state are exposed as `stackMember` and `stacked` on the real topology snapshot nodes. Task data and account identity remain in the upstream model. Task bubbles folded out of view are inert, and their pets are hidden until the bubbles return.
