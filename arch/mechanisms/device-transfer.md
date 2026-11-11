---
status: Approved
owners:
  - native/src/device_link/transfer.rs
  - native/src/device_link/transfer/**
  - native/src/device_link/controller/transfer.rs
---
Implements the accepted phase 3 file-transfer flow in the Device link proposal. One receipt covers admission, progress, explicit resume, cancellation and atomic publication. Only the controller and member carry file bytes. The receiver owns verified offsets.
