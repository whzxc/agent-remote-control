---
owners:
  - native/src/device_link/**
  - ui/topology/**
  - ui/devices/**
status: Proposed
---
The homepage keeps control sources on the left and executors on the right. Pairing adds
one device tier to the existing hierarchy. Local Agents stay at tier 1 without a local
device wrapper. A paired member is their tier-1 sibling, followed by its available
Agents, accounts or profiles, and task bubbles. Exactly one Agent merges into the device
node; expansion continues with accounts or profiles and tasks. Remote account/profile
siblings fold with TopologyGroup under height or width pressure. Device reachability,
LAN/Tunnel path, latency, last seen and errors appear only on the device node. Offline
fades its entire branch.

On a member, its controller is a tier-1 control source and owns dispatch attribution.
The optional upstream-source tier is off by default. A controller sees only tasks it
dispatched to that member, excluding tasks from the member's own control sources.

Nesting is an acyclic device graph. Pairing rejects self-links and any edge that would
close an ancestor/descendant cycle before local approval. A member may control its own
members, but each homepage renders one device hop and protocol forwarding is false.
There is no descendant expansion or transitive dispatch.

The device node opens the existing topology panel pattern for pairing state,
address/override, LAN/Tunnel path and latency, last seen/error, unpair and transfer.
The right-wing add endpoint offers Add Agent and Add device. The separate Devices
workspace, summary chip and navigation entry are scheduled for removal when the
proposal is approved and implemented. Their approved design assets remain retained.

Waiting marks offered and awaiting approval. Done marks either online path. Stopped
marks rejection, expiry, offline and revocation. Experimental marks the proposed
homepage projection. LAN remains preferred; a sent request never changes path.
