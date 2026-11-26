---
status: Approved
owners:
  - internal/core/device_link_transfer*.go
  - internal/core/device_link_controller_transfer.go
---
Implements the accepted phase 3 file-transfer flow in the Device link proposal. One receipt covers admission, progress, explicit resume, cancellation and atomic publication. Only the controller and member carry file bytes. The receiver owns verified offsets.
