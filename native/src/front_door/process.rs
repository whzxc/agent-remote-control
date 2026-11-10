//! Detached front door and private, authenticated socket/pipe attachment to Core.
use super::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs::File, process::Stdio, time::Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

static CORE_GENERATION: std::sync::Mutex<Option<Generation>> = std::sync::Mutex::new(None);
static FRONT_DOOR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) fn is_front_door() -> bool {
    FRONT_DOOR.load(Ordering::SeqCst)
}
#[cfg(unix)]
type Stream = tokio::net::UnixStream;
#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;
fn endpoint(owner: &str) -> String {
    #[cfg(unix)]
    {
        socket_directory()
            .join(format!("{owner}.sock"))
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(windows)]
    {
        format!(
            r"\\.\pipe\arc-{}-{owner}",
            &hash(root().to_string_lossy().as_bytes())[..24]
        )
    }
}
#[cfg(unix)]
fn socket_directory() -> PathBuf {
    let state = root().canonicalize().unwrap_or_else(|_| root());
    PathBuf::from("/tmp").join(format!(
        "arc-ipc-{}-{}",
        unsafe { libc::geteuid() },
        &hash(state.to_string_lossy().as_bytes())[..24]
    ))
}
#[cfg(unix)]
fn prepare_socket_directory() -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let directory = socket_directory();
    if let Ok(metadata) = std::fs::symlink_metadata(&directory) {
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("FRONT_DOOR_SOCKET_DIRECTORY: The private IPC directory is not owned by the current user.".into());
        }
    }
    private_dir(&directory)
}
struct Listeners(Vec<tokio::task::JoinHandle<()>>);
impl Drop for Listeners {
    fn drop(&mut self) {
        for listener in &self.0 {
            listener.abort();
        }
    }
}
#[cfg(unix)]
struct SocketPath(String);
#[cfg(unix)]
impl Drop for SocketPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_dir(socket_directory());
    }
}
fn info_path() -> PathBuf {
    root().join("app/front-door.json")
}
/// Compare the observed front-door image with the build used by the local entry point.
pub(crate) fn status(installed_build: &str) -> Value {
    let Ok(info) = load(&info_path()) else {
        return Value::Null;
    };
    json!({"pid":info["pid"],"protocol":info["protocol"],"build":info["build"],"installedBuild":installed_build,"matchesInstalledBuild":info["build"].as_str().map(|build|build == installed_build)})
}

fn stage_image(source: &Path, images: &Path) -> Result<PathBuf> {
    let build = crate::runtime::build_id(source)?;
    let directory = images.join(format!("v{VERSION}")).join(&build);
    private_dir(&directory)?;
    let binary = directory.join(if cfg!(windows) { "arc.exe" } else { "arc" });
    if !binary.exists() {
        let staging = directory.join(format!("install-{}", id()));
        let result = (|| {
            std::fs::copy(source, &staging).map_err(|e| e.to_string())?;
            if crate::runtime::build_id(&staging)? != build {
                return Err("FRONT_DOOR_BUILD_CHANGED: The installed executable changed while copying; retry after installation finishes.".into());
            }
            std::fs::rename(&staging, &binary).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(staging);
        }
        result?;
    }
    Ok(binary)
}

/// Called only by the front-door lock owner after recovering the previous owner's children.
fn prune_images(images: &Path, build: &str) -> Result<()> {
    let keep = images.join(format!("v{VERSION}")).join(build);
    let Ok(protocols) = std::fs::read_dir(images) else {
        return Ok(());
    };
    for protocol in protocols {
        let protocol = protocol.map_err(|e| e.to_string())?;
        let path = protocol.path();
        if path == keep.parent().unwrap() {
            for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.path() == keep {
                    continue;
                }
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    std::fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
                } else {
                    std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                }
            }
        } else if protocol.file_type().map_err(|e| e.to_string())?.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn ensure_secret() -> Result<String> {
    private_dir(&root().join("app"))?;
    let path = root().join("app/front-door-secret.json");
    if !path.exists() {
        save(&path, &json!({"token":id()+&id()}))?;
    }
    secret()
}
fn secret() -> Result<String> {
    Ok(load(&root().join("app/front-door-secret.json"))?["token"]
        .as_str()
        .ok_or("FRONT_DOOR_SECRET_MISSING")?
        .into())
}
#[derive(Serialize, Deserialize)]
enum Attach {
    Hello { version: u16, token: String },
    Stop { token: String },
}
#[derive(Serialize, Deserialize)]
enum Message {
    Request(Request),
    Stream(Request),
    Cancel(Cancellation),
    Gateway(Request),
}

async fn write<S: AsyncWrite + Unpin, T: Serialize>(stream: &mut S, value: &T) -> Result<()> {
    bounded(value, MAX_FRAME_BYTES)?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}
async fn respond<S: AsyncWrite + Unpin>(
    stream: &mut S,
    frame: ResponseFrame,
    deadline: Deadline,
) -> Result<()> {
    #[cfg(feature = "test-fixture")]
    if std::env::var("ARC_FIXTURE_LOST_RESPONSE_ID").as_deref() == Ok(&frame.request_id.0) {
        if let Some(gate) = std::env::var_os("ARC_FIXTURE_LOST_RESPONSE_GATE") {
            let gate = PathBuf::from(gate);
            save(&gate.with_extension("ready"), &json!({"ready":true}))?;
            while gate.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
    tokio::time::timeout(deadline.remaining()?,write(stream,&frame)).await.map_err(|_|"FRONT_DOOR_DEADLINE_EXPIRED: Response delivery expired; read the original receipt before retrying a write.".to_owned())?
}
async fn read<S: AsyncRead + Unpin, T: DeserializeOwned>(
    stream: &mut S,
    limit: usize,
) -> Result<T> {
    let size = stream.read_u32().await.map_err(|e| e.to_string())? as usize;
    if size > limit {
        return Err(
            "FRONT_DOOR_FRAME_TOO_LARGE: Reduce the request or read a smaller result page.".into(),
        );
    }
    let mut bytes = vec![0; size];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
async fn raw_connect(owner: &str) -> Result<Stream> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(endpoint(owner))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(endpoint(owner))
            .map_err(|e| e.to_string())
    }
}
async fn connect(owner: &str) -> Result<(Stream, Hello)> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let code=if owner == "core" {"FRONT_DOOR_CORE_UNAVAILABLE"}else{"FRONT_DOOR_UNAVAILABLE"};
        let mut stream=raw_connect(owner).await.map_err(|e|format!("{code}: {e}. Continuity is reduced; Core-bound fallback transports disconnect during Core replacement."))?;
        write(&mut stream, &Attach::Hello { version: VERSION, token: secret()? }).await?;
        let hello: Result<Hello> = read(&mut stream, 4096).await?;
        let hello = hello?;
        if hello.version != VERSION { return Err("FRONT_DOOR_PROTOCOL_MISMATCH: Install a matching ARC build; run arc front-door-prepare before restarting Core.".into()); }
        if owner == "core" {*CORE_GENERATION.lock().unwrap()=Some(hello.generation);}
        if hello.readiness != Readiness::Ready { return Err("FRONT_DOOR_CORE_DRAINING: Wait for Core readiness and read the original receipt before retrying a write.".into()); }
        Ok((stream,hello))
    }).await.map_err(|_| "FRONT_DOOR_CONNECT_TIMEOUT: Wait for Core readiness before retrying.".to_owned())?
}

