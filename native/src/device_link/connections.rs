//! Paired LAN admission and idle eviction share one lock with request activity.
use super::*;
use tokio::sync::oneshot;

#[derive(Default)]
pub(super) struct Connections {
    next: u64,
    entries: BTreeMap<u64, Entry>,
}
struct Entry {
    controller: String,
    active: usize,
    idle_since: Instant,
    cancel: oneshot::Sender<()>,
}
pub(super) struct Connection {
    pool: Arc<StdMutex<Connections>>,
    id: u64,
}
pub(super) struct Activity(Arc<Connection>);
pub(super) struct Registration(pub Arc<Connection>);

impl Connections {
    pub fn admit(
        pool: &Arc<StdMutex<Self>>,
        controller: &str,
    ) -> Option<(Arc<Connection>, oneshot::Receiver<()>)> {
        let mut connections = pool.lock().unwrap();
        if connections.entries.len() >= 8 {
            let oldest = connections
                .entries
                .iter()
                .filter(|(_, entry)| entry.controller == controller && entry.active == 0)
                .min_by_key(|(id, entry)| (entry.idle_since, **id))
                .map(|(id, _)| *id)?;
            let old = connections.entries.remove(&oldest).unwrap();
            let _ = old.cancel.send(());
        }
        let id = connections.next;
        connections.next = connections.next.wrapping_add(1);
        let (cancel, cancelled) = oneshot::channel();
        connections.entries.insert(
            id,
            Entry {
                controller: controller.into(),
                active: 0,
                idle_since: Instant::now(),
                cancel,
            },
        );
        Some((
            Arc::new(Connection {
                pool: pool.clone(),
                id,
            }),
            cancelled,
        ))
    }
}
impl Connection {
    pub fn request(self: &Arc<Self>) -> Result<Activity> {
        let mut pool = self.pool.lock().unwrap();
        let entry = pool.entries.get_mut(&self.id).ok_or_else(|| {
            error(
                "DEVICE_BUSY",
                "Peer connection was replaced; reconnect and query devices.",
            )
        })?;
        entry.active += 1;
        Ok(Activity(self.clone()))
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.pool.lock().unwrap().entries.remove(&self.id);
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        // Release admission when serve ends, even if a cancelled stream still
        // owns derived activity while its handler unwinds.
        self.0.pool.lock().unwrap().entries.remove(&self.0.id);
    }
}
impl Drop for Activity {
    fn drop(&mut self) {
        if let Some(entry) = self.0.pool.lock().unwrap().entries.get_mut(&self.0.id) {
            entry.active -= 1;
            if entry.active == 0 {
                entry.idle_since = Instant::now();
            }
        }
    }
}
