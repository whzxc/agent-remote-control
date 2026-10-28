use super::import::Imported;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_foundation::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use wry::{WebView, WebViewExtMacOS};

// Cocoa's cookie representation uses nil for SameSite=None/unspecified.
// Keep the original domain spelling; cookie::Cookie::domain() strips the dot.
pub fn install(view: &WebView, imported: Imported) -> Result<Arc<AtomicUsize>, &'static str> {
    let pending = Arc::new(AtomicUsize::new(imported.cookies.len()));
    unsafe {
        let store = view
            .webview()
            .configuration()
            .websiteDataStore()
            .httpCookieStore();
        let mut prepared = Vec::with_capacity(imported.cookies.len());
        for (domain, cookie) in imported.cookies {
            let name = NSString::from_str(cookie.name());
            let value = NSString::from_str(cookie.value());
            let path = NSString::from_str(cookie.path().unwrap_or("/"));
            let domain = NSString::from_str(&domain);
            let props: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> =
                NSMutableDictionary::from_slices(
                    &[
                        NSHTTPCookieName,
                        NSHTTPCookieValue,
                        NSHTTPCookiePath,
                        NSHTTPCookieDomain,
                    ],
                    &[&name, &value, &path, &domain],
                );
            if cookie.secure() == Some(true) {
                props.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
            }
            if cookie.http_only() == Some(true) {
                props.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
            }
            if let Some(expiry) = cookie.expires_datetime() {
                let date = NSDate::dateWithTimeIntervalSince1970(expiry.unix_timestamp() as f64);
                props.insert(NSHTTPCookieExpires, &*date);
            }
            let same_site = match cookie.same_site() {
                Some(tauri::webview::cookie::SameSite::Lax) => Some(ns_string!("lax")),
                Some(tauri::webview::cookie::SameSite::Strict) => Some(ns_string!("strict")),
                _ => None,
            };
            // Wry 0.57 uses this key as well (upstream issue #1616).
            if let Some(policy) = same_site {
                props.insert(ns_string!("SameSite"), policy);
            }
            let native =
                NSHTTPCookie::cookieWithProperties(&props).ok_or("native-cookie-invalid")?;
            if *native.name() != *name
                || *native.domain() != *domain
                || *native.path() != *path
                || native.isSecure() != cookie.secure().unwrap_or(false)
                || native.isHTTPOnly() != cookie.http_only().unwrap_or(false)
                || native.sameSitePolicy().as_deref() != same_site
            {
                return Err("native-cookie-metadata-mismatch");
            }
            prepared.push(native);
        }
        // Validate every native representation before submitting any writes.
        for native in prepared {
            let remaining = pending.clone();
            store.setCookie_completionHandler(
                &native,
                Some(&block2::RcBlock::new(move || {
                    remaining.fetch_sub(1, Ordering::SeqCst);
                })),
            );
        }
    }
    Ok(pending)
}

pub fn verify_no_scripts(view: &WebView) -> Result<(), &'static str> {
    if unsafe { view.manager().userScripts().count() } != 0 {
        return Err("unexpected-user-scripts");
    }
    Ok(())
}

/// Caller must release the WebView first. Only the completion outcome crosses the bridge.
pub type Removal = Arc<std::sync::Mutex<Option<Result<(), &'static str>>>>;
pub fn remove_store(store: &str) -> Result<Removal, &'static str> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    let uuid = NSUUID::initWithUUIDString(NSUUID::alloc(), &NSString::from_str(store))
        .ok_or("SRC_STORE_ID_INVALID")?;
    let mtm = MainThreadMarker::new().ok_or("SRC_MAIN_THREAD_UNAVAILABLE")?;
    let removal = Arc::new(std::sync::Mutex::new(None));
    let completed = removal.clone();
    unsafe {
        objc2_web_kit::WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(
            &uuid,
            &block2::RcBlock::new(move |error: *mut NSError| {
                *completed.lock().unwrap() = Some(if error.is_null() {
                    Ok(())
                } else {
                    Err("SRC_STORE_CLEAR_FAILED: Native website data removal failed; retry clear before importing")
                });
            }),
            mtm,
        );
    }
    Ok(removal)
}
