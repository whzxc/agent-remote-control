//! Durable verified offsets and atomic publication, shared by both receivers.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};

pub(super) const BLOCK: usize = 256 * 1024;
pub(super) const LAN_RANGE: u64 = 16 * 1024 * 1024;
// Small scheduled ranges bound both upload and download credit round trips.
pub(super) const TUNNEL_RANGE: u64 = 64 * 1024;
// Retain the peer wire limit for controllers running earlier versions.
pub(super) const TUNNEL_CAP: u64 = 512 * 1024;

pub(super) fn resolve(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("INVALID_PATH: use an absolute host path".into());
    }
    crate::permissions::check_path(path)?;
    let resolved = if path.exists() {
        path.canonicalize()
    } else {
        path.parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map(|p| p.join(path.file_name().unwrap()))
    }
    .map_err(|e| e.to_string())?;
    crate::permissions::check_path(&resolved)?;
    Ok(resolved)
}
pub(super) fn digest(bytes: &[u8]) -> String {
    crate::hex_encode(&Sha256::digest(bytes))
}
pub(super) fn fingerprint(path: &Path) -> Result<Value> {
    let m = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() {
        return Err("INVALID_PATH: source must be a regular file".into());
    }
    Ok(
        json!({"total":m.len(),"modified":m.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_nanos().to_string())}),
    )
}
pub(super) fn free_space(path: &Path, needed: u64) -> Result<()> {
    #[cfg(unix)]
    let available = {
        use std::os::unix::ffi::OsStrExt;
        let path =
            std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let stats = unsafe { stats.assume_init() };
        (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
    };
    #[cfg(windows)]
    let available = {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDiskFreeSpaceExW(
                path: *const u16,
                available: *mut u64,
                total: *mut u64,
                free: *mut u64,
            ) -> i32;
        }
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        available
    };
    if available < needed {
        return Err(
            "INSUFFICIENT_DISK_SPACE: free space is smaller than the remaining transfer".into(),
        );
    }
    Ok(())
}
#[derive(Default)]
pub(crate) struct Store {
    entries: Mutex<BTreeMap<String, Arc<Mutex<Receiver>>>>,
}
pub(super) struct Receiver {
    pub meta: Value,
    pub file: Option<std::fs::File>,
    sha: Sha256,
    manifest: PathBuf,
    destination_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}
