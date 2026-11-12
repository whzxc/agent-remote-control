# Portrait homepage layout

The approved `device-link-topology` and `homepage-tasks` surfaces own narrow presentation.
`ui/topology/orientation.ts` chooses the orientation and `portrait.ts` owns portrait geometry.

## Topology

Automatic orientation retains the solver's aspect-ratio hysteresis and defers changes while dragging. The portrait solver keeps source and Agent rails, inward child columns and earcup connections. Node geometry follows configuration and explicit disclosure. Capsule width contributes to horizontal extents. The header, mode switch and bottom navigation reserve space outside the scrollable topology viewport. Portrait labels follow the existing compact painter's presentation.

## Account groups

Viewport pressure folds eligible node siblings through the topology group planner.
Explicit activation unfolds members.
Keyboard activation focuses the first member.
Escape dismisses a member layer before folding its group and restoring trigger focus.
Outside canvas input folds the group.
Task observations retain explicit disclosure and do not determine fold priority.

## Tasks

Tasks mode uses one column below 1000px.
Cards begin with compact activity and expand it in place.
The expanded tail shows at most four recorded steps.
The node filter is transient and clearable.
A capsule task action scrolls and focuses its matching tasks.

## Panels

The shared layer registry and layerFrame own panel and dialog geometry.
Narrow or portrait viewports collapse left and right M slots to the available width.
Headers and footers stay fixed while the capped body scrolls.
