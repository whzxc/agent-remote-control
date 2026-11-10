//! Content-free, bounded diagnostics. Wall time identifies work, not CPU attribution.
pub(crate) mod cost;
use crate::*;
use std::sync::{
    atomic::{AtomicU64, Ordering::Relaxed},
    OnceLock,
};
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum Work {
    Status,
    Accounts,
    Activity,
    NotificationObserve,
    NotificationDelivery,
    DesktopFrame,
}
const NAMES: [&str; 6] = [
    "status",
    "accounts",
    "activity",
    "notificationObserve",
    "notificationDelivery",
    "desktopFrame",
];
struct Counter {
    calls: AtomicU64,
    in_flight: AtomicU64,
    total_us: AtomicU64,
    max_us: AtomicU64,
}
impl Counter {
    const fn new() -> Self {
        Self {
            calls: AtomicU64::new(0),
            in_flight: AtomicU64::new(0),
            total_us: AtomicU64::new(0),
            max_us: AtomicU64::new(0),
        }
    }
}
static COUNTERS: [Counter; 6] = [const { Counter::new() }; 6];
static STARTED: OnceLock<Instant> = OnceLock::new();
pub(crate) fn initialize() {
    STARTED.get_or_init(Instant::now);
}
pub(crate) struct Scope {
    work: Work,
    started: Instant,
}
impl Scope {
    pub(crate) fn new(work: Work) -> Self {
        initialize();
        let c = &COUNTERS[work as usize];
        c.calls.fetch_add(1, Relaxed);
        c.in_flight.fetch_add(1, Relaxed);
        Self {
            work,
            started: Instant::now(),
        }
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        let c = &COUNTERS[self.work as usize];
        let micros = self.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        c.total_us.fetch_add(micros, Relaxed);
        c.max_us.fetch_max(micros, Relaxed);
        c.in_flight.fetch_sub(1, Relaxed);
    }
}
#[derive(Default, Clone)]
pub(crate) struct ObservationSample {
    pub completed_passes: u64,
    pub bindings_scanned: u64,
    pub bindings_reused: u64,
    pub history_reads: u64,
    pub ownership_discoveries: u64,
    pub pending_reconciliations: u64,
    pub reconciliation_exhausted: u64,
    pub retired_bindings: u64,
    pub unattributed_bindings: u64,
    wall_us: [u64; 5],
}
impl ObservationSample {
    fn value(&self) -> Value {
        json!({"completedPasses":self.completed_passes,"bindingsScanned":self.bindings_scanned,"bindingsReused":self.bindings_reused,
            "historyReads":self.history_reads,"ownershipDiscoveries":self.ownership_discoveries,
            "pendingReconciliations":self.pending_reconciliations,"reconciliationExhausted":self.reconciliation_exhausted,
            "retiredBindings":self.retired_bindings,"unattributedBindings":self.unattributed_bindings,
            "phaseWallMs":{"scan":self.wall_us[0] as f64/1000.0,"history":self.wall_us[1] as f64/1000.0,
                "process":self.wall_us[2] as f64/1000.0,"ownership":self.wall_us[3] as f64/1000.0,
                "ownerDiscovery":self.wall_us[4] as f64/1000.0}})
    }
    fn accumulate(&mut self, s: &Self) {
        self.completed_passes += s.completed_passes;
        self.bindings_scanned += s.bindings_scanned;
        self.bindings_reused += s.bindings_reused;
        self.history_reads += s.history_reads;
        self.ownership_discoveries += s.ownership_discoveries;
        self.pending_reconciliations += s.pending_reconciliations;
        self.reconciliation_exhausted += s.reconciliation_exhausted;
        self.retired_bindings += s.retired_bindings;
        self.unattributed_bindings += s.unattributed_bindings;
        for (total, value) in self.wall_us.iter_mut().zip(s.wall_us) {
            *total += value;
        }
    }
}
type ObservationCounters = Arc<std::sync::Mutex<ObservationSample>>;
tokio::task_local! { pub(crate) static OBSERVATION: ObservationCounters; }
#[derive(Default)]
struct ObservationState {
    current: Option<ObservationCounters>,
    last: ObservationSample,
    totals: ObservationSample,
}
static OBSERVER: std::sync::LazyLock<std::sync::Mutex<ObservationState>> =
    std::sync::LazyLock::new(Default::default);