pub(crate) async fn gateway_request(route: &str, method: &str, body: Value) -> Result<Value> {
    let (mut stream, hello) = connect("front-door").await?;
    let request = request(
        &hello,
        management_context(),
        Operation::Management {
            route: route.into(),
            method: method.into(),
        },
        body,
    );
    bounded(&request, MAX_REQUEST_BYTES)?;
    let result = async {
        write(&mut stream, &Message::Gateway(request.clone())).await?;
        let frame: ResponseFrame = read(&mut stream, MAX_FRAME_BYTES).await?;
        fence(request.generation, frame.generation)?;
        if frame.request_id.0 != request.id.0 {
            return Err("FRONT_DOOR_REQUEST_MISMATCH".to_owned());
        }
        Ok::<_, String>(frame)
    };
    let frame = tokio::time::timeout(request.deadline.remaining()?, result)
        .await
        .map_err(|_| lost(&request, "front-door deadline expired"))?
        .map_err(|e| lost(&request, &e))?;
    frame.body
}

/// Local callers use the existing authenticated private Core endpoint. Failure to
/// attach may fall back to an older installed build; submitted writes never do.
pub(crate) async fn local_request(route: &str, method: &str, body: Value) -> Option<Result<Value>> {
    let (mut stream, hello) = connect("core").await.ok()?;
    let operation = match route {
        "healthz" => Operation::Health,
        "cli/control" => Operation::LocalControl,
        _ => Operation::Management {
            route: route.into(),
            method: method.into(),
        },
    };
    let request = request(&hello, management_context(), operation, body);
    Some(
        exchange(&mut stream, &request)
            .await
            .and_then(|frame| frame.body),
    )
}

