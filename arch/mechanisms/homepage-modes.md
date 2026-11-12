---
owners:
  - ui/App.tsx
  - ui/topology/**
  - ui/components/ConnectionOverview.tsx
  - ui/components/ActivityBubbles.tsx
status: Proposed
---
The homepage has a manually selected, persisted Topology or Execution mode. The shared
SingleChoice sits below the centered Board header in both modes and all widths. Task
observations never change the selected mode. The selector's Execution option carries
the needs-me count while Topology is selected. This is ordinary navigation, without an
Experimental toggle or a new bottom-navigation workspace.

Topology positions depend only on configuration, viewport and explicit structural
disclosure. Task observations update badges without entering layout inputs. No task
children, queues, secondary task tentacles/outer arcs or task focus overlays remain.
A node badge is a separate task-state action from its management action. Activating it
is an explicit user navigation: persist Execution mode, scope the list to the node,
scroll to its first matching task and transfer keyboard focus. The highlighted node
chip clears that transient scope. Manual Execution selection opens all tasks. Mode
choice persists across restarts; jump scope does not. Returning to Topology restores
its configuration-based arrangement.

Execution cards keep their source, optional remote device, Agent and account as a
compact icon chain. Each icon exposes its identity by accessible name and tooltip.
Controller-dispatched remote tasks show the controller device followed by its member.
On that member, the controller device is the source and there is no extra local-device
step. The controller projection contains only tasks it dispatched to that member.

Groups are Needs me, Running, Completed unread, then Unconfirmed. Recent completed
starts collapsed. Offline members' task observations are unconfirmed, with last-seen
metadata and no live verbs or counts. They do not contribute live attention counts.
Task detail and the existing separate check action for marking read remain distinct.
Within Needs me and Running, Move up/down and the existing ArrowUp/Down card shortcuts
change presentation order only; they cannot cross a group or reschedule execution.
Unread and Unconfirmed retain observation order. Lists scroll vertically without
queue compaction. Long text truncates with the full accessible title retained.
Portrait and mobile use one column and preserve the header and mode control.

All nodes use the neutral architecture vocabulary. The sidecar's Proposed status
covers the presentation and navigation model; it does not add an experimental flag.
