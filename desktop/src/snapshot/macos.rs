use block2::RcBlock;
use objc2::{class, msg_send, rc::autoreleasepool, runtime::AnyObject};
use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use tokio::sync::{oneshot, Semaphore, SemaphorePermit};

type Png = Result<Vec<u8>, String>;
type Completion = RcBlock<dyn Fn(*mut AnyObject, *mut AnyObject)>;

// Rust request cancellation cannot cancel WKWebView's native capture. Keep the
// permit in its completion handler, including after the receiver times out.
static CAPTURE: Semaphore = Semaphore::const_new(1);
struct Capture {
    sender: oneshot::Sender<Png>,
    _permit: SemaphorePermit<'static>,
}
impl Capture {
    fn begin() -> Result<(Self, oneshot::Receiver<Png>), String> {
        let permit = CAPTURE
            .try_acquire()
            .map_err(|_| "SNAPSHOT_BUSY: a WebView PNG capture is still in flight")?;
        let (sender, receiver) = oneshot::channel();
        Ok((
            Self {
                sender,
                _permit: permit,
            },
            receiver,
        ))
    }

    fn completion(self) -> Completion {
        let pending = Mutex::new(Some(self));
        RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            let Some(capture) = pending.lock().unwrap().take() else {
                return;
            };
            if capture.sender.is_closed() {
                return;
            }
            // WebKit lends the image for this invocation. Never retain it in a
            // channel or the block. Only Rust-owned PNG bytes leave this scope.
            let result = unsafe { encode_png(image, error) };
            let _ = capture.sender.send(result);
        })
    }
}

pub(super) async fn capture_png(app: &tauri::AppHandle) -> Png {
    let window = app
        .get_webview_window("main")
        .ok_or("main WebView unavailable")?;
    let (capture, received) = Capture::begin()?;
    window
        .with_webview(move |webview| {
            // Do not start a native capture if its queued request was abandoned.
            if capture.sender.is_closed() {
                return;
            }
            autoreleasepool(|_| unsafe {
                let callback = capture.completion();
                let _: () = msg_send![webview.inner() as *mut AnyObject,
                takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(),
                completionHandler: &*callback];
            });
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), received)
        .await
        .map_err(|_| "SNAPSHOT_TIMEOUT: WKWebView")?
        .map_err(|_| "snapshot cancelled".to_string())?
}

// SAFETY: image/error are borrowed WKWebView completion arguments. A non-null
// image must be an NSImage valid throughout this call.
unsafe fn encode_png(image: *mut AnyObject, error: *mut AnyObject) -> Png {
    // The callback runs asynchronously, outside the pool around submission.
    // All +0 TIFF/bitmap/PNG objects belong to this pool, not the run loop's
    // potentially long-lived pool. Copy the bytes before draining it.
    autoreleasepool(|_| {
        if !error.is_null() || image.is_null() {
            return Err("WKWebView takeSnapshot failed".into());
        }
        let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
        if tiff.is_null() {
            return Err("snapshot TIFF unavailable".into());
        }
        let bitmap: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if bitmap.is_null() {
            return Err("snapshot bitmap unavailable".into());
        }
        let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4.
        let data: *mut AnyObject =
            msg_send![bitmap, representationUsingType: 4usize, properties: properties];
        if data.is_null() {
            return Err("snapshot PNG encoding failed".into());
        }
        #[cfg(test)]
        ENCODED.with_borrow_mut(|objects| {
            for (name, object) in [("TIFF", tiff), ("bitmap", bitmap), ("PNG", data)] {
                objects.push((name, objc2::rc::Weak::new(&*object)));
            }
        });
        let length: usize = msg_send![data, length];
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() || length == 0 {
            return Err("empty snapshot".into());
        }
        Ok(std::slice::from_raw_parts(bytes, length).to_vec())
    })
}