fn request(
    hello: &Hello,
    context: AuthenticatedContext,
    operation: Operation,
    mut body: Value,
) -> Request {
    let envelope = match operation {
        Operation::Mcp => &body["params"]["arguments"],
        _ => &body,
    };
    let receipt_mode = catalog()["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == envelope["op"])
        .is_some_and(|op| crate::egress::retry_contract(op)["mode"] == "receipt");
    let original = envelope["args"]["requestId"].as_str().or_else(|| {
        body["params"]["arguments"]["requestId"]
            .as_str()
            .or_else(|| body["requestId"].as_str())
    });
    let request_id = original.map(str::to_owned).unwrap_or_else(id);
    if receipt_mode
        && matches!(operation, Operation::Mcp)
        && body["method"] == "tools/call"
        && body["params"]["name"] == "act"
        && body["params"]["arguments"].is_object()
        && body["params"]["arguments"].get("requestId").is_none()
    {
        body["params"]["arguments"]["requestId"] = json!(request_id);
    }
    if receipt_mode
        && matches!(operation, Operation::LocalControl)
        && body.is_object()
        && body.get("requestId").is_none()
    {
        body["requestId"] = json!(request_id);
    }
    let deadline = if context.is_browser() && !matches!(operation, Operation::Snapshot { .. }) {
        Deadline::after(Duration::from_secs(30))
    } else {
        deadline()
    };
    Request {
        version: VERSION,
        generation: hello.generation,
        id: RequestId(request_id),
        deadline,
        context,
        operation,
        body,
    }
}
fn is_write(request: &Request) -> bool {
    let envelope = match request.operation {
        Operation::Mcp => &request.body["params"]["arguments"],
        Operation::LocalControl => &request.body,
        _ => &Value::Null,
    };
    if envelope["op"] == "receipt"
        && envelope["args"]["action"].as_str().unwrap_or("read") == "read"
    {
        return false;
    }
    match &request.operation {
        Operation::Health | Operation::Snapshot { .. } => false,
        Operation::Mcp => {
            request.body["method"] == "tools/call" && request.body["params"]["name"] == "act"
        }
        Operation::LocalControl => catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == request.body["op"])
            .is_some_and(|op| crate::egress::via(op) == "act"),
        Operation::Management { method, .. } => method != "GET",
        Operation::Authority { op } => !matches!(
            op.as_str(),
            "get"
                | "for_grant"
                | "control_sources"
                | "candidates"
                | "grant_active"
                | "validate_claim"
                | "active_grants"
                | "default_policy"
                | "ingress_retired"
        ),
    }
}
fn lost(request: &Request, reason: &str) -> String {
    if is_write(request) {
        json!({"code":-32603,"message":"Core disconnected after write submission; outcome is uncertain. Do not repeat the write.","data":{"state":"unconfirmed","requestId":request.id.0,"reason":reason,"next":{"via":"act","op":"receipt","args":{"action":"read","requestId":request.id.0}}}}).to_string()
    } else {
        format!("FRONT_DOOR_CORE_LOST: {reason}. Read failed; issue a new authorized read when Core is ready.")
    }
}
// A permit owns the waiting future's request identity and encoded memory budget.
// Dropping a caller removes only that queued request; nothing has been sent yet.
struct AdmissionQueue {
    entries: Arc<tokio::sync::Semaphore>,
    bytes: Arc<tokio::sync::Semaphore>,
}
impl AdmissionQueue {
    fn new() -> Self {
        Self {
            entries: Arc::new(tokio::sync::Semaphore::new(MAX_QUEUED)),
            bytes: Arc::new(tokio::sync::Semaphore::new(MAX_QUEUE_BYTES)),
        }
    }
    fn reserve(&self, request: &Request) -> Result<QueueEntry> {
        if self.entries.is_closed() {
            return Err(not_sent(
                request,
                "FRONT_DOOR_UNAVAILABLE",
                "The front door is stopping. Reconnect after it restarts.",
            ));
        }
        let size = encoded_size(request, MAX_REQUEST_BYTES)?;
        let full = || {
            not_sent(request, "FRONT_DOOR_BUSY", "The Core admission queue is full. Wait for Core readiness, then retry with the same requestId.")
        };
        let entry = self
            .entries
            .clone()
            .try_acquire_owned()
            .map_err(|_| full())?;
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(size as u32)
            .map_err(|_| full())?;
        Ok(QueueEntry {
            _entry: entry,
            _bytes: bytes,
        })
    }
}
struct QueueEntry {
    _entry: tokio::sync::OwnedSemaphorePermit,
    _bytes: tokio::sync::OwnedSemaphorePermit,
}
fn queue() -> &'static AdmissionQueue {
    static QUEUE: std::sync::OnceLock<AdmissionQueue> = std::sync::OnceLock::new();
    QUEUE.get_or_init(AdmissionQueue::new)
}
fn not_sent(request: &Request, code: &str, reason: &str) -> String {
    json!({"code":-32603,"message":format!("{code}: {reason} Request was not sent to Core."),"data":{"requestId":request.id.0,"next":{"via":"query","op":"guide","args":{"topic":"loop"}}}}).to_string()
}
fn waiting_request(context: AuthenticatedContext, operation: Operation, body: Value) -> Request {
    request(
        &Hello {
            version: VERSION,
            generation: Generation([0; 16]),
            readiness: Readiness::Unavailable,
            max_request_bytes: MAX_REQUEST_BYTES,
            max_frame_bytes: MAX_FRAME_BYTES,
        },
        context,
        operation,
        body,
    )
}
async fn ready(request: &mut Request) -> Result<Stream> {
    let expired = || {
        not_sent(request, "FRONT_DOOR_DEADLINE_EXPIRED", "The original admission deadline expired. Read current state before retrying with the same requestId.")
    };
    let remaining = request.deadline.remaining().map_err(|_| expired())?;
    let connection = tokio::time::timeout(remaining, async {
        loop {
            if queue().entries.is_closed() {
                return Err(not_sent(
                    request,
                    "FRONT_DOOR_UNAVAILABLE",
                    "The front door is stopping. Reconnect after it restarts.",
                ));
            }
            match connect("core").await {
                Ok((stream, hello)) => return Ok((stream, hello)),
                Err(error)
                    if error.starts_with("FRONT_DOOR_PROTOCOL_MISMATCH")
                        || error.starts_with("FRONT_DOOR_PEER_UNAUTHORIZED") =>
                {
                    return Err(error)
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await
    .map_err(|_| expired())??;
    request.generation = connection.1.generation;
    Ok(connection.0)
}
pub(crate) async fn call(
    context: AuthenticatedContext,
    operation: Operation,
    body: Value,
) -> Result<Value> {
    let mut request = waiting_request(context, operation, body);
    let waiting = queue().reserve(&request)?;
    let mut stream = ready(&mut request).await?;
    drop(waiting);
    // From the first byte written, even a partial send is ambiguous. Never resend.
    let frame = exchange(&mut stream, &request).await?;
    if let Some(current) = *CORE_GENERATION.lock().unwrap() {
        fence(current, frame.generation).map_err(|e| lost(&request, &e))?;
    }
    match frame.body {
        Err(error)
            if is_write(&request)
                && (error.starts_with("FRONT_DOOR_DEADLINE_EXPIRED")
                    || error.starts_with("FRONT_DOOR_CANCELLED")) =>
        {
            Err(lost(&request, &error))
        }
        result => result,
    }
}
async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    request: &Request,
) -> Result<ResponseFrame> {
    let result = async {
        write(stream, &Message::Request(request.clone())).await?;
        let frame: ResponseFrame = read(stream, MAX_FRAME_BYTES).await?;
        fence(request.generation, frame.generation)?;
        if frame.request_id.0 != request.id.0 {
            return Err("FRONT_DOOR_REQUEST_MISMATCH".to_owned());
        }
        Ok::<_, String>(frame)
    };
    let remaining = request.deadline.remaining().map_err(|_| not_sent(request,
        "FRONT_DOOR_DEADLINE_EXPIRED", "The original admission deadline expired. Read current state before retrying with the same requestId."))?;
    tokio::time::timeout(remaining, result)
        .await
        .map_err(|_| lost(request, "deadline expired"))?
        .map_err(|e| lost(request, &e))
}

pub(crate) async fn authority(op: &str, body: Value) -> Result<Value> {
    call(
        management_context(),
        Operation::Authority { op: op.into() },
        body,
    )
    .await
}
pub(crate) async fn stream(
    context: AuthenticatedContext,
    kind: Snapshot,
) -> Result<tokio::sync::mpsc::Receiver<hyper::body::Bytes>> {
    let mut request = waiting_request(context, Operation::Snapshot { kind }, json!({}));
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        loop {
            let socket = {
                let attach = async {
                    let waiting = queue().reserve(&request)?;
                    let socket = ready(&mut request).await;
                    drop(waiting);
                    let mut socket = socket?;
                    write(&mut socket, &Message::Stream(request.clone())).await?;
                    Ok::<_, String>(socket)
                };
                tokio::pin!(attach);
                loop {
                    tokio::select! {
                        _ = tx.closed() => return,
                        result = &mut attach => break result,
                        _ = tokio::time::sleep(Duration::from_secs(15)) => {
                            if !send_stream_bytes(&tx, ": keepalive\n\n".into()).await { return; }
                        }
                    }
                }
            };
            let mut socket = match socket {
                Ok(socket) => socket,
                Err(error) => {
                    send_stream_error(
                        &tx,
                        &format!("{error} Reconnect the snapshot stream after Core is ready."),
                    )
                    .await;
                    return;
                }
            };
            let mut sequence = 0;
            loop {
                let received = tokio::select! {
                    _ = tx.closed() => return,
                    result = tokio::time::timeout(request.deadline.remaining().unwrap_or_default(), read::<_,Result<StreamFrame>>(&mut socket,MAX_FRAME_BYTES)) => result.map_err(|_|"stream deadline expired".to_owned()).and_then(|r|r),
                };
                let frame = match received {
                    Ok(Ok(frame)) => frame,
                    Ok(Err(error)) if error.starts_with("FRONT_DOOR_CORE_DRAINING") => {
                        if !send_stream_error(&tx, "FRONT_DOOR_CORE_DRAINING: Snapshot gap; reattaching after Core is ready. Read a fresh snapshot if reattachment expires.").await { return; }
                        break;
                    }
                    Ok(Err(error)) => {
                        send_stream_error(&tx, &format!("{error} Read current source authority and reconnect the snapshot stream.")).await;
                        return;
                    }
                    Err(error) => {
                        // Snapshots replace state; reattach reads only, retaining the public body and deadline.
                        if !send_stream_error(&tx, &format!("FRONT_DOOR_CORE_LOST: {error}. Snapshot gap; reattaching to Core. Read a fresh snapshot if reattachment expires.")).await { return; }
                        break;
                    }
                };
                let body = (|| {
                    fence(request.generation, frame.generation)?;
                    if let Some(current) = *CORE_GENERATION.lock().unwrap() {
                        fence(current, frame.generation)?;
                    }
                    if frame.request_id.0 != request.id.0 || frame.sequence != sequence {
                        return Err("FRONT_DOOR_REQUEST_MISMATCH".to_owned());
                    }
                    Ok(frame.body)
                })();
                let bytes = match body {
                    Ok(value) if value.is_null() => ": keepalive\n\n".into(),
                    Ok(value) => format!("event: snapshot\ndata: {value}\n\n"),
                    Err(error) => {
                        send_stream_error(
                            &tx,
                            &format!("{error} Read a fresh snapshot and reconnect the stream."),
                        )
                        .await;
                        return;
                    }
                };
                if !send_stream_bytes(&tx, bytes).await {
                    return;
                }
                sequence += 1;
            }
        }
    });
    Ok(rx)
}
async fn send_stream_bytes(
    tx: &tokio::sync::mpsc::Sender<hyper::body::Bytes>,
    bytes: String,
) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), tx.send(bytes.into())).await,
        Ok(Ok(()))
    )
}
async fn send_stream_error(
    tx: &tokio::sync::mpsc::Sender<hyper::body::Bytes>,
    error: &str,
) -> bool {
    send_stream_bytes(
        tx,
        format!("event: error\ndata: {}\n\n", json!({"error":error})),
    )
    .await
}

