//! Detached stdio transport. Protocol v1 and journal envelopes are frozen.
//! Journals are bounded delivery buffers, never canonical Agent history.
use crate::*;
use std::{
    collections::VecDeque,
    io::Write,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub const PROTOCOL: u64 = 1;
const FRAME_LIMIT: usize = 32 * 1024 * 1024;
const JOURNAL_LIMIT: usize = 64 * 1024 * 1024;
const ORPHAN_GRACE: Duration = Duration::from_secs(30 * 60);
trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type Socket = Box<dyn Stream>;

fn instances() -> PathBuf {
    root().join("task-host/instances")
}
fn io_error(e: impl std::fmt::Display) -> String {
    format!("TASK_HOST_IO: {e}")
}
fn live(index: &Value) -> bool {
    index["hostPid"]
        .as_u64()
        .and_then(|pid| crate::codex_host::process_start(pid as u32))
        .is_some_and(|start| index["hostStart"].as_str() == Some(&start))
}
pub(crate) fn indexes() -> Vec<Value> {
    std::fs::read_dir(instances())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| load(&entry.path().join("host.json")).ok())
        .collect()
}
fn exit_path(index: &Value) -> PathBuf {
    Path::new(string(index, "journalPath")).with_file_name("exit.json")
}

/// Sequence offsets are stable across bounded journal compaction.
struct Journal {
    path: PathBuf,
    rows: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    next: u64,
}
impl Journal {
    fn new(path: PathBuf) -> Result<Self> {
        std::fs::File::create(&path).map_err(io_error)?;
        Ok(Self {
            path,
            rows: VecDeque::new(),
            bytes: 0,
            next: 1,
        })
    }
    fn append(&mut self, kind: &str, frame: Value) -> Result<()> {
        let row = json!({"offset":self.next,"kind":kind,"frame":frame});
        let mut bytes = serde_json::to_vec(&row).map_err(io_error)?;
        bytes.push(b'\n');
        if bytes.len() > JOURNAL_LIMIT {
            return Err(
                "TASK_HOST_FRAME_TOO_LARGE: encoded frame exceeds the delivery buffer".into(),
            );
        }
        // Compact before appending so readers see either complete generation.
        let mut compact = false;
        let target = if self.bytes + bytes.len() > JOURNAL_LIMIT {
            JOURNAL_LIMIT * 3 / 4
        } else {
            JOURNAL_LIMIT
        };
        while self.bytes + bytes.len() > target && !self.rows.is_empty() {
            self.bytes -= self.rows.pop_front().unwrap().1.len();
            compact = true;
        }
        if compact {
            let temp = self.path.with_extension("next");
            let mut file = std::fs::File::create(&temp).map_err(io_error)?;
            for (_, row) in &self.rows {
                file.write_all(row).map_err(io_error)?;
            }
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_data().map_err(io_error)?;
            drop(file);
            std::fs::rename(temp, &self.path).map_err(io_error)?;
        } else {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&self.path)
                .map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
        }
        self.bytes += bytes.len();
        self.rows.push_back((self.next, bytes));
        self.next += 1;
        Ok(())
    }
    fn first(&self) -> u64 {
        self.rows.front().map(|r| r.0).unwrap_or(self.next)
    }
}

