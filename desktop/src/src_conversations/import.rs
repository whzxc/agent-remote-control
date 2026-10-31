use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use rusqlite::Connection;
use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::mpsc, time::Duration};
use tauri::webview::cookie::{time::OffsetDateTime, Cookie, SameSite};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, &'static str>;

// Intentionally no Debug implementation: this type contains secrets.
pub struct Row {
    host: String,
    name: String,
    path: String,
    value: Zeroizing<Vec<u8>>,
    encrypted: Zeroizing<Vec<u8>>,
    expires: i64,
    persistent: bool,
    secure: bool,
    http_only: bool,
    same_site: i64,
    partitioned: bool,
}

pub struct Imported {
    pub cookies: Vec<(String, Cookie<'static>)>,
}

impl Imported {
    /// Read only the selected organization UUID; never serialize cookie material.
    pub fn last_active_org(&self) -> Option<uuid::Uuid> {
        let mut org = None;
        for (host, cookie) in &self.cookies {
            if cookie.name() != "lastActiveOrg"
                || !matches!(host.as_str(), "claude.ai" | ".claude.ai")
            {
                continue;
            }
            let candidate = uuid::Uuid::parse_str(cookie.value()).ok()?;
            if org.is_some_and(|org| org != candidate) {
                return None;
            }
            org = Some(candidate);
        }
        org
    }
}

fn stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    fs::metadata(path)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)))
}

fn snapshot(source: &Path) -> Result<(i64, Vec<Row>)> {
    if !source.is_file() {
        return Err("chrome-default-cookies-missing");
    }
    let paths: Vec<_> = ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| source.with_file_name(format!("Cookies{suffix}")))
        .collect();
    // A private 0700 directory; copy original Chrome files, never decrypted data.
    let temp = tempfile::Builder::new()
        .prefix("arc-cookie-copy-")
        .tempdir()
        .map_err(|_| "snapshot-temp-failed")?;
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))
        .map_err(|_| "snapshot-permissions-failed")?;
    let before: Vec<_> = paths.iter().map(|p| stamp(p)).collect();
    for (path, state) in paths.iter().zip(&before) {
        if state.is_some() {
            let dest = temp
                .path()
                .join(path.file_name().ok_or("snapshot-name-failed")?);
            fs::copy(path, &dest).map_err(|_| "snapshot-copy-failed")?;
            fs::set_permissions(dest, fs::Permissions::from_mode(0o600))
                .map_err(|_| "snapshot-permissions-failed")?;
        }
    }
    if before != paths.iter().map(|p| stamp(p)).collect::<Vec<_>>() {
        return Err("chrome-db-changed-during-copy-retry-manually");
    }
    let result = (|| {
        let db =
            Connection::open(temp.path().join("Cookies")).map_err(|_| "snapshot-open-failed")?;
        let integrity: String = db
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| "snapshot-check-failed")?;
        if integrity != "ok" {
            return Err("snapshot-integrity-failed");
        }
        let version: i64 = db
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='version'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "snapshot-version-failed")?;
        let mut stmt = db.prepare("SELECT host_key,name,path,value,encrypted_value,expires_utc,is_persistent,is_secure,is_httponly,samesite,top_frame_site_key FROM cookies WHERE host_key IN ('claude.ai','.claude.ai','.anthropic.com')")
            .map_err(|_| "unsupported-cookie-schema")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Row {
                    host: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    value: Zeroizing::new(r.get::<_, String>(3)?.into_bytes()),
                    encrypted: Zeroizing::new(r.get(4)?),
                    expires: r.get(5)?,
                    persistent: r.get(6)?,
                    secure: r.get(7)?,
                    http_only: r.get(8)?,
                    same_site: r.get(9)?,
                    partitioned: !r.get::<_, String>(10)?.is_empty(),
                })
            })
            .map_err(|_| "snapshot-query-failed")?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "snapshot-row-failed")?;
        Ok((version, rows))
    })();
    temp.close().map_err(|_| "snapshot-cleanup-failed")?;
    result
}

