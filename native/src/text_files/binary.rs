//! Receipt-owned binary transfers. Hashes cover the resulting file, including appended bytes.
use crate::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const MAX_CHUNK: usize = 8 * 1024 * 1024;
const MAX_FILE: u64 = 512 * 1024 * 1024;

pub async fn transfer(method: &str, args: &Value) -> Result<Value> {
    let requested = Path::new(string(args, "path"));
    if !requested.is_absolute() {
        return Err(
            "INVALID_PATH: fs requires an absolute host path; for UTF-8 text use write".into(),
        );
    }
    permissions::check_path(requested)?;
    let path = if requested.exists() {
        requested.canonicalize().map_err(|e| e.to_string())?
    } else {
        requested
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(|e| e.to_string())?
            .join(requested.file_name().ok_or("INVALID_PATH")?)
    };
    permissions::check_path(&path)?;
    if let Some(expected) = args.get("expectedSha256") {
        if !expected
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(
                "INVALID_SHA256: expectedSha256 must contain 64 hexadecimal characters".into(),
            );
        }
    }
    let locks = crate::kernel::receipts::RequestLocks;
    let _guard = locks.lock(&format!("file:{}", path.display())).await;
    if args.get("append").is_some_and(|value| !value.is_boolean()) {
        return Err("INVALID_ARGUMENT: append must be a boolean".into());
    }
    if args.get("offset").is_some() && args["append"] != true {
        return Err("INVALID_ARGUMENT: offset requires append:true".into());
    }
    if args
        .get("maxBytes")
        .is_some_and(|value| !value.as_u64().is_some_and(|n| (1..=MAX_FILE).contains(&n)))
    {
        return Err("INVALID_ARGUMENT: maxBytes must be an integer from 1 to 536870912".into());
    }
    let append = args["append"] == true;
    if append && method != "fs/writeFile" {
        return Err("INVALID_ARGUMENT: append is only supported by fs writeFile".into());
    }
    let before = std::fs::metadata(&path).ok();
    if append {
        let offset = args["offset"].as_u64().ok_or("OFFSET_REQUIRED: append requires the exact current byte length; read the previous receipt")?;
        let actual = before.as_ref().map(|m| m.len()).unwrap_or(0);
        if offset != actual {
            return Err(format!("OFFSET_MISMATCH: expected {offset} bytes, found {actual}; read the original receipt before retrying"));
        }
    }
    let temporary = path.with_file_name(format!(".arc-{}.tmp", id()));
    let result = async {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut put = |chunk: &[u8]| -> Result<()> {
            bytes += chunk.len() as u64;
            if bytes > MAX_FILE { return Err("FILE_TOO_LARGE: maximum resulting file size is 512 MiB".into()); }
            file.write_all(chunk).map_err(|e| e.to_string())?;
            digest.update(chunk);
            Ok(())
        };
        if append && before.is_some() {
            let mut old = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            loop {
                let n = old.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                put(&buffer[..n])?;
            }
        }
        if method == "fs/fetchFile" {
            let url = reqwest::Url::parse(string(args, "url")).map_err(|_| "INVALID_URL: use an HTTPS URL")?;
            if url.scheme() != "https" { return Err("INVALID_URL: use an HTTPS URL".into()); }
            let settings = crate::transport::forward_request("network", "GET", json!({})).await?;
            let proxy = crate::proxy::NetworkProxy::resolve(&settings).await?;
            let client = proxy.client(reqwest::Client::builder().https_only(true).timeout(std::time::Duration::from_secs(120))).build().map_err(|e| e.to_string())?;
            let mut response = client.get(url).send().await.map_err(|e| e.without_url().to_string())?.error_for_status().map_err(|e| e.without_url().to_string())?;
            let limit = args["maxBytes"].as_u64().unwrap_or(64 * 1024 * 1024).min(MAX_FILE);
            let mut downloaded = 0u64;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url().to_string())? {
                downloaded += chunk.len() as u64;
                if downloaded > limit { return Err("DOWNLOAD_TOO_LARGE: increase maxBytes (maximum 512 MiB)".into()); }
                put(&chunk)?;
            }
        } else {
            let encoded = args["dataBase64"].as_str().ok_or("DATA_REQUIRED: binary fs writeFile requires dataBase64; for UTF-8 text use write")?;
            if encoded.len() > MAX_CHUNK.div_ceil(3) * 4 { return Err("CHUNK_TOO_LARGE: send at most 8 MiB decoded bytes per write".into()); }
            let data = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| format!("INVALID_BASE64: {e}"))?;
            if data.len() > MAX_CHUNK { return Err("CHUNK_TOO_LARGE: send at most 8 MiB decoded bytes per write".into()); }
            put(&data)?;
        }
        drop(put);
        let sha256 = crate::hex_encode(&digest.finalize());
        if args["expectedSha256"].as_str().is_some_and(|expected| !sha256.eq_ignore_ascii_case(expected)) {
            return Err(format!("SHA256_MISMATCH: expected {}, computed {sha256}; destination unchanged", string(args, "expectedSha256")));
        }
        if let Some(meta) = &before { file.set_permissions(meta.permissions()).map_err(|e| e.to_string())?; }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let current = std::fs::metadata(&path).ok();
        if before.as_ref().map(|m| (m.len(), m.modified().ok())) != current.as_ref().map(|m| (m.len(), m.modified().ok())) {
            return Err("FILE_CHANGED_DURING_TRANSFER: destination unchanged by ARC; inspect it before retrying".into());
        }
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        Ok(json!({"path":path,"bytesWritten":bytes - if append { before.as_ref().map(|m| m.len()).unwrap_or(0) } else {0},"sizeBytes":bytes,"sha256":sha256,"append":append}))
    }.await;
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