#[derive(Clone)]
enum Owner {
    Core(
        Arc<Service>,
        Option<Arc<dyn crate::transport::DesktopAccess>>,
    ),
    Gateway(Arc<owner::Gateway>, Arc<tokio::sync::Notify>),
}
impl Owner {
    fn hello(&self, version: u16) -> Result<Hello> {
        match self {
            Self::Core(s, _) => s.execution.front_door.hello(version),
            Self::Gateway(gateway, _) => {
                #[cfg(feature = "test-fixture")]
                let version = if std::env::var_os("ARC_FIXTURE_FRONT_DOOR_INCOMPATIBLE")
                    .is_some_and(|path| Path::new(&path).exists())
                {
                    0
                } else {
                    version
                };
                if version != VERSION {
                    return Err("FRONT_DOOR_PROTOCOL_MISMATCH: Run arc front-door-prepare from the new installation before restarting Core.".into());
                }
                Ok(Hello {
                    version: VERSION,
                    generation: gateway.generation,
                    readiness: Readiness::Ready,
                    max_request_bytes: MAX_REQUEST_BYTES,
                    max_frame_bytes: MAX_FRAME_BYTES,
                })
            }
        }
    }
}
async fn serve_connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    owner: Owner,
) -> Result<()> {
    let attach: Attach = tokio::time::timeout(Duration::from_secs(3), read(&mut stream, 4096))
        .await
        .map_err(|_| "private peer handshake timeout")??;
    let version = match attach {
        Attach::Stop { token } if token == secret()? => {
            if let Owner::Gateway(_, stop) = owner {
                stop.notify_one();
                write(&mut stream, &Ok::<_, String>(json!({"stopping":true}))).await?;
            }
            return Ok(());
        }
        Attach::Hello { version, token } if token == secret()? => version,
        _ => return Err("FRONT_DOOR_PEER_UNAUTHORIZED".into()),
    };
    let hello = owner.hello(version);
    write(&mut stream, &hello).await?;
    hello?;
    let message: Message = tokio::time::timeout(
        Duration::from_secs(5),
        read(&mut stream, MAX_REQUEST_BYTES + 4096),
    )
    .await
    .map_err(|_| "private peer request timeout")??;
    match (owner, message) {
        (Owner::Gateway(gateway, _), Message::Gateway(request)) => {
            let hello = Owner::Gateway(gateway.clone(), Arc::new(tokio::sync::Notify::new()))
                .hello(request.version)?;
            fence(hello.generation, request.generation)?;
            if !request.context.is_management() {
                return Err("FRONT_DOOR_CONTEXT_MISMATCH".into());
            }
            request.validate()?;
            let Operation::Management { route, method } = &request.operation else {
                return Err("FRONT_DOOR_CONTEXT_MISMATCH".into());
            };
            let body = tokio::time::timeout(
                request.deadline.remaining()?,
                gateway.request(route, method, request.body.clone()),
            )
            .await
            .map_err(|_| lost(&request, "front-door deadline expired"))?;
            respond(
                &mut stream,
                ResponseFrame {
                    generation: request.generation,
                    request_id: request.id,
                    body,
                },
                request.deadline,
            )
            .await
        }
        (Owner::Core(service, desktop), Message::Request(mut request)) => {
            let endpoint = service.execution.front_door.clone();
            let target_ingress = if matches!(request.operation, Operation::Mcp) {
                Some(
                    service
                        .ingress(
                            request
                                .context
                                .ingress_id()
                                .ok_or("FRONT_DOOR_CONTEXT_MISMATCH")?,
                        )
                        .await?,
                )
            } else {
                None
            };
            let body = async {
                let hello = endpoint.hello(request.version)?;
                fence(hello.generation, request.generation)?;
                request.deadline.remaining()?;
                bounded(&request, MAX_REQUEST_BYTES)?;
                if hello.readiness != Readiness::Ready {
                    return Err("FRONT_DOOR_CORE_DRAINING: Wait for Core readiness before retrying with the same requestId.".into());
                }
                if let protocol::Authority::Ingress { principal, header, .. } = &request.context.authority {
                    let ingress = target_ingress.as_ref().ok_or("FRONT_DOOR_CONTEXT_MISMATCH")?;
                    if !ingress.connected.load(Ordering::SeqCst) || ingress.meta.lock().await["enabled"] != true {
                        return Err("Connection closed".into());
                    }
                    request.context = authenticated_context(ingress, principal, header.as_deref()).await?;
                }
                let target = match &target_ingress {
                    Some(i) => Target::Ingress(i),
                    None => Target::Service(&service, desktop.as_ref()),
                };
                tokio::select! {
                    body = endpoint.send(request.clone(), target) => body,
                    // The socket belongs to this generation, so closing it cannot cancel a newer request.
                    _ = stream.read_u8() => Err("FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged.".into()),
                }
            }.await;
            respond(
                &mut stream,
                ResponseFrame {
                    generation: request.generation,
                    request_id: request.id,
                    body,
                },
                request.deadline,
            )
            .await
        }
        (Owner::Core(service, _), Message::Stream(request)) => {
            let mut frames = match service
                .execution
                .front_door
                .open_stream(request, service.clone())
                .await
            {
                Ok(frames) => frames,
                Err(error) => {
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        write(&mut stream, &Err::<StreamFrame, String>(error)),
                    )
                    .await
                    .map_err(|_| "private stream backpressure")??;
                    return Ok(());
                }
            };
            loop {
                tokio::select! {
                    _ = stream.read_u8() => return Ok(()),
                    frame = frames.recv() => match frame {
                        Some(frame) => { tokio::time::timeout(Duration::from_secs(2),write(&mut stream,&frame)).await.map_err(|_|"private stream backpressure")??; }
                        None => return Ok(()),
                    }
                }
            }
        }
        (Owner::Core(service, _), Message::Cancel(cancellation)) => {
            service.execution.front_door.cancel(&cancellation)
        }
        _ => Err("FRONT_DOOR_CONTEXT_MISMATCH".into()),
    }
}
#[cfg(unix)]
fn bind_socket(name: &str, address: &str) -> Result<tokio::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    prepare_socket_directory()?;
    let _ = std::fs::remove_file(address);
    let listener = tokio::net::UnixListener::bind(address)
        .map_err(|e| format!("Cannot bind private {name} socket: {e}"))?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok(listener)
}
async fn listen(name: &str, owner: Owner) -> Result<tokio::task::JoinHandle<()>> {
    let address = endpoint(name);
    #[cfg(unix)]
    let mut listener = bind_socket(name, &address)?;
    #[cfg(unix)]
    let name = name.to_owned();
    #[cfg(windows)]
    let mut listener = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&address)
        .map_err(|e| e.to_string())?;
    Ok(tokio::spawn(async move {
        #[cfg(unix)]
        let _socket_path = SocketPath(address.clone());
        #[cfg(unix)]
        let mut path_check = tokio::time::interval(Duration::from_secs(5));
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT));
        let mut connections = tokio::task::JoinSet::new();
        loop {
            #[cfg(unix)]
            let accepted = async { listener.accept().await.map(|(stream, _)| stream) };
            #[cfg(windows)]
            let accepted = async {
                listener.connect().await?;
                let next = tokio::net::windows::named_pipe::ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(&address)?;
                Ok::<_, std::io::Error>(std::mem::replace(&mut listener, next))
            };
            let stream = tokio::select! {
                Some(_) = connections.join_next(), if !connections.is_empty() => continue,
                _ = async {
                    #[cfg(unix)]
                    path_check.tick().await;
                    #[cfg(not(unix))]
                    std::future::pending::<()>().await;
                } => {
                    #[cfg(unix)]
                    if !Path::new(&address).exists() {
                        match bind_socket(&name,&address) {
                            Ok(rebound)=>listener=rebound,
                            Err(error)=>crate::logs::record("ERROR",&error,None),
                        }
                    }
                    continue;
                },
                stream = accepted => match stream {Ok(stream)=>stream,Err(_)=>break},
            };
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let owner = owner.clone();
            connections.spawn(async move {
                let _permit = permit;
                let _ = serve_connection(stream, owner).await;
            });
        }
    }))
}