fn password() -> Result<Zeroizing<Vec<u8>>> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WAITING: AtomicBool = AtomicBool::new(false);
    if WAITING.swap(true, Ordering::SeqCst) {
        return Err("keychain-request-still-pending");
    }

    wait_for_password(
        move || {
            let result = ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .service("Chrome Safe Storage")
                .load_data(true)
                .limit(1)
                .search()
                .map_err(|_| "keychain-denied-or-unavailable")
                .and_then(|items| {
                    items
                        .into_iter()
                        .find_map(|item| match item {
                            SearchResult::Data(bytes) => Some(Zeroizing::new(bytes)),
                            _ => None,
                        })
                        .ok_or("keychain-no-password")
                });
            WAITING.store(false, Ordering::SeqCst);
            result
        },
        Duration::from_secs(arc_core::src_conversations::import_state::KEYCHAIN_WAIT_SECONDS),
    )
}

pub fn wait_for_password(
    fetch: impl FnOnce() -> Result<Zeroizing<Vec<u8>>> + Send + 'static,
    timeout: Duration,
) -> Result<Zeroizing<Vec<u8>>> {
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(fetch());
    });
    rx.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => "keychain-timeout",
        mpsc::RecvTimeoutError::Disconnected => "keychain-unavailable",
    })?
}

fn decrypt<'a>(
    encrypted: &'a mut [u8],
    key: &[u8; 16],
    host: &str,
    version: i64,
) -> Result<&'a [u8]> {
    if !encrypted.starts_with(b"v10") {
        return Err("unsupported-cookie-encryption");
    }
    let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), (&[b' '; 16]).into())
        .decrypt_padded::<Pkcs7>(&mut encrypted[3..])
        .map_err(|_| "cookie-decrypt-failed")?;
    if version >= 24 {
        if plain.len() < 32 || plain[..32] != Sha256::digest(host.as_bytes())[..] {
            return Err("cookie-host-digest-mismatch");
        }
        Ok(&plain[32..])
    } else {
        Ok(plain)
    }
}

pub fn chrome(profile: &str) -> Result<Imported> {
    let root = chrome_root()?;
    let listed = profiles()?;
    if !listed.iter().any(|p| p["directory"] == profile) {
        return Err("chrome-profile-not-found");
    }
    let source = root.join(profile).join("Cookies");
    let canonical = source
        .canonicalize()
        .map_err(|_| "chrome-cookies-missing")?;
    let root = root.canonicalize().map_err(|_| "chrome-root-missing")?;
    if !canonical.starts_with(root) {
        return Err("chrome-profile-outside-root");
    }
    let (version, rows) = snapshot(&source)?;
    let password = password()?;
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&password, b"saltysalt", 1003, &mut *key);
    drop(password);
    decode_rows(
        version,
        rows,
        &key,
        OffsetDateTime::now_utc().unix_timestamp(),
    )
}
pub fn decode_rows(version: i64, rows: Vec<Row>, key: &[u8; 16], now: i64) -> Result<Imported> {
    let mut cookies = Vec::new();
    for mut row in rows {
        let expires = row.expires / 1_000_000 - 11_644_473_600;
        let reason = if cloudflare(&row.name) {
            Some("cloudflare-client-bound")
        } else if row.partitioned {
            Some("partitioned-cookie-unsupported")
        } else if row.persistent && expires <= now {
            Some("expired")
        } else {
            None
        };
        if reason.is_some() {
            continue;
        }
        let bytes = if row.encrypted.is_empty() {
            &*row.value
        } else {
            decrypt(&mut row.encrypted, key, &row.host, version)?
        };
        let value = std::str::from_utf8(bytes).map_err(|_| "cookie-value-not-utf8")?;
        let mut cookie = Cookie::build((row.name.clone(), value.to_owned()))
            .path(row.path)
            .secure(row.secure)
            .http_only(row.http_only)
            .build();
        cookie.set_domain(row.host.clone());
        match row.same_site {
            -1 => {}
            0 => cookie.set_same_site(SameSite::None),
            1 => cookie.set_same_site(SameSite::Lax),
            2 => cookie.set_same_site(SameSite::Strict),
            _ => return Err("unsupported-samesite"),
        }
        if row.persistent {
            cookie.set_expires(
                OffsetDateTime::from_unix_timestamp(expires)
                    .map_err(|_| "invalid-cookie-expiry")?,
            );
        }
        cookies.push((row.host, cookie));
    }
    Ok(Imported { cookies })
}

