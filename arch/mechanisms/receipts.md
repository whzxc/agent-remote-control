---
owners:
  - native/src/kernel/receipts.rs
  - native/src/kernel/receipts/**
status: Reviewed
---
Fill shows the phase: reserved and executing are in progress, awaiting-approval waits for local approval, completed is done, failed, rejected and not-executed are stopped, and unconfirmed is uncertain. The wire format also defines cancelled and rolled-back; kernel::receipts::progress::advance produces neither, so the diagram omits them.
