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
observations never change the selected mode. The selector offers Topology and Tasks.

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

Tasks combines live activity, recent native Codex conversations and ARC dispatch records.
Tasks are grouped by the local calendar date of their latest recorded activity. Each
date section uses responsive columns. Active tasks, including waiting tasks, today's
tasks and unread completions show previews. Older history shows compact summaries.
Unconfirmed history retains its status. Opening an unread completion marks it read.
Snapshot opening and closing morph between the card and the centered layer slot.
Reduced motion is instant.
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

The capsule holds 20px discs on a 28px step: the needs-me icon, one phase disc per
running task, and an ellipsis overflow disc. Full capsules hold five items; compact hold two.
Completed unread is a dot on the outline. Offline uses unconfirmed without live counts
or phases. The help disc indicates unconfirmed task status. Available quota stays visible
for Agent accounts and their linked control source nodes. The logo opens its existing node panel;
the task area opens scoped Tasks. Narrow topology pans horizontally between reserved
columns by explicit user input; the header/navigation stay fixed. Device management
explicitly folds the child branch while its panel is open.

Portrait snapshots keep status and duration inside the same card as the origin,
one-line title, shared project label and newest-anchored native preview.
Tool groups summarize the recorded categories and reasoning lines show
their own summary. Replies stay inline. Historical bubbles show Agent and control source
marks, title, status, recorded execution specification and duration from list metadata.
Card activation opens the full detail and loads its timeline on demand.
Routing and last-seen information stay in the preview. Request handling remains with the controller.