fn cloudflare(name: &str) -> bool {
    name == "cf_clearance"
        || name.starts_with("__cf")
        || name.starts_with("_cf")
        || name.starts_with("cf_")
}

fn chrome_root() -> Result<std::path::PathBuf> {
    Ok(dirs::home_dir()
        .ok_or("home-missing")?
        .join("Library/Application Support/Google/Chrome"))
}
pub fn profiles() -> Result<Vec<serde_json::Value>> {
    let bytes = fs::read(chrome_root()?.join("Local State"))
        .map_err(|_| "chrome-local-state-unavailable")?;
    let state: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "chrome-local-state-invalid")?;
    let cache = state["profile"]["info_cache"]
        .as_object()
        .ok_or("chrome-profiles-unavailable")?;
    Ok(cache.iter().filter(|(dir,_)| {
        !dir.is_empty() && dir.as_str()!="." && dir.as_str()!=".." && !dir.contains(['/', '\\'])
    }).map(|(dir,profile)|serde_json::json!({"directory":dir,"name":profile["name"].as_str().unwrap_or(dir)})).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockModeEncrypt;
    #[test]
    fn encrypted_database_versions_and_host_integrity() {
        // Regression: Chrome v24 prefixes decrypted values with a host digest before the cookie value.
        for version in [23, 24] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("Cookies");
            let db = Connection::open(&source).unwrap();
            db.execute_batch("CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER,is_persistent INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT);").unwrap();
            db.execute("INSERT INTO meta VALUES ('version',?1)", [version])
                .unwrap();
            let key = [7; 16];
            let mut plain = Vec::new();
            if version >= 24 {
                plain.extend_from_slice(&Sha256::digest(b".claude.ai"));
            }
            plain.extend_from_slice(b"synthetic-value");
            let encrypted = cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[b' '; 16]).into())
                .encrypt_padded_vec::<Pkcs7>(&plain);
            let bytes = [b"v10".as_slice(), &encrypted].concat();
            for (host, name) in [
                (".claude.ai", "sessionKey"),
                (".claude.ai", "cf_clearance"),
                ("unrelated.example", "sessionKey"),
            ] {
                db.execute(
                    "INSERT INTO cookies VALUES (?1,?2,'/','',?3,0,0,1,1,1,'')",
                    rusqlite::params![host, name, bytes],
                )
                .unwrap();
            }
            let org = "550e8400-e29b-41d4-a716-446655440000";
            let mut org_plain = Vec::new();
            if version >= 24 {
                org_plain.extend_from_slice(&Sha256::digest(b".claude.ai"));
            }
            org_plain.extend_from_slice(org.as_bytes());
            let encrypted_org =
                cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[b' '; 16]).into())
                    .encrypt_padded_vec::<Pkcs7>(&org_plain);
            let org_bytes = [b"v10".as_slice(), &encrypted_org].concat();
            db.execute(
                "INSERT INTO cookies VALUES ('.claude.ai','lastActiveOrg','/','',?1,0,0,1,0,1,'')",
                rusqlite::params![org_bytes],
            )
            .unwrap();
            drop(db);
            let (db_version, rows) = snapshot(&source).unwrap();
            let result = decode_rows(db_version, rows, &key, 1_700_000_000).unwrap();
            assert!(result.cookies.len() == 2);
            assert!(result.last_active_org() == uuid::Uuid::parse_str(org).ok());
            assert!(result.cookies[0].1.value() == "synthetic-value");
            assert!(result.cookies[0].1.secure() == Some(true));
            assert!(result.cookies[0].1.http_only() == Some(true));
            let (db_version, rows) = snapshot(&source).unwrap();
            assert!(decode_rows(db_version, rows, &[9; 16], 1_700_000_000).is_err());
            if version >= 24 {
                let db = Connection::open(&source).unwrap();
                db.execute("UPDATE cookies SET host_key='claude.ai' WHERE name='sessionKey' AND host_key='.claude.ai'",[]).unwrap();
                drop(db);
                let (db_version, rows) = snapshot(&source).unwrap();
                assert!(decode_rows(db_version, rows, &key, 1_700_000_000).is_err());
            }
        }
    }
}
