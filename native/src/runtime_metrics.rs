//! Content-free, bounded diagnostics. Wall time identifies work, not CPU attribution.
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
pub(crate) fn snapshot() -> Value {
    initialize();
    json!({"schemaVersion":1,"pid":std::process::id(),"observedAt":now(),"buildId":crate::runtime::process_build_id().ok(),
        "elapsedMs":STARTED.get().unwrap().elapsed().as_millis(),"process":process(),
        "work":NAMES.iter().zip(&COUNTERS).map(|(name,c)| json!({"name":name,
            "calls":c.calls.load(Relaxed),"inFlight":c.in_flight.load(Relaxed),
            "totalWallMs":c.total_us.load(Relaxed) as f64/1000.0,"maxWallMs":c.max_us.load(Relaxed) as f64/1000.0})).collect::<Vec<_>>(),
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