impl Store {
    pub(super) async fn get(
        &self,
        directory: &Path,
        request: &str,
    ) -> Result<Arc<Mutex<Receiver>>> {
        uuid::Uuid::parse_str(request).map_err(|_| "INVALID_REQUEST_ID")?;
        let _load = crate::kernel::receipts::RequestLocks
            .lock(&format!("transfer-load:{request}"))
            .await;
        if let Some(entry) = self.entries.lock().await.get(request).cloned() {
            return Ok(entry);
        }
        let manifest = directory.join(format!("{request}.json"));
        let meta = load(&manifest)?;
        let mut receiver = Receiver {
            meta,
            file: None,
            sha: Sha256::new(),
            manifest,
            destination_guard: None,
        };
        if receiver.meta["state"] == "receiving" {
            let path = string(&receiver.meta, "path");
            crate::permissions::check_path(Path::new(path))?;
            receiver.destination_guard = Some(
                crate::kernel::receipts::RequestLocks
                    .lock(&format!("file:{path}"))
                    .await,
            );
            let offset = receiver.offset();
            let temporary = Path::new(string(&receiver.meta, "temporary"));
            let published = !temporary.exists() && receiver.meta["spec"]["total"] == offset;
            let mut file = std::fs::OpenOptions::new()
                .read(true)
                .write(!published)
                .open(if published {
                    Path::new(string(&receiver.meta, "path"))
                } else {
                    temporary
                })
                .map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() < offset {
                return Err(
                    "TRANSFER_CORRUPT: temporary file is shorter than verified offset".into(),
                );
            }
            if published {
                if file.metadata().map_err(|e| e.to_string())?.len() != offset {
                    return Err("TRANSFER_CORRUPT: published destination length changed".into());
                }
            } else {
                file.set_len(offset).map_err(|e| e.to_string())?;
            }
            let mut buffer = vec![0; BLOCK];
            let mut left = offset;
            while left > 0 {
                let n = file
                    .read(&mut buffer[..left.min(BLOCK as u64) as usize])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("TRANSFER_CORRUPT: incomplete verified prefix".into());
                }
                receiver.sha.update(&buffer[..n]);
                left -= n as u64;
            }
            if crate::hex_encode(&receiver.sha.clone().finalize())
                != string(&receiver.meta, "sha256")
            {
                return Err("SHA256_MISMATCH: verified temporary prefix changed".into());
            }
            if published {
                receiver.meta["state"] = json!("completed");
                receiver.checkpoint()?;
                receiver.destination_guard.take();
            } else {
                receiver.file = Some(file);
            }
        }
        let receiver = Arc::new(Mutex::new(receiver));
        self.entries
            .lock()
            .await
            .insert(request.into(), receiver.clone());
        Ok(receiver)
    }
    pub(super) async fn cancel(
        &self,
        directory: &Path,
        request: &str,
        peer: &str,
    ) -> Result<Value> {
        uuid::Uuid::parse_str(request).map_err(|_| "INVALID_REQUEST_ID")?;
        let admission = crate::kernel::receipts::RequestLocks
            .lock(&format!("transfer-admit:{request}"))
            .await;
        let manifest = directory.join(format!("{request}.json"));
        if !manifest.exists() {
            let mut receiver = Receiver {
                meta: json!({"spec":{"peer":peer},"state":"cancelled","offset":0}),
                file: None,
                sha: Sha256::new(),
                manifest,
                destination_guard: None,
            };
            receiver.checkpoint()?;
            return Ok(receiver.meta);
        }
        drop(admission);
        let entry = self.get(directory, request).await?;
        let mut receiver = entry.lock().await;
        if receiver.meta["spec"]["peer"] != peer {
            return Err("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer".into());
        }
        receiver.cancel()
    }
    pub(super) async fn begin(
        &self,
        directory: &Path,
        request: &str,
        spec: Value,
    ) -> Result<Value> {
        uuid::Uuid::parse_str(request).map_err(|_| "INVALID_REQUEST_ID")?;
        let _id = crate::kernel::receipts::RequestLocks
            .lock(&format!("transfer:{request}"))
            .await;
        let manifest = directory.join(format!("{request}.json"));
        if manifest.exists() {
            let entry = self.get(directory, request).await?;
            let receiver = entry.lock().await;
            if receiver.meta["state"] == "cancelled"
                && receiver.meta["spec"]["peer"] == spec["peer"]
            {
                return Ok(receiver.meta.clone());
            }
            if receiver.meta["spec"] != spec {
                return Err("REQUEST_ID_CONFLICT: transfer parameters differ".into());
            }
            if receiver.meta["state"] == "receiving" {
                free_space(
                    Path::new(string(&receiver.meta, "path")).parent().unwrap(),
                    receiver.meta["spec"]["total"].as_u64().unwrap() - receiver.offset(),
                )?;
            }
            return Ok(receiver.meta.clone());
        }
        let path = resolve(string(&spec, "path"))?;
        let path_guard = crate::kernel::receipts::RequestLocks
            .lock(&format!("file:{}", path.display()))
            .await;
        let _admission = crate::kernel::receipts::RequestLocks
            .lock(&format!("transfer-admit:{request}"))
            .await;
        if manifest.exists() {
            let meta = load(&manifest)?;
            if meta["state"] == "cancelled" && meta["spec"]["peer"] == spec["peer"] {
                return Ok(meta);
            }
            return Err("REQUEST_ID_CONFLICT: receiver was already admitted".into());
        }
        if path.exists() && spec["overwrite"] != true {
            return Err("DESTINATION_EXISTS: set overwrite:true to replace the destination".into());
        }
        let total = spec["total"]
            .as_u64()
            .ok_or("INVALID_ARGUMENT: total is required")?;
        free_space(path.parent().unwrap(), total)?;
        let temporary = path.with_file_name(format!(".arc-transfer-{request}.part"));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut receiver = Receiver {
            meta: json!({"spec":spec,"path":path,"temporary":temporary,"offset":0,"sha256":digest(&[]),"state":"receiving"}),
            file: Some(file),
            sha: Sha256::new(),
            manifest,
            destination_guard: Some(path_guard),
        };
        if let Err(e) = receiver.checkpoint() {
            let _ = std::fs::remove_file(&temporary);
            return Err(e);
        }
        let meta = receiver.meta.clone();
        self.entries
            .lock()
            .await
            .insert(request.into(), Arc::new(Mutex::new(receiver)));
        Ok(meta)
    }
}
impl Receiver {
    pub fn snapshot(&self) -> (Value, Sha256) {
        (self.meta.clone(), self.sha.clone())
    }
    pub fn restore(&mut self, snapshot: (Value, Sha256)) -> Result<()> {
        self.meta = snapshot.0;
        self.sha = snapshot.1;
        let offset = self.offset();
        self.file
            .as_mut()
            .ok_or("TRANSFER_TERMINAL")?
            .set_len(offset)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn append(&mut self, bytes: &[u8]) -> Result<()> {
        if self.meta["state"] != "receiving" {
            return Err("TRANSFER_TERMINAL".into());
        }
        let offset = self.offset();
        if offset + bytes.len() as u64 > self.meta["spec"]["total"].as_u64().unwrap() {
            return Err("OFFSET_MISMATCH".into());
        }
        let file = self.file.as_mut().ok_or("TRANSFER_TERMINAL")?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        self.sha.update(bytes);
        self.meta["offset"] = json!(offset + bytes.len() as u64);
        Ok(())
    }
    pub fn offset(&self) -> u64 {
        self.meta["offset"].as_u64().unwrap_or(0)
    }
    pub fn checkpoint(&mut self) -> Result<()> {
        save(&self.manifest, &self.meta)?;
        std::fs::File::open(&self.manifest)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        sync_parent(&self.manifest)
    }
    pub fn put(&mut self, offset: u64, bytes: &[u8], expected: &str) -> Result<()> {
        if self.meta["state"] != "receiving" {
            return Err("TRANSFER_TERMINAL: receiver is no longer writable".into());
        }
        if offset != self.offset() {
            return Err("OFFSET_MISMATCH: read the receiver verified offset before resume".into());
        }
        if digest(bytes) != expected {
            return Err("SHA256_MISMATCH: range digest differs".into());
        }
        let total = self.meta["spec"]["total"].as_u64().unwrap();
        if offset + bytes.len() as u64 > total {
            return Err("OFFSET_MISMATCH: range exceeds source length".into());
        }
        let file = self.file.as_mut().ok_or("TRANSFER_TERMINAL")?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        self.sha.update(bytes);
        self.meta["offset"] = json!(offset + bytes.len() as u64);
        Ok(())
    }
    pub fn verify_range(&mut self) -> Result<()> {
        self.file
            .as_ref()
            .ok_or("TRANSFER_TERMINAL")?
            .sync_data()
            .map_err(|e| e.to_string())?;
        self.meta["sha256"] = json!(crate::hex_encode(&self.sha.clone().finalize()));
        self.checkpoint()
    }
    pub fn commit(&mut self) -> Result<Value> {
        if self.meta["state"] == "completed" {
            return Ok(self.meta.clone());
        }
        if self.meta["state"] != "receiving" || self.meta["spec"]["total"] != self.offset() {
            return Err("OFFSET_MISMATCH: receive all verified bytes before commit".into());
        }
        let sha = crate::hex_encode(&self.sha.clone().finalize());
        if self.meta["spec"]["expectedSha256"]
            .as_str()
            .is_some_and(|s| !s.eq_ignore_ascii_case(&sha))
        {
            return Err("SHA256_MISMATCH: destination unchanged".into());
        }
        self.file
            .as_ref()
            .ok_or("TRANSFER_TERMINAL")?
            .sync_all()
            .map_err(|e| e.to_string())?;
        let temporary = Path::new(string(&self.meta, "temporary"));
        let path = Path::new(string(&self.meta, "path"));
        // The no-replace rename also refuses a destination created since admission.
        if self.meta["spec"]["overwrite"] == true {
            std::fs::rename(temporary, path).map_err(|e| e.to_string())?;
        } else {
            rename_new(temporary, path)?;
        }
        sync_parent(path)?;
        self.file.take();
        self.meta["state"] = json!("completed");
        self.meta["sha256"] = json!(sha);
        self.checkpoint()?;
        self.destination_guard.take();
        Ok(self.meta.clone())
    }
    pub fn cancel(&mut self) -> Result<Value> {
        if self.meta["state"] == "completed" {
            return Ok(self.meta.clone());
        }
        self.file.take();
        match std::fs::remove_file(string(&self.meta, "temporary")) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        self.meta["state"] = json!("cancelled");
        self.checkpoint()?;
        self.destination_guard.take();
        Ok(self.meta.clone())
    }
}

/// Restores the last verified prefix even when the request future is dropped.
pub(super) struct Range<'a> {
    pub receiver: &'a mut Receiver,
    before: Option<(Value, Sha256)>,
}
impl<'a> Range<'a> {
    pub fn new(receiver: &'a mut Receiver) -> Self {
        let before = Some(receiver.snapshot());
        Self { receiver, before }
    }
    pub fn finish(mut self) -> Result<()> {
        self.receiver.verify_range()?;
        self.before.take();
        Ok(())
    }
}
impl Drop for Range<'_> {
    fn drop(&mut self) {
        if let Some(before) = self.before.take() {
            if let Err(error) = self.receiver.restore(before) {
                crate::logs::record("ERROR", &error, None);
            }
        }
    }
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("INVALID_PATH")?)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn rename_new(from: &Path, to: &Path) -> Result<()> {
    #[cfg(unix)]
    let result = {
        use std::os::unix::ffi::OsStrExt;
        let from =
            std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        result == 0
    };
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) != 0 }
    };
    if !result {
        let e = std::io::Error::last_os_error();
        return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("DESTINATION_EXISTS: {e}")
        } else {
            e.to_string()
        });
    }
    Ok(())
}
