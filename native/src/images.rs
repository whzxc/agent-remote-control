//! Bounded image decoding and MCP projection shared by file and Codex reads.
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{GenericImageView, ImageFormat};
use std::io::Cursor;
pub const MAX_BYTES: usize = 1024 * 1024;
const MAX_INPUT: usize = 16 * 1024 * 1024;
const ATTACHMENTS: &str = "_connectorImageContent";
pub fn format(bytes: &[u8], path: &str) -> Option<ImageFormat> {
    let detected = image::guess_format(bytes).ok();
    let candidate = detected.or_else(|| ImageFormat::from_path(path).ok());
    candidate.filter(|f| {
        matches!(
            f,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
        )
    })
}
pub fn text(bytes: Vec<u8>, path: &str) -> Result<String> {
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        let kind = image::guess_format(&bytes)
            .map(|f| format!("{f:?}"))
            .unwrap_or_else(|_| {
                if bytes.starts_with(b"%PDF-") {
                    "pdf".into()
                } else if bytes.starts_with(b"PK\x03\x04") {
                    "zip".into()
                } else {
                    Path::new(path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_owned()
                }
            });
        return Err(format!("BINARY_FILE: type={kind}, bytes={}", bytes.len()));
    }
    String::from_utf8(bytes).map_err(|_| "NON_UTF8_FILE".into())
}
#[derive(Debug)]
pub struct Prepared {
    pub metadata: Value,
    pub content: Value,
}
impl Prepared {
    pub fn blocks(&self, source: &str) -> Vec<Value> {
        vec![
            json!({"type":"text","text":format!("{source}: {}", self.metadata)}),
            self.content.clone(),
        ]
    }
}
pub fn prepare(bytes: &[u8], path: &str, args: &Value) -> Result<Prepared> {
    if bytes.len() > MAX_INPUT {
        return Err("IMAGE_INPUT_TOO_LARGE: limit=16777216".into());
    }
    let format = format(bytes, path).ok_or("UNSUPPORTED_IMAGE_FORMAT")?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoded = reader.decode().map_err(|e| format!("INVALID_IMAGE: {e}"))?;
    let original = decoded.dimensions();
    let edge = num(args, "maxEdge", 1568).clamp(1, 4096) as u32;
    let original_mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => unreachable!(),
    };
    let package = |output: &[u8], dimensions: (u32, u32), mime: &str, reencoded: bool| Prepared {
        metadata: json!({"path":path,"originalWidth":original.0,"originalHeight":original.1,"width":dimensions.0,"height":dimensions.1,"originalBytes":bytes.len(),"bytes":output.len(),"sha256":hash(bytes),"returnedSha256":hash(output),"mimeType":mime,"reencoded":reencoded}),
        content: json!({"type":"image","mimeType":mime,"data":STANDARD.encode(output)}),
    };
    if original.0.max(original.1) <= edge && bytes.len() <= MAX_BYTES {
        return Ok(package(bytes, original, original_mime, false));
    }
    if original.0.max(original.1) > edge {
        decoded = decoded.resize(edge, edge, image::imageops::FilterType::Lanczos3);
    }
    let mut quality = num(args, "quality", 80).clamp(1, 100) as u8;
    // Preserve alpha for PNG/GIF/WebP. Opaque JPEG/WebP use quality-controlled JPEG.
    let jpeg = format == ImageFormat::Jpeg
        || (format == ImageFormat::WebP
            && (!decoded.color().has_alpha() || decoded.to_rgba8().pixels().all(|p| p[3] == 255)));
    loop {
        let mut output = Cursor::new(Vec::new());
        if jpeg {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
                .encode_image(&decoded.to_rgb8())
                .map_err(|e| e.to_string())?;
        } else {
            decoded
                .write_to(&mut output, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
        let output = output.into_inner();
        // A small dimension reduction must not inflate an already bounded source.
        // Larger sources still obey maxEdge, even when that requires more bytes.
        if bytes.len() <= MAX_BYTES
            && original.0.max(original.1) * 10 < edge * 11
            && output.len() >= bytes.len()
        {
            return Ok(package(bytes, original, original_mime, false));
        }
        if output.len() <= MAX_BYTES {
            let mime = if jpeg { "image/jpeg" } else { "image/png" };
            return Ok(package(&output, decoded.dimensions(), mime, true));
        }
        if jpeg && quality > 40 {
            quality = quality.saturating_sub(10).max(40);
            continue;
        }
        let edge = decoded.width().max(decoded.height());
        if edge <= 1 {
            return Err("IMAGE_TOO_LARGE: cannot fit within 1048576 bytes".into());
        }
        let next = (edge * 3 / 4).max(1);
        decoded = decoded.resize(next, next, image::imageops::FilterType::Lanczos3);
    }
}
pub fn attach(value: &mut Value, blocks: Vec<Value>) {
    if !blocks.is_empty() {
        value[ATTACHMENTS] = json!(blocks);
    }
}
pub fn take(value: &mut Value) -> Vec<Value> {
    value
        .as_object_mut()
        .and_then(|o| o.remove(ATTACHMENTS))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}
fn local_path(path: &str, thread: &str, cwd: &str) -> Result<PathBuf> {
    let project = Path::new(cwd).canonicalize().map_err(|e| e.to_string())?;
    let requested = project.join(path);
    let actual = requested.canonicalize().map_err(|e| e.to_string())?;
    if actual.starts_with(&project) {
        crate::projects::review_path(
            project.to_str().ok_or("INVALID_PATH")?,
            actual.to_str().ok_or("INVALID_PATH")?,
        )?;
        return Ok(actual);
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or("CODEX_HOME_UNAVAILABLE")?;
    let visuals = home
        .join("visualizations")
        .canonicalize()
        .map_err(|_| "OUTSIDE_THREAD_IMAGE_ROOT")?;
    visual_path(&actual, &visuals, thread)
}
fn visual_path(actual: &Path, visuals: &Path, thread: &str) -> Result<PathBuf> {
    let relative = actual
        .strip_prefix(&visuals)
        .map_err(|_| "OUTSIDE_THREAD_IMAGE_ROOT")?;
    let parts: Vec<_> = relative.components().collect();
    // Layout: visualizations/YYYY/MM/DD/threadId/file (or descendants).
    if parts.len() < 5
        || parts[3].as_os_str() != thread
        || !parts[..3].iter().zip([4, 2, 2]).all(|(p, n)| {
            p.as_os_str()
                .to_str()
                .is_some_and(|s| s.len() == n && s.bytes().all(|b| b.is_ascii_digit()))
        })
    {
        return Err("OUTSIDE_THREAD_IMAGE_ROOT".into());
    }
    crate::projects::review_path(
        visuals.to_str().ok_or("INVALID_PATH")?,
        actual.to_str().ok_or("INVALID_PATH")?,
    )?;
    Ok(actual.to_path_buf())
}
fn data_images(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(s) if s.starts_with("data:image/") => found.push(s.clone()),
        Value::String(s) if s.starts_with('{') || s.starts_with('[') => {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                data_images(&v, found);
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                data_images(v, found);
            }
        }
        Value::Array(a) => {
            for v in a {
                data_images(v, found);
            }
        }
        _ => {}
    }
}
/// Items must be supplied newest first, before text truncation.
pub fn from_items(items: &[Value], thread: &str, cwd: &str, args: &Value) -> Vec<Value> {
    if args["includeImages"] != true {
        return Vec::new();
    }
    let max = num(args, "maxImages", 4).clamp(1, 8);
    let markdown =
        regex::Regex::new(r"!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)").unwrap();
    let mut blocks = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut count = 0;
    for item in items {
        let mut sources = Vec::new();
        if item["type"] == "agentMessage" {
            for cap in markdown.captures_iter(string(item, "text")) {
                sources.push(
                    cap.get(1)
                        .or_else(|| cap.get(2))
                        .unwrap()
                        .as_str()
                        .to_owned(),
                );
            }
        } else if matches!(
            string(item, "type"),
            "mcpToolCall" | "dynamicToolCall" | "computerToolCall" | "browserToolCall"
        ) {
            data_images(&item["result"], &mut sources);
            data_images(&item["contentItems"], &mut sources);
        }
        for source in sources.into_iter().rev() {
            if count >= max {
                return blocks;
            }
            if !seen.insert(source.clone()) {
                continue;
            }
            let label = format!(
                "itemId={} callId={} source={}",
                string(item, "id"),
                string(item, "callId"),
                if source.starts_with("data:") {
                    "embedded screenshot"
                } else {
                    &source
                }
            );
            let result = (|| {
                let bytes = if source.starts_with("data:image/") {
                    let (header, encoded) =
                        source.split_once(',').ok_or("INVALID_IMAGE_DATA_URL")?;
                    if !header.ends_with(";base64") || encoded.len() > MAX_INPUT * 4 / 3 + 4 {
                        return Err("INVALID_IMAGE_DATA_URL".into());
                    }
                    STANDARD
                        .decode(encoded)
                        .map_err(|_| "INVALID_IMAGE_BASE64")?
                } else {
                    let path = local_path(&source, thread, cwd)?;
                    crate::projects::read_bytes("", path.to_str().ok_or("INVALID_PATH")?)?
                };
                prepare(
                    &bytes,
                    if source.starts_with("data:") {
                        "embedded screenshot"
                    } else {
                        &source
                    },
                    &json!({}),
                )
            })();
            match result {
                Ok(image) => {
                    blocks.extend(image.blocks(&label));
                    count += 1;
                }
                Err(error) => {
                    blocks.push(json!({"type":"text","text":format!("{label}: {error}")}))
                }
            }
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32, noise: bool) -> Vec<u8> {
        let mut state = 7u32;
        let image = image::RgbImage::from_fn(width, height, |_, _| {
            if noise {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                image::Rgb([state as u8, (state >> 8) as u8, (state >> 16) as u8])
            } else {
                image::Rgb([12, 34, 56])
            }
        });
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }
    #[test]
    fn detects_magic_before_extension_and_rejects_invalid_images() {
        let bytes = png(3, 2, false);
        assert_eq!(format(&bytes, "disguised.jpg"), Some(ImageFormat::Png));
        assert_eq!(
            format(b"\xff\xd8\xff\xe0", "wrong.png"),
            Some(ImageFormat::Jpeg)
        );
        assert_eq!(format(b"GIF89a", "wrong.png"), Some(ImageFormat::Gif));
        assert_eq!(
            format(b"RIFF\x00\x00\x00\x00WEBP", "wrong.png"),
            Some(ImageFormat::WebP)
        );
        assert!(prepare(b"not an image", "fake.png", &json!({}))
            .unwrap_err()
            .contains("INVALID_IMAGE"));
        assert!(text(b"%PDF-1.7\0binary".to_vec(), "fake.bin")
            .unwrap_err()
            .contains("type=pdf, bytes=15"));
    }
    #[test]
    fn scales_and_limits_encoded_image_bytes() {
        let prepared = prepare(&png(2400, 1200, false), "large.png", &json!({})).unwrap();
        assert_eq!(prepared.metadata["width"], 1568);
        assert_eq!(prepared.metadata["height"], 784);
        let prepared = prepare(&png(1600, 1600, true), "noise.png", &json!({})).unwrap();
        let bytes = STANDARD.decode(string(&prepared.content, "data")).unwrap();
        assert!(bytes.len() <= MAX_BYTES);
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(
            decoded.width(),
            prepared.metadata["width"].as_u64().unwrap() as u32
        );
        assert!(decoded.width() < 1568);
        assert_eq!(prepared.content["mimeType"], "image/png");
    }
    #[test]
    fn preserves_bounded_originals_and_avoids_small_resize_inflation() {
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::WebP,
            ImageFormat::Gif,
        ] {
            let mut source = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(40, 20)
                .write_to(&mut source, format)
                .unwrap();
            let source = source.into_inner();
            let prepared = prepare(&source, "disguised.bin", &json!({"quality":1})).unwrap();
            assert_eq!(
                STANDARD.decode(string(&prepared.content, "data")).unwrap(),
                source
            );
            assert_eq!(prepared.metadata["reencoded"], false);
            assert_eq!(
                prepared.metadata["sha256"],
                prepared.metadata["returnedSha256"]
            );
            assert_eq!(image::guess_format(&source).unwrap(), format);
        }
        let noisy = image::load_from_memory(&png(1620, 863, true)).unwrap();
        let mut original = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut original, 10)
            .encode_image(&noisy)
            .unwrap();
        assert!(original.len() <= MAX_BYTES);
        let prepared = prepare(&original, "small-resize.jpg", &json!({})).unwrap();
        assert_eq!(prepared.metadata["reencoded"], false);
        assert_eq!(prepared.metadata["width"], 1620);
        assert_eq!(
            STANDARD.decode(string(&prepared.content, "data")).unwrap(),
            original
        );
        // A reduction of more than 10% still obeys the requested dimensions.
        let prepared = prepare(&original, "large-resize.jpg", &json!({"maxEdge":1400})).unwrap();
        assert_eq!(prepared.metadata["reencoded"], true);
        assert!(prepared.metadata["width"].as_u64().unwrap() <= 1400);
        // A source below maxEdge but over the byte cap must still be compressed.
        let original = png(800, 800, true);
        assert!(original.len() > MAX_BYTES);
        let prepared = prepare(&original, "oversized.png", &json!({})).unwrap();
        assert_eq!(prepared.metadata["reencoded"], true);
        assert!(prepared.metadata["bytes"].as_u64().unwrap() <= MAX_BYTES as u64);
    }
    #[test]
    fn thread_images_enforce_scope_and_default_is_unchanged() {
        let root = std::env::temp_dir().join(format!("arc-images-{}", id()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let inside = project.join("image.png");
        let outside = root.join("outside.png");
        std::fs::write(&inside, png(3, 2, false)).unwrap();
        std::fs::write(&outside, png(3, 2, false)).unwrap();
        let cwd = project.to_str().unwrap();
        let visuals = root.join("visualizations");
        let own = visuals.join("2026/01/01/test-thread/image.png");
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, png(3, 2, false)).unwrap();
        let visuals = visuals.canonicalize().unwrap();
        let own = own.canonicalize().unwrap();
        assert!(visual_path(&own, &visuals, "test-thread").is_ok());
        assert!(visual_path(&own, &visuals, "different-thread").is_err());

        assert!(local_path(inside.to_str().unwrap(), "test-thread", cwd).is_ok());
        assert!(local_path(outside.to_str().unwrap(), "test-thread", cwd).is_err());
        assert!(local_path("../outside.png", "test-thread", cwd).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, project.join("escape.png")).unwrap();
            assert!(local_path("escape.png", "test-thread", cwd).is_err());
        }
        let items = vec![json!({"id":"item1","type":"agentMessage","text":"![image](image.png)"})];
        let mut value = json!({"items":items});
        let original = crate::egress::tool(value.clone(), false);
        attach(
            &mut value,
            from_items(&items, "test-thread", cwd, &json!({})),
        );
        assert_eq!(crate::egress::tool(value, false), original);
        let blocks = from_items(&items, "test-thread", cwd, &json!({"includeImages":true}));
        assert_eq!(blocks[1]["type"], "image");
        let data = STANDARD.encode(png(4, 3, false));
        let items = vec![
            json!({"id":"tool1","type":"mcpToolCall","result":{"structuredContent":{"screenshot":{"url":format!("data:image/png;base64,{data}")}}}}),
        ];
        let blocks = from_items(&items, "test-thread", cwd, &json!({"includeImages":true}));
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert!(!string(&blocks[0], "text").contains("base64"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