#[cfg(test)]
thread_local! {
    // Weak references observe actual AppKit object destruction without keeping
    // the bitmap alive or relying on retainCount / allocator RSS heuristics.
    static ENCODED: std::cell::RefCell<Vec<(&'static str, objc2::rc::Weak<AnyObject>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::rc::{Allocated, Retained, Weak};
    use std::ptr;

    unsafe fn image(width: usize, height: usize) -> Retained<AnyObject> {
        let color: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: c"NSDeviceRGBColorSpace".as_ptr()];
        let bitmap: Allocated<AnyObject> = msg_send![class!(NSBitmapImageRep), alloc];
        let bitmap: Retained<AnyObject> = msg_send![bitmap,
            initWithBitmapDataPlanes: ptr::null_mut::<*mut u8>(),
            pixelsWide: width as isize, pixelsHigh: height as isize,
            bitsPerSample: 8isize, samplesPerPixel: 4isize,
            hasAlpha: true, isPlanar: false, colorSpaceName: color,
            bytesPerRow: (width * 4) as isize, bitsPerPixel: 32isize];
        let pixels: *mut u8 = msg_send![&bitmap, bitmapData];
        // Synthetic pixels only: no window, WebView or screen capture.
        ptr::write_bytes(pixels, 0x7f, width * height * 4);
        let image: Retained<AnyObject> = msg_send![class!(NSImage), new];
        let _: () = msg_send![&image, addRepresentation: &*bitmap];
        image
    }

    #[test]
    fn png_encoding_releases_appkit_buffers_before_returning() {
        // Recurring bug class: PNG capture buffers accumulated until the run-loop autorelease pool drained.
        let (width, height) = (1680, 1156);
        autoreleasepool(|_| unsafe {
            for _ in 0..30 {
                let image = image(width, height);
                let borrowed = Weak::from_retained(&image);
                let png = encode_png(Retained::as_ptr(&image).cast_mut(), ptr::null_mut()).unwrap();
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
                assert_eq!(
                    u32::from_be_bytes(png[16..20].try_into().unwrap()) as usize,
                    width
                );
                assert_eq!(
                    u32::from_be_bytes(png[20..24].try_into().unwrap()) as usize,
                    height
                );
                ENCODED.with_borrow_mut(|objects| {
                    assert!(!objects.is_empty());
                    let live: Vec<_> = objects
                        .drain(..)
                        .filter_map(|(name, object)| object.load().is_some().then_some(name))
                        .collect();
                    assert!(
                        live.is_empty(),
                        "AppKit objects survived PNG encoding: {live:?}"
                    );
                });
                // The borrowed input is still valid, and ARC does not retain it.
                assert!(borrowed.load().is_some());
                drop(image);
                assert!(borrowed.load().is_none());
            }
        });
    }

    #[tokio::test]
    async fn abandoned_capture_holds_capacity_until_native_completion() {
        // Recurring bug class: request timeouts released the serial lock while WKWebView captures remained in flight.
        let (capture, received) = Capture::begin().unwrap();
        let callback = capture.completion();
        assert!(tokio::time::timeout(Duration::ZERO, received)
            .await
            .is_err());
        for _ in 0..120 {
            assert!(Capture::begin().is_err());
        }
        // An abandoned receiver skips encoding and releases the native permit.
        callback.call((ptr::null_mut(), ptr::null_mut()));
        let (capture, received) = Capture::begin().unwrap();
        let failed = capture.completion();
        failed.call((ptr::null_mut(), ptr::null_mut()));
        assert!(received.await.unwrap().is_err());
        // WebKit may retain an already-invoked block. It must not hold capacity.
        let (capture, received) = Capture::begin().unwrap();
        let discarded = capture.completion();
        drop(discarded);
        assert!(received.await.is_err());
        let (capture, received) = Capture::begin().unwrap();
        drop(received);
        drop(capture);
        assert!(Capture::begin().is_ok());
    }
}
