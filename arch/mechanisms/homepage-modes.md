---
owners:
  - ui/App.tsx
  - ui/topology/**
  - ui/components/ConnectionOverview.tsx
  - ui/components/ActivityBubbles.tsx
status: Proposed
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

Groups are Needs me, Running, Completed unread, then Unconfirmed. Recent completed
starts collapsed. Offline members' task observations are unconfirmed, with last-seen
metadata and no live verbs or counts. They do not contribute live attention counts.
Task detail and the existing separate check action for marking read remain distinct.
Within Needs me and Running, Move up/down and the existing ArrowUp/Down card shortcuts
change presentation order only; they cannot cross a group or reschedule task execution.
Unread and Unconfirmed retain observation order. Lists scroll vertically without
queue compaction. Long text truncates with the full accessible title retained.
Portrait and mobile use one column and preserve the header and mode control.

All nodes use the neutral architecture vocabulary. The sidecar's Proposed status
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

Tasks uses full-width responsive columns: up to three on wide landscape, two on
standard landscape, one on portrait/mobile. Cards expose the current activity, a
bounded native timeline tail (five/three rows), known plan-item counts, elapsed time,
recorded artifact/command/diff summaries and remote path facts. Compact cards expand
in place to four timeline rows. Answer/approval entries, detail and mark-read stay
separate. Partial coverage is visible. No new canonical field, ETA or inferred provider
progress is assumed; the joined card summary remains a new derived UI projection.
The field-to-source mapping is in docs/dev/design.md.