/// Read only complete records. Cursor identity is the first journal sequence,
/// so compaction never turns a byte position into a silent skip.
#[derive(Default)]
pub(crate) struct JournalReader {
    first: u64,
    position: u64,
}
impl JournalReader {
    pub(crate) fn read(&mut self, path: &Path, after: u64) -> Result<Vec<Value>> {
        use std::io::{BufRead, Read, Seek, SeekFrom};
        let mut file = std::io::BufReader::new(std::fs::File::open(path).map_err(io_error)?);
        let mut first = String::new();
        file.read_line(&mut first).map_err(io_error)?;
        if !first.ends_with('\n') {
            return Ok(vec![]);
        }
        let row: Value = serde_json::from_str(&first).map_err(io_error)?;
        let first = row["offset"].as_u64().ok_or("TASK_HOST_JOURNAL_INVALID")?;
        if first != self.first {
            self.first = first;
            self.position = 0;
        }
        file.seek(SeekFrom::Start(self.position))
            .map_err(io_error)?;
        let mut bytes = vec![];
        file.read_to_end(&mut bytes).map_err(io_error)?;
        let complete = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| &bytes[..=i])
            .unwrap_or(&[]);
        let mut result = vec![];
        let mut expected = after + 1;
        for row in complete.split(|b| *b == b'\n').filter(|b| !b.is_empty()) {
            let row: Value = serde_json::from_slice(row).map_err(io_error)?;
            let offset = row["offset"].as_u64().ok_or("TASK_HOST_JOURNAL_INVALID")?;
            if offset <= after {
                continue;
            }
            if offset != expected {
                return Err("TASK_HOST_JOURNAL_GAP: delivery buffer expired; reconcile native Agent history before resuming".into());
            }
            expected += 1;
            result.push(row);
        }
        self.position += complete.len() as u64;
        Ok(result)
    }
}
#[cfg(test)]
fn replay(path: &Path, after: u64) -> Result<Vec<Value>> {
    JournalReader::default().read(path, after)
}

fn write_sequence(received: u64, sequence: u64) -> Result<bool> {
    if sequence <= received {
        Ok(false)
    } else if sequence == received + 1 {
        Ok(true)
    } else {
        Err("TASK_HOST_WRITE_GAP: query status and reconcile the received sequence".into())
    }
}
fn handshake(value: &Value) -> Result<()> {
    if value["protocol"] == PROTOCOL {
        Ok(())
    } else {
        Err("TASK_HOST_PROTOCOL: use protocol 1; unknown versions are drain-only".into())
    }
}
async fn send(stream: &mut (impl AsyncWrite + Unpin + ?Sized), value: &Value) -> Result<()> {
    stream
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(io_error)
}
async fn receive(stream: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> Result<Value> {
    let bytes = crate::line(stream, FRAME_LIMIT * 2 + 4096).await?;
    serde_json::from_slice(&bytes).map_err(io_error)
}
async fn connect(index: &Value) -> Result<Socket> {
    #[cfg(unix)]
    {
        Ok(Box::new(
            tokio::net::UnixStream::connect(string(index, "socket"))
                .await
                .map_err(io_error)?,
        ))
    }
    #[cfg(windows)]
    {
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new()
                .open(string(index, "socket"))
            {
                Ok(stream) => return Ok(Box::new(stream)),
                // The listener replaces the connected instance before serving it.
                // Concurrent readers can arrive in that short handover window.
                Err(error)
                    if error.raw_os_error()
                        == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32) =>
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => return Err(io_error(error)),
            }
        }
    }
}
async fn request(index: &Value, value: Value) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let stream = connect(index).await?;
        let mut stream = BufReader::new(stream);
        send(stream.get_mut(), &json!({"protocol":PROTOCOL})).await?;
        let hello = receive(&mut stream).await?;
        handshake(&hello)?;
        send(stream.get_mut(), &value).await?;
        let reply = receive(&mut stream).await?;
        if let Some(error) = reply["error"].as_str() {
            return Err(error.to_owned());
        }
        Ok(reply)
    })
    .await
    .map_err(|_| "TASK_HOST_TIMEOUT: query host status before retrying writes".to_owned())?
}