pub(crate) async fn attach_core(
    service: Arc<Service>,
    desktop: Option<Arc<dyn crate::transport::DesktopAccess>>,
) -> Result<tokio::task::JoinHandle<()>> {
    private_dir(&root().join("app"))?;
    if !root().join("app/front-door-secret.json").exists() {
        save(
            &root().join("app/front-door-secret.json"),
            &json!({"token":id()+&id()}),
        )?;
    }
    service.execution.front_door.bind(&service);
    service.subscriptions.start();
    let listener = listen("core", Owner::Core(service.clone(), desktop)).await?;
    #[cfg(test)]
    let (info, listener) = {
        let gateway = owner::Gateway::new()?;
        let stop = Arc::new(tokio::sync::Notify::new());
        let private = listen("front-door", Owner::Gateway(gateway.clone(), stop)).await?;
        let http = crate::transport::listen_gateway(gateway.clone()).await?;
        let owned = Listeners(vec![listener, private, http]);
        let listener = tokio::spawn(async move {
            let _owned = owned;
            std::future::pending::<()>().await;
        });
        (
            json!({"port":gateway.port.load(Ordering::SeqCst),"token":gateway.token}),
            listener,
        )
    };
    #[cfg(not(test))]
    let info = match ensure().await {
        Ok(info) => info,
        Err(error) => {
            listener.abort();
            return Err(error);
        }
    };
    service.port.store(
        info["port"].as_u64().ok_or("FRONT_DOOR_PORT_MISSING")? as u16,
        Ordering::SeqCst,
    );
    save(
        &root().join("app/native.json"),
        &json!({"port":info["port"],"token":info["token"],"pid":std::process::id(),"processStart":crate::codex_host::process_start(std::process::id()),"instance":service.control.session,"runtime":"rust","version":env!("ARC_BUILD_VERSION"),"owner":"core","daemon":service.runtime.daemon.load(Ordering::SeqCst),"build":crate::runtime::process_build_id()?}),
    )?;
    Ok(tokio::spawn(async move {
        let _listeners = Listeners(vec![listener]);
        supervise(service).await;
    }))
}

