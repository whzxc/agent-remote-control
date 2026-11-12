# Portrait homepage layout

The approved `device-link-topology` and `homepage-tasks` surfaces own narrow presentation.
`ui/topology/layout.ts` owns configuration columns.

## Topology

Windows below 1000px use compact 152px columns and 48px logo anchors.
Capsules reserve at most two 22px discs on 28px steps.
Visible node labels retain their logo anchors.
Horizontal and vertical scrolling reveal configuration tiers without following task activity.
The ARC mark, Board header, mode switch and navigation remain available.

## Account groups

Multiple account siblings fold into TopologyGroup in compact columns.
Explicit activation unfolds members.
Keyboard activation focuses the first member.
Escape dismisses a member layer before folding its group and restoring trigger focus.
Outside canvas input folds the group.
Task updates retain explicit disclosure and configuration positions.

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
