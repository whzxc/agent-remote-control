---
owners:
  - native/src/device_link/**
  - ui/topology/**
  - ui/devices/**
status: Proposed
---
Remote Agent dispatch targets (device, agent). Operation arguments gain the device
target; the guide/query/act MCP tool names and parameter structures stay frozen.
Resolve one directly paired member. A member can control further members, but protocol
forwarding is false and a received request never forwards to a descendant.

The controller assigns the receipt ID before transmission and never resends a sent
write. It retains the originating source association. The member attributes dispatched
tasks to the controller device source. The controller's Tasks projection includes only
tasks this controller dispatched to that member. Tasks from the member's own control
sources remain outside that projection. Optional display of the controller's upstream
sources does not change task attribution or visibility.

Offline dispatch returns without sending. Existing bounded event reads, reconnect
status reads and notification delivery remain owned by the current mechanisms.

Task observations update static topology badges without moving nodes. Task cards and
origin chains belong to Tasks mode, reached explicitly or from a node task-state badge.