fn publish_core(service: &Service, info: &Value) -> Result<()> {
    service.port.store(
        info["port"].as_u64().ok_or("FRONT_DOOR_PORT_MISSING")? as u16,
        Ordering::SeqCst,
    );
    let mut native = load(&root().join("app/native.json"))?;
    native["port"] = info["port"].clone();
    native["token"] = info["token"].clone();
    save(&root().join("app/native.json"), &native)
}
async fn supervise(service: Arc<Service>) {
    let mut attached = None;
    let mut delay = Duration::from_millis(250);
    loop {
        let result = async {
            let info = match connect("front-door").await {
                Ok(_) => load(&info_path())?,
                Err(_) => {
                    // ensure holds the shared replacement lock for the entire launch.
                    ensure().await?
                }
            };
            let (_, hello) = connect("front-door").await?;
            if attached != Some(hello.generation) {
                publish_core(&service, &info)?;
                service.restore_remote().await?;
                attached = Some(hello.generation);
            }
            Ok::<(), String>(())
        }
        .await;
        match result {
            Ok(()) => {
                delay = Duration::from_millis(250);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(error) => {
                crate::logs::record(
                    "WARN",
                    &format!(
                        "Front door reattachment: {error}; retry in {} ms",
                        delay.as_millis()
                    ),
                    None,
                );
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(8));
            }
        }
    }
}

/// Kernel-owned replacement exclusion is released even if an installer exits.
fn replacement_lock() -> Result<File> {
    private_dir(&root())?;
    File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root().join("front-door-install.lock"))
        .map_err(|e| e.to_string())
}
pub(crate) fn startup_guard() -> Result<File> {
    let guard = replacement_lock()?;
    guard.try_lock_shared().map_err(|_| {
        "CORE_UNAVAILABLE: Installation holds the replacement path; retry after it finishes."
            .to_owned()
    })?;
    Ok(guard)
}

