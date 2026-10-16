//! macOS UI operations run under Agent Remote Control, never under Codex app-server.
use crate::*;

pub async fn call(args: Value) -> Result<Value> {
    #[cfg(target_os = "macos")]
    {
        // The owned task retains the lock even when the caller disconnects, so
        // helper completion and focus restoration cannot race the next action.
        tokio::spawn(async move {
            static OPERATIONS: Mutex<()> = Mutex::const_new(());
            let _guard = OPERATIONS.lock().await;
            invoke(args).await
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        Err("SCREEN_UNSUPPORTED: screen 仅支持 macOS。".into())
    }
}

#[cfg(target_os = "macos")]
async fn invoke(args: Value) -> Result<Value> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let helper = crate::runtime::binary()?.with_file_name("clc-screen");
    let mut child = tokio::process::Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("SCREEN_HELPER_UNAVAILABLE: {e}"))?;
    let mut input = child.stdin.take().ok_or("SCREEN_HELPER_STDIN")?;
    input
        .write_all(&serde_json::to_vec(&args).map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    drop(input);
    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "SCREEN_HELPER_FAILED: {} {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let mut response: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("SCREEN_HELPER_INVALID_JSON: {e}"))?;
    if response["ok"] != true {
        return Err(string(&response, "error").to_owned());
    }
    let mut result = response["result"].take();
    let image = if args["action"] == "capture" {
        Some(prepare(&mut result, &args)?)
    } else if result["capture"].is_object() {
        match prepare(&mut result["capture"], &args["after"]["capture"]) {
            Ok(image) => Some(image),
            Err(error) => {
                // An action already performed must not be reported as failed
                // merely because its optional screenshot could not be encoded.
                result["captureError"] = json!(error);
                None
            }
        }
    } else {
        None
    };
    if let Some(image) = image {
        crate::images::attach(&mut result, vec![image]);
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
fn prepare(capture: &mut Value, args: &Value) -> Result<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let encoded = capture
        .as_object_mut()
        .and_then(|v| v.remove("imageBase64"))
        .ok_or("SCREEN_IMAGE_MISSING")?;
    let bytes = STANDARD
        .decode(encoded.as_str().ok_or("SCREEN_IMAGE_INVALID")?)
        .map_err(|e| e.to_string())?;
    let source = format!("screen/window-{}.png", capture["window"]["windowId"]);
    let image = crate::images::prepare(&bytes, &source, args)?;
    capture["image"] = image.metadata;
    Ok(image.content)
}
