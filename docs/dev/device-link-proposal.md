# Remaining Device link work

[Architecture](architecture.md#device-identity-and-peer-listeners) owns implemented identity, pairing, LAN transport, tunnel fallback, forwarding, receipts, notifications and file transfer.
[Remote link](remote-link.md#device-link) owns the implemented Desktop entry.

## Device topology

The approved controller and member node compositions remain unimplemented.
The current homepage uses `DeviceSummary` to open the Devices workspace.
Replace that summary with the approved `design/modules/device-topology.tsx` and `design/surfaces/device-link-topology.tsx` compositions through the homepage owner.
Keep pairing, transfer, liveness and authority in their existing owners.
This remaining work does not introduce multihop routing, federation or shared Agent session storage.
