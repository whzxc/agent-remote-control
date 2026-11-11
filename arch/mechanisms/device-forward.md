---
status: Approved
---
Accepted in docs/dev/device-link-proposal.md; implementation is phased. The controller assigns the receipt ID before transmission and never resends a sent write. The member sees one peer source; the controller enforces per-source task association and maps member task events to the originating source.