pub(crate) struct Client {
    pub index: Value,
    sequence: Mutex<u64>,
}
impl Client {
    pub fn from_index(index: Value) -> Self {
        Self {
            sequence: Mutex::new(index["writeSequence"].as_u64().unwrap_or(0)),
            index,
        }
    }
    pub fn alive(&self) -> bool {
        live(&self.index)
    }
    pub fn exit(&self) -> Option<Value> {
        load(&exit_path(&self.index)).ok()
    }
    pub async fn status(&self) -> Result<Value> {
        if self.index["hostProtocol"] != PROTOCOL {
            return Ok(json!({"alive":self.alive(),"drainOnly":true}));
        }
        request(&self.index, json!({"op":"status"})).await
    }
    pub async fn write(&self, value: Value, state: &Mutex<Value>) -> Result<()> {
        if self.index["hostProtocol"] != PROTOCOL {
            return Err(
                "TASK_HOST_DRAIN_ONLY: wait for this host to exit before starting new turns".into(),
            );
        }
        let mut seq = self.sequence.lock().await;
        let status = self.status().await?;
        let received = status["receivedSequence"]
            .as_u64()
            .ok_or("TASK_HOST_STATUS_INVALID")?;
        if received < *seq {
            return Err("TASK_HOST_WRITE_UNCONFIRMED: reconcile the previous input before sending another write".into());
        }
        *seq = received + 1;
        {
            let mut state = state.lock().await;
            state["taskHost"]["writeSequence"] = json!(*seq);
            state["taskHost"]["unconfirmedWrite"] = json!({"sequence":*seq,"frame":value});
            if matches!(string(&value, "method"), "session/prompt") || value["type"] == "prompt" {
                state["taskHost"]["promptId"] = value["id"].clone();
                state["taskHost"]["promptSequence"] = json!(*seq);
                state["taskHost"]["promptResponded"] = json!(false);
            }
            // Record intent before transmission; an uncertain write is never blindly resent.
            crate::agents::save_task(&state)?;
        }
        let reply = request(
            &self.index,
            json!({"op":"write","sequence":*seq,"frame":value}),
        )
        .await?;
        if reply["receivedSequence"].as_u64().unwrap_or(0) < *seq {
            return Err("TASK_HOST_WRITE_UNCONFIRMED".into());
        }
        let mut state = state.lock().await;
        state["taskHost"]["receivedSequence"] = reply["receivedSequence"].clone();
        // Replay of the host's write journal clears interaction requests atomically
        // with the stdout offset. Keep intent until that journal record is consumed.
        crate::agents::save_task(&state)
    }
    pub async fn signal(&self, kill: bool) -> Result<()> {
        if self.index["hostProtocol"] != PROTOCOL {
            if self.alive() {
                let pid = self.index["agentPid"]
                    .as_u64()
                    .ok_or("TASK_HOST_AGENT_PID")? as u32;
                let start = self.index["agentStart"]
                    .as_str()
                    .ok_or("TASK_HOST_AGENT_IDENTITY_UNAVAILABLE")?;
                if crate::codex_host::process_start(pid).as_deref() == Some(start) {
                    signal_agent(pid, kill);
                }
            }
            return Ok(());
        }
        request(
            &self.index,
            json!({"op":"signal","signal":if kill {"kill"} else {"interrupt"}}),
        )
        .await
        .map(|_| ())
    }
    pub async fn close(&self) -> Result<()> {
        if self.index["hostProtocol"] != PROTOCOL {
            return self.signal(true).await;
        }
        request(&self.index, json!({"op":"close"}))
            .await
            .map(|_| ())
    }
}

/// Copy the standalone Core by content identity so installers can replace their files.
fn executable() -> Result<PathBuf> {
    let source = crate::runtime::binary()?;
    let hash = crate::runtime::build_id(&source)?;
    let directory = root().join("task-host").join(&hash);
    std::fs::create_dir_all(&directory).map_err(io_error)?;
    let target = directory.join(if cfg!(windows) { "arc.exe" } else { "arc" });
    if !target.exists() {
        let temporary = directory.join(format!("{}.tmp", id()));
        std::fs::copy(&source, &temporary).map_err(io_error)?;
        std::fs::rename(temporary, &target).map_err(io_error)?;
    }
    Ok(target)
}
pub(crate) fn gc() -> Result<()> {
    let active: Vec<_> = indexes()
        .into_iter()
        .filter(live)
        .filter_map(|v| v["executable"].as_str().map(PathBuf::from))
        .collect();
    let current = crate::runtime::binary()
        .and_then(|p| crate::runtime::build_id(&p))
        .ok();
    for entry in std::fs::read_dir(root().join("task-host"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() != 64
            || !name.chars().all(|c| c.is_ascii_hexdigit())
            || current.as_deref() == Some(&name)
        {
            continue;
        }
        if !active.iter().any(|p| p.starts_with(entry.path())) {
            std::fs::remove_dir_all(entry.path()).map_err(io_error)?;
        }
    }
    Ok(())
}

/// Startup wire values must be strings, not serde's tagged OsString encoding.
pub(crate) fn command_spec(command: &std::process::Command, cleared: bool) -> Result<Value> {
    fn text(value: &std::ffi::OsStr) -> Result<String> {
        value.to_str().map(str::to_owned).ok_or_else(|| {
            "TASK_HOST_NON_UTF8: use the direct transport for non-UTF-8 launch values".into()
        })
    }
    let mut environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString> =
        if cleared {
            Default::default()
        } else {
            std::env::vars_os().collect()
        };
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            environment.insert(key.into(), value.into());
        } else {
            environment.remove(key);
        }
    }
    let environment = environment
        .iter()
        .map(|(key, value)| Ok((text(key)?, text(value)?)))
        .collect::<Result<std::collections::BTreeMap<String, String>>>()?;
    Ok(json!({"program":text(command.get_program())?,
        "args":command.get_args().map(text).collect::<Result<Vec<_>>>()?,
        "cwd":command.get_current_dir().map(|p|text(p.as_os_str())).transpose()?,"env":environment}))
}