pub(crate) struct ObservationPass {
    pub sample: ObservationCounters,
}
impl ObservationPass {
    pub fn new() -> Self {
        let sample = ObservationCounters::default();
        OBSERVER.lock().unwrap().current = Some(sample.clone());
        Self { sample }
    }
}
impl Drop for ObservationPass {
    fn drop(&mut self) {
        let mut state = OBSERVER.lock().unwrap();
        let sample = self.sample.lock().unwrap().clone();
        state.totals.accumulate(&sample);
        state.last = sample;
        state.current = None;
    }
}
#[derive(Clone, Copy)]
pub(crate) enum ObservationPhase {
    Scan,
    History,
    Process,
    Ownership,
    OwnerDiscovery,
}
pub(crate) struct ObservationTimer {
    sample: Option<ObservationCounters>,
    phase: ObservationPhase,
    started: Instant,
}
impl ObservationTimer {
    pub fn new(phase: ObservationPhase) -> Self {
        Self {
            sample: OBSERVATION.try_with(Clone::clone).ok(),
            phase,
            started: Instant::now(),
        }
    }
}
impl Drop for ObservationTimer {
    fn drop(&mut self) {
        if let Some(sample) = &self.sample {
            sample.lock().unwrap().wall_us[self.phase as usize] +=
                self.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        }
    }
}
pub(crate) fn observation_owner_discovery() -> ObservationTimer {
    let _ = OBSERVATION.try_with(|sample| sample.lock().unwrap().ownership_discoveries += 1);
    ObservationTimer::new(ObservationPhase::OwnerDiscovery)
}
fn observation_metrics() -> Value {
    let state = OBSERVER.lock().unwrap();
    json!({"currentPass":state.current.as_ref().map(|s|s.lock().unwrap().value()),"lastPass":state.last.value(),"totals":state.totals.value()})
}
pub(crate) fn snapshot() -> Value {
    initialize();
    json!({"schemaVersion":1,"pid":std::process::id(),"observedAt":now(),"buildId":crate::runtime::process_build_id().ok(),
        "elapsedMs":STARTED.get().unwrap().elapsed().as_millis(),"process":process(),
        "work":NAMES.iter().zip(&COUNTERS).map(|(name,c)| json!({"name":name,
            "calls":c.calls.load(Relaxed),"inFlight":c.in_flight.load(Relaxed),
            "totalWallMs":c.total_us.load(Relaxed) as f64/1000.0,"maxWallMs":c.max_us.load(Relaxed) as f64/1000.0})).collect::<Vec<_>>(),
        "notificationObserve":observation_metrics(),"cost":cost::snapshot(),
        "caches":{"json":crate::kernel::file_cache::diagnostics(),"notificationBindings":crate::claude_notify::diagnostics()}})
}
#[cfg(target_os = "macos")]
fn process() -> Value {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: the kernel writes the v2 record for this process into sized storage.
    let result = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as i32,
            libc::RUSAGE_INFO_V2,
            (&mut info as *mut libc::rusage_info_v2).cast(),
        )
    };
    if result != 0 {
        return unavailable();
    }
    // proc_pid_rusage CPU counters use Mach ticks, not nanoseconds. getrusage
    // exposes CPU seconds/microseconds independently of the machine timebase.
    let mut cpu: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: getrusage writes one correctly sized record owned by this call.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut cpu) } != 0 {
        return unavailable();
    }
    let ms = |v: libc::timeval| v.tv_sec as f64 * 1000.0 + v.tv_usec as f64 / 1000.0;
    json!({"state":"available","cpuTotalMs":ms(cpu.ru_utime)+ms(cpu.ru_stime),
        "residentBytes":info.ri_resident_size,"physicalFootprintBytes":info.ri_phys_footprint,
        "diskReadBytes":info.ri_diskio_bytesread,"diskWriteBytes":info.ri_diskio_byteswritten})
}
#[cfg(target_os = "linux")]
fn process() -> Value {
    let mut info: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: getrusage writes one initialized record owned by this call.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut info) } != 0 {
        return unavailable();
    }
    let ms = |v: libc::timeval| v.tv_sec as f64 * 1000.0 + v.tv_usec as f64 / 1000.0;
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let resident = std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|v| v.split_whitespace().nth(1)?.parse::<u64>().ok())
        .and_then(|pages| (page > 0).then(|| pages.saturating_mul(page as u64)));
    json!({"state":if resident.is_some(){"available"}else{"partial"},"cpuTotalMs":ms(info.ru_utime)+ms(info.ru_stime),
        "residentBytes":resident,"physicalFootprintBytes":null})
}
#[cfg(windows)]
fn process() -> Value {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{GetCurrentProcess, GetProcessTimes},
        },
    };
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    let mut memory: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&memory) as u32;
    memory.cb = size;
    // SAFETY: the pseudo handle is this process; all output pointers have correct sizes.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        ) != 0
            && GetProcessMemoryInfo(GetCurrentProcess(), &mut memory, size) != 0
    };
    if !ok {
        return unavailable();
    }
    let ticks = |v: FILETIME| ((v.dwHighDateTime as u64) << 32) | v.dwLowDateTime as u64;
    json!({"state":"available","cpuTotalMs":(ticks(kernel) as f64+ticks(user) as f64)/10000.0,
        "residentBytes":memory.WorkingSetSize,"physicalFootprintBytes":null})
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn process() -> Value {
    unavailable()
}
fn unavailable() -> Value {
    json!({"state":"unavailable","cpuTotalMs":null,"residentBytes":null,"physicalFootprintBytes":null,"error":std::io::Error::last_os_error().to_string()})
}
