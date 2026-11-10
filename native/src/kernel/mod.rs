//! Shared execution infrastructure, independent of transports and providers.
pub mod event_store;
pub mod file_cache;
pub(crate) mod file_changes;
pub mod origin;
pub mod policy;
pub mod receipts;
pub mod results;
pub(crate) mod task_projection;
