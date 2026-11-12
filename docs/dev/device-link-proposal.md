# Device presentation limits

[Architecture](architecture.md#device-identity-and-peer-listeners) owns identity, pairing, LAN transport, tunnel fallback, forwarding, receipts, notifications and file transfer.
[Remote link](remote-link.md#device-link) owns the Desktop entry.

The homepage renders paired members on the executor wing and the controller on the member source wing.
Each device opens its side-slot management panel.
The right add endpoint opens pairing and local offers.
Native `controller.showUpstreamSources` configuration owns default-off disclosure of `controller.upstreamSources`.

`device/tasks` provides controller-scoped active sessions, available Agent inventory, up to 200 records and an omitted-record count.
The homepage joins these observations into remote task cards and remote Agent branches.
A single available Agent merges into its device node.
The native controller owns remote visibility.
Incoming controller-dispatched work stays local on the member and uses the controller device as its source.
Offline or failed observations retain last-seen metadata and use unconfirmed presentation.

The current management API has no remote account/quota inventory or remote timeline/response forwarding.
Remote cards expose the recorded activity in a side panel with partial-history status.
Local task cards retain the existing timeline and response interactions.
Device file transfer retains its native and CLI owners.
