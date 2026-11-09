//! One shutdown barrier shared by all task execution entry points.
use crate::Result;

#[derive(Default)]
pub(crate) struct Launches {
    closed: std::sync::atomic::AtomicBool,
    publication: std::sync::Mutex<()>,
}

impl Launches {
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        // Wait for a launch already admitted to finish publishing its index.
        drop(self.publication.lock().unwrap());
    }

    pub fn check(&self) -> Result<()> {
        self.run(|| Ok(()))
    }

    /// Serialize the actual spawn/adoption with the start of shutdown.
    pub fn run<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let _publication = self.publication.lock().unwrap();
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("CORE_SHUTTING_DOWN: retry after Core restarts".into());
        }
        action()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_rejects_queued_launches_and_adoptions() {
        // Regression: an idle Core spawned an unrecorded Codex server after releasing its profile.
        let launches = Launches::default();
        assert_eq!(launches.run(|| Ok(7)).unwrap(), 7);
        launches.close();
        assert!(launches
            .run(|| Ok(8))
            .unwrap_err()
            .starts_with("CORE_SHUTTING_DOWN:"));
        assert!(launches.check().is_err());
    }
}
