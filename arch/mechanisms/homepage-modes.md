---
owners:
  - ui/App.tsx
  - ui/topology/**
  - ui/components/ConnectionOverview.tsx
  - ui/components/ActivityBubbles.tsx
status: Approved
---
The homepage has a manually selected, persisted Topology or Tasks mode. The shared
SingleChoice sits below the centered Board header in both modes and all widths. Task
observations never change the selected mode. The selector's Tasks option carries
the needs-me count while Topology is selected. This is ordinary navigation, without an
Experimental toggle or a new bottom-navigation workspace.

Topology positions depend only on configuration, viewport and explicit structural
disclosure. Task observations resize only the working node capsule shell and its
outgoing port, without entering node-position layout inputs. No task children, queues,
secondary task tentacles/outer arcs or task focus overlays remain.
The node capsule keeps separate task-area and logo actions. Activating the task area
is an explicit user navigation: persist Tasks mode, scope the list to the node,
scroll to its first matching task and transfer keyboard focus. The highlighted node
chip clears that transient scope. Manual Tasks selection opens all tasks. Mode
choice persists across restarts; jump scope does not. Returning to Topology restores
its configuration-based arrangement.

Tasks cards keep their source, optional remote device, Agent and account as a
compact icon chain. Each icon exposes its identity by accessible name and tooltip.
Controller-dispatched remote tasks show the controller device followed by its member.
On that member, the controller device is the source and there is no extra local-device
step. The controller projection contains only tasks it dispatched to that member.

Tasks retains group and observation order. A status filter selects All, Running,
Waiting, Completed or Unconfirmed. Layout persists as Tile or Stack. Offline observations
remain unconfirmed. The separate check action marks a completion read without opening it.
Tile uses six columns at 1500px, five at 1000px and two below. Stack presents a continuous
depth deck with pointer, touch, horizontal wheel and keyboard navigation. Snapshot opening
and closing morph between the card and the centered layer slot. Reduced motion is instant.
The one-row HomepageBar reserves space for both homepage modes and retains the Board entry.

All nodes use the neutral architecture vocabulary. The sidecar's Approved status
covers the presentation and navigation model; it does not add an experimental flag.

A node is a 48px logo with a circular quota ring at idle. When it has tasks the same
ring stretches into a 48px-high capsule outline, growing outward from the incoming
wire. Maximum widths of 188px full and 104px compact are reserved at idle as well.
Configuration column pitches are 260px and 152px, independent of task observations.
Outgoing wires start at the actual capsule outer edge. Capsule width, reveal and its
outgoing port share the existing 210/26 topology spring with approximately 8ms
substeps; reduced motion sets endpoints directly. No task-state transition moves a
node, label or branch rail.

The capsule holds 22px discs on a 28px step: the needs-me count, one phase disc per
running task, and an overflow disc. Full capsules hold five items; compact hold two.
Completed unread is a dot on the outline. Offline uses unconfirmed without live counts
or phases. The logo opens its existing node panel;
the task area opens scoped Tasks. Narrow topology pans horizontally between reserved
columns by explicit user input; the header/navigation stay fixed. Device management
explicitly folds the child branch while its panel is open.

Snapshots report status above each portrait card. The card contains its origin chain,
title, project path and a bounded newest-anchored timeline miniature. Routing state,
plan counts, the latest change and mark-read occupy the footer. Request handling remains
with the controller. Native observations supply the derived projection.