fn lock() -> Result<File> {
    private_dir(&root().join("app"))?;
    File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root().join("front-door.lock"))
        .map_err(|e| e.to_string())
}
/// Keep a compatible front door across build changes. Only the install path may stop an incompatible one.
#[cfg_attr(test, allow(dead_code))]
pub(crate) async fn ensure() -> Result<Value> {
    let _replacement = startup_guard()?;
    match connect("front-door").await {
        Ok(_) => return load(&info_path()),
        Err(error) if error.starts_with("FRONT_DOOR_PROTOCOL_MISMATCH") => return Err(error),
        _ => {}
    }
    let guard = lock()?;
    if guard.try_lock().is_err() {
        return Err("FRONT_DOOR_UNAVAILABLE: The front door still owns its lock. Inspect front-door.log; continuity is reduced until its endpoint recovers.".into());
    }
    let log = File::options()
        .create(true)
        .append(true)
        .open(root().join("front-door.log"))
        .map_err(|e| e.to_string())?;
    let source = crate::runtime::binary()?;
    let binary = stage_image(&source, &root().join("front-door-bin"))?;
    let mut command = std::process::Command::new(binary);
    command
        .arg("front-door")
        .env("ARC_STATE_DIR", root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    // Detached launch deliberately bypasses the Core-owned child registry.
    drop(guard);
    let mut child = crate::codex_host::detached_spawn(&mut command)?;
    crate::logs::record(
        "INFO",
        &format!("Front door launched: pid {}", child.id()),
        None,
    );
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if connect("front-door").await.is_ok() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return load(&info_path());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "FRONT_DOOR_START_FAILED: {status}; inspect front-door.log"
            ));
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err("FRONT_DOOR_START_TIMEOUT: Inspect front-door.log.".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
/// Called by installers before replacing files. Compatible running front doors are retained.
pub async fn prepare_install() -> Result<File> {
    let guard = replacement_lock()?;
    guard.try_lock().map_err(|_| {
        "CORE_UNAVAILABLE: Another installer or Core startup holds the replacement path.".to_owned()
    })?;
    if !crate::runtime::core_unlocked()? {
        return Err(
            "CORE_UNAVAILABLE: Stop Desktop and Core before preparing front-door replacement."
                .into(),
        );
    }
    match connect("front-door").await {
        Ok(_) => Ok(()),
        Err(error) if error.starts_with("FRONT_DOOR_PROTOCOL_MISMATCH") => stop().await,
        Err(error) => {
            if lock()?.try_lock().is_ok() {
                Ok(())
            } else {
                Err(error)
            }
        }
    }?;
    Ok(guard)
}
/// Updater bytes may contain a new protocol, so stop the front door after Core.
pub async fn prepare_update() -> Result<File> {
    let guard = prepare_install().await?;
    stop().await?;
    Ok(guard)
}
/// Keep the replacement guard until the independent installer's pipe closes.
pub async fn hold_install() -> Result<()> {
    let _guard = prepare_install().await?;
    use std::io::Write;
    println!("ready");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut byte = [0];
    tokio::io::stdin()
        .read(&mut byte)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) async fn stop() -> Result<()> {
    let guard = lock()?;
    if guard.try_lock().is_ok() {
        return Ok(());
    }
    let mut socket = raw_connect("front-door").await?;
    write(&mut socket, &Attach::Stop { token: secret()? }).await?;
    let _: Result<Value> = tokio::time::timeout(Duration::from_secs(3), read(&mut socket, 4096))
        .await
        .map_err(|_| "front-door shutdown acknowledgement timed out")??;
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if guard.try_lock().is_ok() {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(
                "FRONT_DOOR_STOP_TIMEOUT: Uninstall stopped; inspect front-door.log.".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
#[cfg(feature = "test-fixture")]
pub async fn stop_for_fixture() -> Result<()> {
    stop().await
}
pub async fn run() -> Result<()> {
    FRONT_DOOR.store(true, Ordering::SeqCst);
    init_crypto();
    private_dir(&root())?;
    let guard = lock()?;
    if guard.try_lock().is_err() {
        return Ok(());
    }
    crate::owned_children::recover_front_door().await?;
    let build = crate::runtime::process_build_id()?;
    prune_images(&root().join("front-door-bin"), build)?;
    let gateway = owner::Gateway::new()?;
    let stop = Arc::new(tokio::sync::Notify::new());
    let http = crate::transport::listen_gateway(gateway.clone()).await?;
    save(
        &info_path(),
        &json!({"pid":std::process::id(),"processStart":crate::codex_host::process_start(std::process::id()),"protocol":VERSION,"build":build,"port":gateway.port.load(Ordering::SeqCst),"token":gateway.token}),
    )?;
    let private = listen("front-door", Owner::Gateway(gateway.clone(), stop.clone())).await?;
    let listeners = Listeners(vec![private, http]);
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    tokio::select! {
        _=stop.notified()=>{},
        _=tokio::signal::ctrl_c()=>{},
        _=async { #[cfg(unix)] terminate.recv().await; #[cfg(not(unix))] std::future::pending::<()>().await; }=>{},
    }
    // Provider teardown must not wait for a missing Core through the business queue.
    queue().entries.close();
    queue().bytes.close();
    let result = gateway.stop().await;
    drop(listeners);
    let _ = std::fs::remove_file(info_path());
    drop(guard);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hello() -> Hello {
        Hello {
            version: VERSION,
            generation: Generation([7; 16]),
            readiness: Readiness::Ready,
            max_request_bytes: MAX_REQUEST_BYTES,
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }
    #[test]
    fn queued_admissions_retain_identity_and_release_both_bounds() {
        // Property: rejected admissions cannot evict accepted identities and release restores count and byte capacity.
        let queue = AdmissionQueue::new();
        let request = waiting_request(
            management_context(),
            Operation::LocalControl,
            json!({"op":"ax_report","requestId":"original-request","args":{}}),
        );
        let entries: Vec<_> = (0..MAX_QUEUED)
            .map(|_| queue.reserve(&request).unwrap())
            .collect();
        let error: Value = serde_json::from_str(&queue.reserve(&request).err().unwrap()).unwrap();
        assert_eq!(error["data"]["requestId"], "original-request");
        assert_eq!(error["data"]["next"]["op"], "guide");
        let spec = catalog()["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == "guide")
            .unwrap();
        crate::egress::validate_op(spec, &error["data"]["next"]["args"]).unwrap();
        drop(entries);
        let mut large = request.clone();
        large.body = json!("x".repeat(MAX_QUEUE_BYTES / 3));
        let first = queue.reserve(&large).unwrap();
        let second = queue.reserve(&large).unwrap();
        assert!(queue.reserve(&large).is_err());
        drop((first, second));
        assert!(queue.reserve(&large).is_ok());
    }
    #[tokio::test]
    async fn waiting_requests_expire_without_changing_identity_or_deadline() {
        // Regression: swap-time waiting restarted deadlines and lost the identity before Core attachment.
        let mut request = waiting_request(
            management_context(),
            Operation::LocalControl,
            json!({"op":"ax_report","requestId":"original-request","args":{}}),
        );
        request.deadline = Deadline::after(Duration::ZERO);
        let error: Value = serde_json::from_str(&ready(&mut request).await.err().unwrap()).unwrap();
        assert_eq!(error["data"]["requestId"], "original-request");
        assert_eq!(error["data"]["next"]["via"], "query");
        assert!(request.deadline.remaining().is_err());
    }
    #[cfg(unix)]
    struct ImageFixture {
        directory: PathBuf,
        installed: PathBuf,
        images: PathBuf,
    }
    #[cfg(unix)]
    impl ImageFixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("arc-image-{}", id()));
            std::fs::create_dir_all(&directory).unwrap();
            Self {
                installed: directory.join("installed"),
                images: directory.join("images"),
                directory,
            }
        }
        fn install(&self, build: &str) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&self.installed, format!("#!/bin/sh\necho '{build}'\n")).unwrap();
            std::fs::set_permissions(&self.installed, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        fn launch(binary: &Path) -> std::io::Result<String> {
            let output = std::process::Command::new(binary)
                .arg("--version")
                .output()?;
            assert!(output.status.success());
            Ok(String::from_utf8(output.stdout).unwrap().trim().to_owned())
        }
    }
    #[cfg(unix)]
    impl Drop for ImageFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    #[cfg(unix)]
    #[test]
    fn fresh_front_door_launch_uses_the_installed_build_with_the_same_protocol() {
        // Regression: 6dc72941 cached the first image for a protocol forever, so installing build B still launched build A.
        let fixture = ImageFixture::new();
        fixture.install("build-A");
        let first = stage_image(&fixture.installed, &fixture.images).unwrap();
        assert_eq!(ImageFixture::launch(&first).unwrap(), "build-A");
        fixture.install("build-B");
        let second = stage_image(&fixture.installed, &fixture.images).unwrap();
        prune_images(&fixture.images, &crate::runtime::build_id(&second).unwrap()).unwrap();
        assert_eq!(ImageFixture::launch(&second).unwrap(), "build-B");
        assert_eq!(
            ImageFixture::launch(&first).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
    }
    #[tokio::test]
    async fn sent_reads_fail_and_sent_writes_retain_the_original_receipt_action() {
        // Contract: losing the private connection fails a sent read and returns an uncertain write with its original receipt-read action.
        for write_call in [false, true] {
            let body = if write_call {
                json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"act","arguments":{"op":"codex_send","requestId":"original-request","args":{}}}})
            } else {
                json!({"method":"ping","id":1})
            };
            let request = request(&hello(), management_context(), Operation::Mcp, body);
            let (mut client, mut core) = tokio::io::duplex(8192);
            let peer = tokio::spawn(async move {
                let _: Message = read(&mut core, MAX_REQUEST_BYTES).await.unwrap();
            });
            let error = exchange(&mut client, &request).await.unwrap_err();
            peer.await.unwrap();
            if write_call {
                let value: Value = serde_json::from_str(&error).unwrap();
                assert_eq!(value["code"], -32603);
                assert_eq!(value["data"]["state"], "unconfirmed");
                assert_eq!(value["data"]["requestId"], "original-request");
                assert_eq!(
                    value["data"]["next"],
                    json!({"via":"act","op":"receipt","args":{"action":"read","requestId":"original-request"}})
                );
            } else {
                assert!(error.starts_with("FRONT_DOOR_CORE_LOST:"));
            }
        }
    }
    #[test]
    fn generated_write_identity_is_the_identity_sent_to_the_receipt_owner() {
        // Regression: a lost response could expose a transport ID different from the receipt ID generated inside Core.
        let request = request(
            &hello(),
            management_context(),
            Operation::Mcp,
            json!({"method":"tools/call","params":{"name":"act","arguments":{"op":"codex_send","args":{}}}}),
        );
        assert!(uuid::Uuid::parse_str(&request.id.0).is_ok());
        assert_eq!(
            request.body["params"]["arguments"]["requestId"],
            request.id.0
        );
        for operation in [Operation::Mcp, Operation::LocalControl] {
            for op in ["receipt", "logs", "codex_account"] {
                let envelope = json!({"op":op,"args":{"action":"read","requestId":"target"}});
                let body = if matches!(operation, Operation::Mcp) {
                    json!({"method":"tools/call","params":{"name":"act","arguments":envelope}})
                } else {
                    envelope
                };
                let read = super::request(&hello(), management_context(), operation.clone(), body);
                let sent = if matches!(operation, Operation::Mcp) {
                    &read.body["params"]["arguments"]
                } else {
                    &read.body
                };
                assert!(sent.get("requestId").is_none());
                if op == "receipt" {
                    assert!(!is_write(&read));
                }
            }
        }
    }
    #[tokio::test]
    async fn private_framing_refuses_an_oversized_length_before_reading_a_body() {
        // Contract: a private peer cannot allocate a frame beyond its negotiated encoded-byte limit.
        let (mut client, mut core) = tokio::io::duplex(32);
        core.write_u32(4097).await.unwrap();
        assert!(read::<_, Value>(&mut client, 4096)
            .await
            .unwrap_err()
            .starts_with("FRONT_DOOR_FRAME_TOO_LARGE:"));
    }
}
