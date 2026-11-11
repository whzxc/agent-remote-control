//! Binary LAN streams and bounded JSON tunnel ranges. No control-source file bytes.
use super::*;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::{
    body::{Bytes, Frame, Incoming},
    Request, Response,
};
use receiver::{BLOCK, LAN_RANGE, TUNNEL_RANGE};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};
pub(crate) type Body = http_body_util::combinators::UnsyncBoxBody<Bytes, std::io::Error>;
pub(crate) fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|e| match e {})
        .boxed_unsync()
}
pub(crate) fn reply(result: Result<Value>) -> Response<Body> {
    let value = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => {
            json!({"ok":false,"error":failure(&error)})
        }
    };
    Response::new(full(value.to_string()))
}
fn stream_file(path: &Path, offset: u64, length: u64) -> Result<Body> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let stream =
        futures_util::stream::unfold(Some((file, length, Sha256::new())), |state| async move {
            let (mut file, left, mut sha) = state?;
            if left == 0 {
                let mut trailers = hyper::HeaderMap::new();
                trailers.insert(
                    "x-arc-sha256",
                    crate::hex_encode(&sha.finalize()).parse().unwrap(),
                );
                return Some((Ok::<_, std::io::Error>(Frame::trailers(trailers)), None));
            }
            let mut bytes = vec![0; left.min(BLOCK as u64) as usize];
            match file.read(&mut bytes) {
                Ok(0) => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Source changed during transfer",
                    )),
                    None,
                )),
                Ok(n) => {
                    bytes.truncate(n);
                    sha.update(&bytes);
                    Some((
                        Ok(Frame::data(Bytes::from(bytes))),
                        Some((file, left - n as u64, sha)),
                    ))
                }
                Err(e) => Some((Err(e), None)),
            }
        });
    Ok(StreamBody::new(stream).boxed_unsync())
}
async fn json_response(response: Response<Incoming>) -> Result<Value> {
    let bytes = Limited::new(response.into_body(), 1024 * 1024)
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["ok"] != true {
        return Err(value["error"].to_string());
    }
    Ok(value["result"].clone())
}
pub(in crate::device_link) enum Link {
    Lan(Arc<super::super::client::Channel>),
    Tunnel {
        url: String,
        token: String,
        closed: tokio::sync::watch::Receiver<u64>,
    },
}
impl Link {
    pub fn range(&self) -> u64 {
        match self {
            Self::Lan(_) => LAN_RANGE,
            Self::Tunnel { .. } => TUNNEL_RANGE,
        }
    }
    pub async fn control(&self, mut body: Value) -> Result<Value> {
        body["version"] = json!(VERSION);
        match self {
            Self::Lan(channel) => {
                channel
                    .request(
                        "/arc-peer/3/transfer/control",
                        body,
                        Duration::from_secs(25),
                    )
                    .await
            }
            Self::Tunnel { url, token, closed } => {
                let mut closed = closed.clone();
                tokio::select! { biased; _=closed.changed()=>Err("DEVICE_UNPAIRED: transfer connection closed".into()), result=super::super::tunnel::post(url,"transfer/control",Some(token),body,Duration::from_secs(25))=>result }
            }
        }
    }
    pub async fn upload(
        &self,
        request: &str,
        path: &Path,
        offset: u64,
        length: u64,
    ) -> Result<Value> {
        match self {
            Self::Lan(channel) => {
                let request = Request::builder()
                    .method("POST")
                    .uri("https://arc-peer.local/arc-peer/3/transfer/upload")
                    .header("x-arc-request", request)
                    .header("x-arc-offset", offset)
                    .header("x-arc-length", length)
                    .body(stream_file(path, offset, length)?)
                    .map_err(|e| e.to_string())?;
                json_response(
                    channel
                        .ready()
                        .await?
                        .send_request(request)
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .await
            }
            Self::Tunnel { .. } => {
                let bytes = read_range(path, offset, length, TUNNEL_RANGE)?;
                self.control(json!({"action":"put","requestId":request,"offset":offset,"sha256":receiver::digest(&bytes),"data":base64::engine::general_purpose::STANDARD.encode(&bytes)})).await
            }
        }
    }
    pub(super) async fn download(
        &self,
        request: &str,
        path: &str,
        stamp: &Value,
        receiver: &mut receiver::Receiver,
        length: u64,
    ) -> Result<()> {
        let offset = receiver.offset();
        match self {
            Self::Lan(channel) => {
                let body = json!({"version":VERSION,"path":path,"offset":offset,"length":length,"fingerprint":stamp});
                let request = Request::builder()
                    .method("POST")
                    .uri("https://arc-peer.local/arc-peer/3/transfer/download")
                    .body(full(body.to_string()))
                    .map_err(|e| e.to_string())?;
                let response = channel
                    .ready()
                    .await?
                    .send_request(request)
                    .await
                    .map_err(|e| e.to_string())?;
                if response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    != Some("application/octet-stream")
                {
                    return json_response(response).await.map(|_| ());
                }
                receive(receiver, response.into_body(), offset, length).await
            }
            Self::Tunnel { .. } => {
                let result = self.control(json!({"action":"get","requestId":request,"path":path,"fingerprint":stamp,"offset":offset,"length":length})).await?;
                let data = base64::engine::general_purpose::STANDARD
                    .decode(string(&result, "data"))
                    .map_err(|e| e.to_string())?;
                let range = receiver::Range::new(receiver);
                range
                    .receiver
                    .put(offset, &data, string(&result, "sha256"))?;
                range.finish()
            }
        }
    }
}
fn read_range(path: &Path, offset: u64, length: u64, cap: u64) -> Result<Vec<u8>> {
    if length > cap {
        return Err("DEVICE_TUNNEL_LIMIT: range exceeds the transport cap".into());
    }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
async fn receive(
    receiver: &mut receiver::Receiver,
    mut body: Incoming,
    offset: u64,
    length: u64,
) -> Result<()> {
    let range = receiver::Range::new(receiver);
    let receiver = &mut *range.receiver;
    async {
        let mut sha = Sha256::new();
        let mut got = 0u64;
        let mut expected = None;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| e.to_string())?;
            match frame.into_data() {
                Ok(bytes) => {
                    got += bytes.len() as u64;
                    if got > length {
                        return Err("OFFSET_MISMATCH: oversized range".into());
                    }
                    sha.update(&bytes);
                    receiver.append(&bytes)?;
                }
                Err(frame) => {
                    if let Ok(trailers) = frame.into_trailers() {
                        expected = trailers
                            .get("x-arc-sha256")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                    }
                }
            }
        }
        if got != length || receiver.offset() != offset + length {
            return Err("OFFSET_MISMATCH: incomplete range".into());
        }
        if expected.as_deref() != Some(&crate::hex_encode(&sha.finalize())) {
            return Err("SHA256_MISMATCH: range trailer differs".into());
        }
        Ok::<(), String>(())
    }
    .await?;
    range.finish()
}
impl Manager {
    pub(super) async fn transfer_authorize(&self, id: &str) -> Result<()> {
        self.controller(id)?;
        // Core rechecks the live peer source and its ordinary host-op policy.
        let result=self.business_request(id,json!({"version":VERSION,"tool":"query","body":{"op":"guide","args":{"op":"fs"}},"origin":{}})).await?;
        if result["isError"] == true {
            return Err("DEVICE_PEER_FORBIDDEN: peer source has no host file authority".into());
        }
        Ok(())
    }
    pub(crate) async fn transfer_control(&self, id: &str, body: Value) -> Result<Value> {
        self.transfer_authorize(id).await?;
        self.transfer_control_authorized(id, body).await
    }
    async fn transfer_control_authorized(&self, id: &str, body: Value) -> Result<Value> {
        let action = string(&body, "action");
        if matches!(action, "stat" | "get") {
            let path = receiver::resolve(string(&body, "path"))?;
            let stamp = receiver::fingerprint(&path)?;
            if action == "stat" {
                return Ok(stamp);
            }
            if stamp != body["fingerprint"] {
                return Err("SOURCE_CHANGED: restart with a new requestId".into());
            }
            let bytes = read_range(
                &path,
                body["offset"].as_u64().ok_or("INVALID_ARGUMENT")?,
                body["length"].as_u64().ok_or("INVALID_ARGUMENT")?,
                TUNNEL_RANGE,
            )?;
            return Ok(
                json!({"data":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":receiver::digest(&bytes)}),
            );
        }
        let request = string(&body, "requestId");
        let directory = self.directory.join("transfer-receivers");
        let mut spec = body["spec"].clone();
        if action == "begin" {
            spec["peer"] = json!(id);
            return self.transfers.begin(&directory, request, spec).await;
        }
        if action == "cancel" {
            return self.transfers.cancel(&directory, request, id).await;
        }
        let entry = self.transfers.get(&directory, request).await?;
        let mut receiver = entry.lock().await;
        if receiver.meta["spec"]["peer"] != id {
            return Err("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer".into());
        }
        let path = receiver.meta["path"].as_str().unwrap().to_owned();
        crate::permissions::check_path(Path::new(&path))?;
        match action {
            "status" => Ok(receiver.meta.clone()),
            "commit" => receiver.commit(),
            "cancel" => receiver.cancel(),
            "put" => {
                let data = base64::engine::general_purpose::STANDARD
                    .decode(string(&body, "data"))
                    .map_err(|e| e.to_string())?;
                if data.len() > TUNNEL_RANGE as usize {
                    return Err("DEVICE_TUNNEL_LIMIT: upload range exceeds 512 KiB".into());
                }
                let range = receiver::Range::new(&mut receiver);
                range.receiver.put(
                    body["offset"].as_u64().ok_or("INVALID_ARGUMENT")?,
                    &data,
                    string(&body, "sha256"),
                )?;
                range.finish()?;
                Ok(receiver.meta.clone())
            }
            _ => Err(
                "INVALID_ARGUMENT: use transfer begin, status, put, get, stat, commit or cancel"
                    .into(),
            ),
        }
    }
    pub(crate) async fn transfer_http(
        &self,
        id: &str,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let result = self.transfer_http_inner(id, request).await;
        match result {
            Ok(response) => response,
            Err(error) => reply(Err(error)),
        }
    }
    async fn transfer_http_inner(
        &self,
        id: &str,
        request: Request<Incoming>,
    ) -> Result<Response<Body>> {
        self.transfer_authorize(id).await?;
        if request.method() != hyper::Method::POST {
            return Err("DEVICE_PEER_FORBIDDEN: use POST transfer routes".into());
        }
        match request.uri().path() {
            "/arc-peer/3/transfer/control" | "/arc-peer/3/transfer/download" => {
                let download = request.uri().path().ends_with("/download");
                let bytes = Limited::new(request.into_body(), 16384)
                    .collect()
                    .await
                    .map_err(|e| e.to_string())?
                    .to_bytes();
                let body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                if body["version"] != VERSION {
                    return Err("DEVICE_PROTOCOL_MISMATCH: use peer protocol 3".into());
                }
                if !download {
                    return Ok(reply(self.transfer_control_authorized(id, body).await));
                }
                let path = receiver::resolve(string(&body, "path"))?;
                if receiver::fingerprint(&path)? != body["fingerprint"] {
                    return Err("SOURCE_CHANGED: restart with a new requestId".into());
                }
                let offset = body["offset"].as_u64().ok_or("INVALID_ARGUMENT")?;
                let length = body["length"]
                    .as_u64()
                    .filter(|n| *n <= LAN_RANGE)
                    .ok_or("INVALID_ARGUMENT")?;
                Ok(Response::builder()
                    .header("content-type", "application/octet-stream")
                    .body(stream_file(&path, offset, length)?)
                    .unwrap())
            }
            "/arc-peer/3/transfer/upload" => {
                let header = |name: &str| {
                    request
                        .headers()
                        .get(name)
                        .and_then(|v| v.to_str().ok())
                        .ok_or("INVALID_ARGUMENT: missing transfer header")
                };
                let id_request = header("x-arc-request")?.to_owned();
                let offset = header("x-arc-offset")?
                    .parse::<u64>()
                    .map_err(|e| e.to_string())?;
                let length = header("x-arc-length")?
                    .parse::<u64>()
                    .map_err(|e| e.to_string())?;
                if length > LAN_RANGE {
                    return Err("INVALID_ARGUMENT: LAN ranges must fit 16 MiB".into());
                }
                let entry = self
                    .transfers
                    .get(&self.directory.join("transfer-receivers"), &id_request)
                    .await?;
                let mut receiver = entry.lock().await;
                if receiver.meta["spec"]["peer"] != id {
                    return Err("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer".into());
                }
                if receiver.offset() != offset {
                    return Err("OFFSET_MISMATCH: read verified receiver offset".into());
                }
                let path = receiver.meta["path"].as_str().unwrap().to_owned();
                crate::permissions::check_path(Path::new(&path))?;
                receive(&mut receiver, request.into_body(), offset, length).await?;
                Ok(reply(Ok(receiver.meta.clone())))
            }
            _ => Err("DEVICE_PEER_FORBIDDEN: unknown transfer route".into()),
        }
    }
}