pub(crate) async fn launch(command: &tokio::process::Command, state: &Value) -> Result<Client> {
    let executable = executable()?;
    let directory = instances().join(id());
    std::fs::create_dir_all(&directory).map_err(io_error)?;
    #[cfg(unix)]
    let socket = {
        // Unix socket paths have small OS limits. A private short directory is portable.
        let short = std::env::temp_dir().join(format!("arc-th-{}", id()));
        std::fs::create_dir(&short).map_err(io_error)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&short, std::fs::Permissions::from_mode(0o700))
            .map_err(io_error)?;
        short.join("host.sock").to_string_lossy().into_owned()
    };
    #[cfg(windows)]
    let socket = format!(r"\\.\pipe\arc-task-{}", id());
    let mut spec = command_spec(
        command.as_std(),
        state["agent"] == "claude" && state["agentProfileId"].is_string(),
    )?;
    spec["directory"] = json!(directory);
    spec["socket"] = json!(socket);
    spec["taskId"] = state["taskId"].clone();
    spec["processSession"] = state["processSession"].clone();
    spec["agent"] = state["agent"].clone();
    spec["executable"] = json!(executable);
    #[cfg(target_os = "linux")]
    let attempts: &[bool] = if std::env::var_os("INVOCATION_ID").is_some() {
        &[true, false]
    } else {
        &[false]
    };
    #[cfg(not(target_os = "linux"))]
    let attempts = &[false];
    let mut failure = String::new();
    for scoped in attempts {
        let mut host = if *scoped {
            let mut c = std::process::Command::new("systemd-run");
            c.args(["--user", "--scope", "--collect", "--quiet", "--"])
                .arg(&executable);
            c
        } else {
            std::process::Command::new(&executable)
        };
        host.arg("task-host")
            .env("ARC_STATE_DIR", root())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                host.pre_exec(|| {
                    if libc::setsid() == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        let mut child = match crate::codex_host::detached_spawn(&mut host) {
            Ok(child) => child,
            Err(error) => {
                failure = error;
                continue;
            }
        };
        let sent = child
            .stdin
            .take()
            .ok_or("TASK_HOST_STDIN")?
            .write_all(format!("{spec}\n").as_bytes());
        if let Err(error) = sent {
            let _ = child.kill();
            let _ = child.wait();
            failure = io_error(error);
            continue;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(index) = load(&directory.join("host.json")) {
                if live(&index) && request(&index, json!({"op":"status"})).await.is_ok() {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(Client::from_index(index));
                }
            }
            if child.try_wait().map_err(io_error)?.is_some() || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Host may have spawned an Agent. End that exact indexed host before fallback.
        if let Ok(index) = load(&directory.join("host.json")) {
            if live(&index) {
                let _ = Client::from_index(index).close().await;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        failure = "TASK_HOST_START_FAILED: no protocol handshake".into();
    }
    Err(failure)
}

struct Runtime {
    input: Option<tokio::process::ChildStdin>,
    journal: Journal,
    received: u64,
    agent_pid: u32,
    alive: bool,
    exit_code: Option<i32>,
    busy: bool,
    prompt: Value,
    pending: std::collections::HashSet<String>,
    last_attach: Instant,
    closing: bool,
}
impl Runtime {
    fn status(&self) -> Value {
        json!({"protocol":PROTOCOL,"agentPid":self.agent_pid,"alive":self.alive,"exitCode":self.exit_code,
            "receivedSequence":self.received,"firstOffset":self.journal.first(),"nextOffset":self.journal.next})
    }
    fn observe_write(&mut self, frame: &Value) {
        if frame["method"] == "session/prompt"
            || frame["type"] == "prompt"
            || frame["event"] == "user"
        {
            self.busy = true;
            self.prompt = frame["id"].clone();
        }
        if frame.get("id").is_some()
            && (frame.get("result").is_some()
                || frame.get("error").is_some()
                || frame["type"] == "extension_ui_response")
        {
            self.pending.remove(&frame["id"].to_string());
        }
    }
    fn observe_stdout(&mut self, frame: &Value) {
        if frame["method"] == "session/request_permission"
            || (frame["type"] == "extension_ui_request"
                && matches!(
                    string(frame, "method"),
                    "select" | "confirm" | "input" | "editor"
                ))
        {
            self.pending.insert(frame["id"].to_string());
        }
        if frame["type"] == "agent_settled"
            || frame["event"] == "result"
            || (!self.prompt.is_null()
                && frame["id"] == self.prompt
                && frame.get("method").is_none()
                && frame.get("type").is_none())
            || (frame["type"] == "response"
                && frame["command"] == "prompt"
                && frame["success"] == false)
        {
            self.busy = false;
            self.pending.clear();
        }
    }
}
fn signal_agent(pid: u32, kill: bool) {
    #[cfg(unix)]
    unsafe {
        libc::kill(
            -(pid as i32),
            if kill { libc::SIGKILL } else { libc::SIGINT },
        );
    }
    #[cfg(windows)]
    {
        crate::codex_host::signal(pid, kill);
    }
}
async fn serve_connection(socket: Socket, runtime: Arc<Mutex<Runtime>>) -> Result<()> {
    let mut stream = BufReader::new(socket);
    let hello = receive(&mut stream).await?;
    send(stream.get_mut(), &json!({"protocol":PROTOCOL})).await?;
    handshake(&hello)?;
    let command = receive(&mut stream).await?;
    let mut runtime = runtime.lock().await;
    runtime.last_attach = Instant::now();
    let result: Result<Value> = async {
        match string(&command, "op") {
            "status" => Ok(runtime.status()),
            "write" => {
                let seq = command["sequence"]
                    .as_u64()
                    .ok_or("TASK_HOST_SEQUENCE_REQUIRED")?;
                if write_sequence(runtime.received, seq)? {
                    if runtime.closing {
                        return Err("TASK_HOST_CLOSING".into());
                    }
                    let frame = &command["frame"];
                    // A partial failed pipe write terminates this host; it cannot be retried.
                    let result = runtime
                        .input
                        .as_mut()
                        .ok_or("TASK_HOST_AGENT_EXITED")?
                        .write_all(format!("{frame}\n").as_bytes())
                        .await;
                    if let Err(error) = result {
                        runtime.closing = true;
                        return Err(io_error(error));
                    }
                    runtime.received = seq;
                    if let Err(error) = runtime
                        .journal
                        .append("write", json!({"sequence":seq,"value":frame}))
                    {
                        runtime.closing = true;
                        return Err(error);
                    }
                    runtime.observe_write(frame);
                }
                Ok(runtime.status())
            }
            "signal" => {
                signal_agent(runtime.agent_pid, command["signal"] == "kill");
                Ok(runtime.status())
            }
            "close" => {
                runtime.closing = true;
                Ok(runtime.status())
            }
            _ => Err("TASK_HOST_OP: use status, write, signal or close".into()),
        }
    }
    .await;
    send(
        stream.get_mut(),
        &result.unwrap_or_else(|e| json!({"error":e})),
    )
    .await
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Job {
    fn own_tree() -> Result<Self> {
        use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, GetCurrentProcess()) == 0
            {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Internal standalone entry point. Startup configuration arrives once over stdin.
pub async fn run() -> Result<()> {
    let spec = receive(&mut BufReader::new(tokio::io::stdin())).await?;
    let directory = PathBuf::from(string(&spec, "directory"));
    let socket = string(&spec, "socket");
    #[cfg(unix)]
    let listener = tokio::net::UnixListener::bind(socket).map_err(io_error)?;
    #[cfg(windows)]
    let mut listener = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(socket)
        .map_err(io_error)?;
    #[cfg(windows)]
    let _job = Job::own_tree()?;
    let mut command = crate::command(string(&spec, "program"));
    for arg in spec["args"].as_array().ok_or("TASK_HOST_ARGS")? {
        command.arg(arg.as_str().ok_or("TASK_HOST_ARG")?);
    }
    if let Some(cwd) = spec["cwd"].as_str() {
        command.current_dir(cwd);
    }
    command.env_clear();
    for (key, value) in spec["env"].as_object().ok_or("TASK_HOST_ENV")? {
        command.env(key, value.as_str().ok_or("TASK_HOST_ENV_VALUE")?);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(io_error)?;
    let agent_pid = child.id().ok_or("TASK_HOST_AGENT_PID")?;
    let journal = Journal::new(directory.join("journal.jsonl"))?;
    let index = json!({"hostPid":std::process::id(),"hostStart":crate::codex_host::process_start(std::process::id()),
        "socket":socket,"journalPath":journal.path,"ackedOffset":0,"agentPid":agent_pid,"agentStart":crate::codex_host::process_start(agent_pid),"hostProtocol":PROTOCOL,
        "taskId":spec["taskId"],"processSession":spec["processSession"],"agent":spec["agent"],"executable":spec["executable"]});
    save(&directory.join("host.json"), &index)?;
    let runtime = Arc::new(Mutex::new(Runtime {
        input: child.stdin.take(),
        journal,
        received: 0,
        agent_pid,
        alive: true,
        exit_code: None,
        busy: false,
        prompt: Value::Null,
        pending: Default::default(),
        last_attach: Instant::now(),
        closing: false,
    }));
    let stdout = child.stdout.take().ok_or("TASK_HOST_STDOUT")?;
    let output_runtime = runtime.clone();
    let output = tokio::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        loop {
            let frame = match crate::line(&mut stdout, FRAME_LIMIT).await {
                Ok(frame) if frame.is_empty() => return Ok::<_, String>(()),
                Ok(frame) => frame,
                Err(error) => return Err(error),
            };
            let mut runtime = output_runtime.lock().await;
            let text = String::from_utf8_lossy(&frame).into_owned();
            runtime.journal.append("stdout", json!(text))?;
            if let Ok(frame) = serde_json::from_slice(&frame) {
                runtime.observe_stdout(&frame);
            }
        }
    });
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(io_error)?;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(io_error)?,
            _ = async {
                #[cfg(unix)] { terminate.recv().await; }
                #[cfg(not(unix))] { std::future::pending::<()>().await; }
            } => { runtime.lock().await.closing = true; },
            _ = tick.tick() => {
                let mut runtime = runtime.lock().await;
                if runtime.closing || (!runtime.busy && runtime.pending.is_empty() && runtime.last_attach.elapsed() >= ORPHAN_GRACE) || output.is_finished() {
                    runtime.input.take();
                    drop(runtime);
                    let status = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                    if let Ok(status) = status { break status.map_err(io_error)?; }
                    crate::codex_host::signal(agent_pid, true);
                    break child.wait().await.map_err(io_error)?;
                }
            }
            accepted = async {
                #[cfg(unix)]
                { listener.accept().await.map(|(stream,_)| Box::new(stream) as Socket) }
                #[cfg(windows)]
                {
                    listener.connect().await?;
                    let next = tokio::net::windows::named_pipe::ServerOptions::new().reject_remote_clients(true).create(socket)?;
                    Ok::<Socket,std::io::Error>(Box::new(std::mem::replace(&mut listener, next)))
                }
            } => {
                if let Ok(stream) = accepted {
                    let runtime = runtime.clone();
                    tokio::spawn(async move { let _ = tokio::time::timeout(Duration::from_secs(15), serve_connection(stream,runtime)).await; });
                }
            }
        }
    };
    // Descendants cannot retain stdout forever after their Agent exits.
    crate::codex_host::signal(agent_pid, true);
    let output_error = match tokio::time::timeout(Duration::from_secs(3), output).await {
        Ok(Ok(result)) => result.err(),
        _ => Some("TASK_HOST_STDOUT_DRAIN_FAILED".into()),
    };
    let mut runtime = runtime.lock().await;
    runtime.alive = false;
    runtime.exit_code = status.code();
    let mut exit = runtime.status();
    exit["error"] = json!(output_error);
    exit["exitedAt"] = json!(now());
    save(&directory.join("exit.json"), &exit)?;
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(socket);
        if let Some(parent) = Path::new(socket).parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

async fn stop_index(client: &Client) {
    if client.alive() {
        let _ = client.close().await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while client.alive() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    if let (Some(pid), Some(start)) = (
        client.index["agentPid"].as_u64(),
        client.index["agentStart"].as_str(),
    ) {
        if crate::codex_host::process_start(pid as u32).as_deref() == Some(start) {
            signal_agent(pid as u32, true);
        }
    }
    if client.alive() {
        crate::codex_host::signal(client.index["hostPid"].as_u64().unwrap() as u32, true);
    }
}
pub(crate) async fn stop_all() -> Result<()> {
    for index in indexes() {
        stop_index(&Client::from_index(index)).await;
    }
    gc()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_command_preserves_string_arguments_and_environment() {
        // Regression: OsStr serialization encoded tagged values and panicked on environment map keys.
        let mut command = std::process::Command::new("fixture-agent");
        command
            .args(["--mode", "rpc"])
            .env_clear()
            .env("FIXTURE_VALUE", "with spaces")
            .env_remove("REMOVED");
        let spec = command_spec(&command, true).unwrap();
        assert_eq!(spec["program"], "fixture-agent");
        assert_eq!(spec["args"], json!(["--mode", "rpc"]));
        assert_eq!(spec["env"], json!({"FIXTURE_VALUE":"with spaces"}));
    }
    #[tokio::test]
    async fn protocol_frames_and_version_handshake() {
        // Contract: task-host v1 uses newline JSON frames and requires a protocol 1 handshake.
        let (mut writer, reader) = tokio::io::duplex(1024);
        send(&mut writer, &json!({"protocol":1})).await.unwrap();
        let frame = receive(&mut BufReader::new(reader)).await.unwrap();
        handshake(&frame).unwrap();
        assert!(handshake(&json!({"protocol":2}))
            .unwrap_err()
            .starts_with("TASK_HOST_PROTOCOL:"));
    }
    #[test]
    fn journal_replay_is_ordered_and_resumes_after_offset() {
        // Contract: task-host journal offsets increase by one and replay excludes acknowledged records.
        let path = std::env::temp_dir().join(format!("arc-journal-{}", id()));
        let mut journal = Journal::new(path.clone()).unwrap();
        journal.append("stdout", json!("first")).unwrap();
        journal
            .append("write", json!({"sequence":1,"value":{"id":"string-id"}}))
            .unwrap();
        journal.append("stdout", json!("last")).unwrap();
        let rows = replay(&path, 1).unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r["offset"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(replay(&path, 3).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn received_write_sequence_is_deduplicated() {
        // Contract: task-host v1 acknowledges duplicate writes without sending them to Agent stdin again.
        assert!(write_sequence(0, 1).unwrap());
        assert!(!write_sequence(1, 1).unwrap());
        assert!(!write_sequence(2, 1).unwrap());
        assert!(write_sequence(1, 3)
            .unwrap_err()
            .starts_with("TASK_HOST_WRITE_GAP:"));
    }
}
