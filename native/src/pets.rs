//! Local-only Codex Pets packages. No package code or remote image is executed.
use crate::*;
use base64::Engine;
use std::io::{Cursor, Read};
use std::time::Duration;

pub const MAX_BYTES: usize = 25 * 1024 * 1024;
const RAW: &str = "https://raw.githubusercontent.com/legeling/awesome-codex-pet/main";

pub fn page(input: &str) -> Result<(String, String)> {
    let u = url::Url::parse(input)
        .map_err(|_| "INVALID_ARGUMENT: enter a pet page HTTPS URL or choose ZIP")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.query().is_some()
    {
        return Err("INVALID_ARGUMENT: use an unmodified HTTPS pet page URL".into());
    }
    let site = u.host_str().unwrap_or("");
    let path = if site == "codex-pets.net" {
        u.fragment().unwrap_or(u.path())
    } else {
        u.path()
    };
    let slug = path.strip_prefix("/pets/").unwrap_or("");
    if !matches!(site, "codex-pets.net" | "codexpet.top")
        || slug.is_empty()
        || slug.len() > 200
        || !slug
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        || site == "codexpet.top" && u.fragment().is_some()
    {
        return Err("INVALID_ARGUMENT: supported links are codex-pets.net/pets/<id> and codexpet.top/pets/<slug>; use ZIP for other sites".into());
    }
    Ok((site.into(), slug.into()))
}
fn allowed_download(input: &str) -> Result<url::Url> {
    let u = url::Url::parse(input).map_err(|e| e.to_string())?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || !(u.host_str() == Some("codex-pets.net")
            || u.host_str() == Some("raw.githubusercontent.com")
                && u.path().starts_with("/legeling/awesome-codex-pet/main/"))
    {
        return Err("INVALID_ARGUMENT: pet download host or protocol is not allowed".into());
    }
    Ok(u)
}
async fn download(input: &str, budget: &mut usize) -> Result<Vec<u8>> {
    let url = allowed_download(input)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.status().is_redirection()
        || response
            .content_length()
            .is_some_and(|n| n > *budget as u64)
    {
        return Err("INVALID_ARGUMENT: redirect or pet package exceeds 25 MB".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if chunk.len() > *budget {
            return Err("INVALID_ARGUMENT: pet package exceeds 25 MB".into());
        }
        *budget -= chunk.len();
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn parse(data: &[u8]) -> Result<Value> {
    serde_json::from_slice(data).map_err(|e| format!("INVALID_ARGUMENT: pet JSON: {e}"))
}
fn safe_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 200
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        && !name.starts_with('.')
}
/// A bounded palette is a deterministic pixel-art hint, independent of transparent RGB noise.
pub fn pixel_art(image: &image::RgbaImage) -> bool {
    let mut colors = std::collections::HashSet::new();
    for pixel in image.pixels() {
        if pixel[3] == 0 {
            continue;
        }
        colors.insert(u32::from_le_bytes(pixel.0));
        if colors.len() > 256 {
            return false;
        }
    }
    !colors.is_empty()
}
pub fn validate(manifest: &[u8], sprite: &[u8]) -> Result<Value> {
    if manifest.len() + sprite.len() > MAX_BYTES || manifest.len() > 65536 {
        return Err("INVALID_ARGUMENT: pet package exceeds size limit".into());
    }
    let value = parse(manifest)?;
    if string(&value, "id").trim().is_empty()
        || string(&value, "id").len() > 200
        || !safe_file(string(&value, "spritesheetPath"))
    {
        return Err(
            "INVALID_ARGUMENT: pet.json needs id and a simple spritesheetPath filename".into(),
        );
    }
    let reader = image::ImageReader::new(Cursor::new(sprite))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let size = reader
        .into_dimensions()
        .map_err(|e| format!("INVALID_ARGUMENT: spritesheet: {e}"))?;
    let version = match size {
        (1536, 1872) => 1,
        (1536, 2288) => 2,
        _ => {
            return Err(
                "INVALID_ARGUMENT: spritesheet must be a 1536x1872 v1 or 1536x2288 v2 atlas".into(),
            )
        }
    };
    // Intrinsically animated files would bypass CSS pause and reduced-motion controls.
    let animated = match image::guess_format(sprite).map_err(|e| e.to_string())? {
        image::ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(sprite))
            .map_err(|e| e.to_string())?
            .has_animation(),
        image::ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(sprite))
            .map_err(|e| e.to_string())?
            .is_apng()
            .map_err(|e| e.to_string())?,
        _ => return Err("INVALID_ARGUMENT: use a static PNG or WebP spritesheet".into()),
    };
    if animated {
        return Err("INVALID_ARGUMENT: use a static atlas; ARC owns frame animation".into());
    }
    let decoded = image::load_from_memory(sprite)
        .map_err(|e| format!("INVALID_ARGUMENT: spritesheet decode: {e}"))?;
    let pixel_art = pixel_art(&decoded.to_rgba8());
    if value
        .get("spriteVersionNumber")
        .is_some_and(|v| v != version)
    {
        return Err("INVALID_ARGUMENT: atlas and spriteVersionNumber disagree".into());
    }
    Ok(
        json!({"id":value["id"],"name":value.get("displayName").unwrap_or(&value["id"]),"description":value.get("description").and_then(Value::as_str),"version":version,"sprite":value["spritesheetPath"],"pixelArt":pixel_art}),
    )
}
pub fn unpack(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    if data.len() > MAX_BYTES {
        return Err("INVALID_ARGUMENT: ZIP exceeds 25 MB".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(data))
        .map_err(|e| format!("INVALID_ARGUMENT: ZIP: {e}"))?;
    let mut files = std::collections::BTreeMap::new();
    let mut total = 0usize;
    if zip.len() != 2 {
        return Err(
            "INVALID_ARGUMENT: ZIP must contain only pet.json and its spritesheet at the root"
                .into(),
        );
    }
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_owned();
        if !safe_file(&name)
            || file.is_dir()
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || files.contains_key(&name)
            || file.size() > (MAX_BYTES - total) as u64
        {
            return Err("INVALID_ARGUMENT: unsafe, duplicate or oversized ZIP entry".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take((MAX_BYTES - total + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        total += bytes.len();
        if total > MAX_BYTES {
            return Err("INVALID_ARGUMENT: expanded ZIP exceeds 25 MB".into());
        }
        files.insert(name, bytes);
    }
    let manifest = files
        .remove("pet.json")
        .ok_or("INVALID_ARGUMENT: ZIP needs pet.json")?;
    let value = parse(&manifest)?;
    let sprite = files
        .remove(string(&value, "spritesheetPath"))
        .ok_or("INVALID_ARGUMENT: ZIP needs the manifest spritesheet")?;
    validate(&manifest, &sprite)?;
    Ok((manifest, sprite))
}
fn read_file(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take((max + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > max {
        return Err("INVALID_ARGUMENT: pet file exceeds size limit".into());
    }
    Ok(data)
}
fn directories() -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(root().join("pets"), "arc")];
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".codex/pets"), "codex"));
    }
    roots
}
fn entries() -> Vec<(String, PathBuf, &'static str)> {
    directories()
        .into_iter()
        .flat_map(|(root, origin)| {
            std::fs::read_dir(root)
                .into_iter()
                .flatten()
                .filter_map(move |item| {
                    let item = item.ok()?;
                    if !item.file_type().ok()?.is_dir()
                        || item.file_name().to_string_lossy().starts_with('.')
                    {
                        return None;
                    }
                    let path = item.path();
                    Some((
                        format!("{origin}:{}", hash(path.to_string_lossy().as_bytes())),
                        path,
                        origin,
                    ))
                })
        })
        .collect()
}
fn package(path: &Path) -> Result<(Value, Vec<u8>)> {
    let manifest_path = path.join("pet.json");
    if manifest_path
        .symlink_metadata()
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("INVALID_ARGUMENT: symlink pet manifest".into());
    }
    let manifest = read_file(&manifest_path, 65536)?;
    let parsed = parse(&manifest)?;
    let name = string(&parsed, "spritesheetPath");
    if !safe_file(name) {
        return Err("INVALID_ARGUMENT: unsafe spritesheet filename".into());
    }
    let sprite_path = path.join(name);
    if sprite_path
        .symlink_metadata()
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("INVALID_ARGUMENT: symlink spritesheet".into());
    }
    let sprite = read_file(&sprite_path, MAX_BYTES - manifest.len())?;
    Ok((validate(&manifest, &sprite)?, sprite))
}
fn list() -> Value {
    let mut packages = vec![];
    let mut errors = vec![];
    for (key, path, origin) in entries() {
        match package(&path) {
            Ok((mut info, _)) => {
                info["key"] = json!(key);
                info["origin"] = json!(origin);
                info["source"] = load(&path.join("source.json")).unwrap_or(json!({"site":origin,"pageUrl":null,"author":null,"license":null,"attribution":null}));
                packages.push(info);
            }
            Err(error) => errors.push(json!({"key":key,"error":error})),
        }
    }
    json!({"packages":packages,"errors":errors})
}
fn install(manifest: Vec<u8>, sprite: Vec<u8>, mut source: Value) -> Result<Value> {
    let info = validate(&manifest, &sprite)?;
    source["sha256"] = json!({"petJson":hash(&manifest),"spritesheet":hash(&sprite)});
    source["installedAt"] = json!(now());
    // Content-addressed packages allow atomic installation without replacing a user's files.
    let key = hash([manifest.as_slice(), sprite.as_slice()].concat());
    let root = root().join("pets");
    private_dir(&root)?;
    let dest = root.join(&key);
    if !dest.exists() {
        let staging = root.join(format!(".install-{}", id()));
        private_dir(&staging)?;
        let result = (|| {
            std::fs::write(staging.join("pet.json"), manifest).map_err(|e| e.to_string())?;
            std::fs::write(staging.join(string(&info, "sprite")), sprite)
                .map_err(|e| e.to_string())?;
            save(&staging.join("source.json"), &source)?;
            save(
                &staging.join("rendering.json"),
                &json!({"heuristicVersion":1,"pixelArt":info["pixelArt"]}),
            )?;
            std::fs::rename(&staging, &dest).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_dir_all(staging);
        result?;
    } else {
        save(
            &dest.join("rendering.json"),
            &json!({"heuristicVersion":1,"pixelArt":info["pixelArt"]}),
        )?;
    }
    Ok(list())
}
async fn install_link(input: &str) -> Result<Value> {
    let (site, slug) = page(input)?;
    let mut budget = MAX_BYTES;
    let (manifest, sprite, author, license, attribution) = if site == "codex-pets.net" {
        let response = parse(
            &download(
                &format!("https://codex-pets.net/api/pets?q={slug}&page=1&pageSize=60"),
                &mut budget,
            )
            .await?,
        )?;
        let entry = response["pets"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == slug))
            .ok_or("INVALID_ARGUMENT: exact pet id not found")?;
        let path = string(entry, "downloadUrl");
        if !path.starts_with("/api/pets/") {
            return Err("INVALID_ARGUMENT: unexpected pet download URL".into());
        }
        let (manifest, sprite) =
            unpack(&download(&format!("https://codex-pets.net{path}"), &mut budget).await?)?;
        let info = validate(&manifest, &sprite)?;
        let size = if info["version"] == 2 {
            "1536x2288"
        } else {
            "1536x1872"
        };
        if info["id"] != entry["validationReport"]["manifestId"]
            || entry["validationReport"]["atlasSize"] != size
        {
            return Err("INVALID_ARGUMENT: package disagrees with site validationReport".into());
        }
        (
            manifest,
            sprite,
            entry["ownerName"].clone(),
            entry["license"].clone(),
            entry["attribution"].clone(),
        )
    } else {
        let index = parse(&download(&format!("{RAW}/install-manifest.json"), &mut budget).await?)?;
        let entry = &index["pets"][&slug];
        if !entry.is_object() {
            return Err("INVALID_ARGUMENT: pet slug not found in install manifest".into());
        }
        let manifest = download(&format!("{RAW}/pets/{slug}/pet.json"), &mut budget).await?;
        let sprite = download(&format!("{RAW}/pets/{slug}/spritesheet.webp"), &mut budget).await?;
        if hash(&manifest) != string(entry, "petJsonSha256")
            || hash(&sprite) != string(entry, "spritesheetSha256")
            || entry["petJsonBytes"] != manifest.len()
            || entry["spritesheetBytes"] != sprite.len()
        {
            return Err("INVALID_ARGUMENT: pet SHA-256 or size verification failed; retry after the publisher fixes the package".into());
        }
        let info = validate(&manifest, &sprite)?;
        if info["version"] != entry["spriteVersionNumber"]
            || entry["spritesheetWidth"] != 1536
            || entry["spritesheetHeight"] != if info["version"] == 2 { 2288 } else { 1872 }
        {
            return Err("INVALID_ARGUMENT: install manifest atlas mismatch".into());
        }
        let submission =
            parse(&download(&format!("{RAW}/pets/{slug}/submission.json"), &mut budget).await?)?;
        (
            manifest,
            sprite,
            submission["author"].clone(),
            submission["license"].clone(),
            submission["attribution"].clone(),
        )
    };
    install(
        manifest,
        sprite,
        json!({"site":site,"pageUrl":format!("https://{site}/pets/{slug}"),"author":author,"license":license,"attribution":attribution}),
    )
}
pub async fn request(route: &str, method: &str, body: Value) -> Result<Value> {
    match (method, route) {
        ("GET", "pets") => tokio::task::spawn_blocking(list).await.map_err(|e| e.to_string()),
        ("POST", "pets/asset") => {
            let key = string(&body, "key");
            let (_, path, _) = entries().into_iter().find(|(id, _, _)| id == key).ok_or("INVALID_ARGUMENT: pet not installed; refresh pets")?;
            tokio::task::spawn_blocking(move || {
                let (_, sprite) = package(&path)?;
                let format = image::guess_format(&sprite).map_err(|e| e.to_string())?;
                Ok(json!({"dataUrl":format!("data:{};base64,{}", format.to_mime_type(), base64::engine::general_purpose::STANDARD.encode(sprite))}))
            }).await.map_err(|e| e.to_string())?
        }
        ("POST", "pets/remove") => tokio::task::spawn_blocking(move || {
            let key = string(&body, "key");
            let (_, path, origin) = entries().into_iter().find(|(id, _, _)| id == key)
                .ok_or("INVALID_ARGUMENT: pet not installed; refresh pets")?;
            if origin != "arc" {
                return Err("INVALID_ARGUMENT: Codex pets are read-only; remove them in their owning application".into());
            }
            std::fs::remove_dir_all(path).map_err(|e| format!("Failed to remove pet: {e}"))?;
            Ok(list())
        }).await.map_err(|e| e.to_string())?,
        ("POST", "pets/install") => install_link(string(&body, "url")).await,
        ("POST", "pets/import") => tokio::task::spawn_blocking(move || {
            let encoded = string(&body, "zip");
            if encoded.len() > MAX_BYTES.div_ceil(3) * 4 { return Err("INVALID_ARGUMENT: ZIP exceeds 25 MB".into()); }
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "INVALID_ARGUMENT: ZIP must be base64")?;
            let (manifest, sprite) = unpack(&bytes)?;
            let meta = parse(&manifest)?;
            install(manifest, sprite, json!({"site":"zip","pageUrl":null,"author":meta["author"],"license":meta["license"],"attribution":meta["attribution"]}))
        }).await.map_err(|e| e.to_string())?,
        _ => Err("UNKNOWN_ROUTE".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pixel_art_is_invariant_to_transparent_rgb_and_palette_repetition() {
        // Property: repeating a bounded visible palette or changing fully transparent RGB preserves classification.
        for count in [1u32, 16, 256] {
            let palette =
                image::RgbaImage::from_fn(count, 1, |x, _| image::Rgba([x as u8, 40, 90, 255]));
            assert!(pixel_art(&palette));
            let repeated = image::RgbaImage::from_fn(count * 3, 4, |x, y| {
                if y == 3 {
                    image::Rgba([x as u8, (x / 256) as u8, 130, 0])
                } else {
                    *palette.get_pixel(x % count, 0)
                }
            });
            assert_eq!(pixel_art(&palette), pixel_art(&repeated));
        }
        assert!(!pixel_art(&image::RgbaImage::new(8, 8)));
    }
    #[test]
    fn adding_distinct_visible_colors_crosses_the_palette_limit() {
        // Property: a palette above the heuristic limit remains smooth under repetition or pixel reordering.
        let gradient = image::RgbaImage::from_fn(257, 1, |x, _| {
            image::Rgba([x as u8, (x / 256) as u8, 70, 255])
        });
        assert!(!pixel_art(&gradient));
        let reversed =
            image::RgbaImage::from_fn(514, 2, |x, _| *gradient.get_pixel(256 - x % 257, 0));
        assert_eq!(pixel_art(&gradient), pixel_art(&reversed));
    }
    #[test]
    fn page_resolution_is_host_and_path_bounded() {
        // Property: only exact HTTPS community pet page hosts and single safe identifiers resolve.
        for url in [
            "https://codex-pets.net/#/pets/claude-maiden",
            "https://codex-pets.net/pets/claude-maiden",
            "https://codexpet.top/pets/gpt--author",
        ] {
            assert!(page(url).is_ok());
        }
        for url in [
            "http://codexpet.top/pets/a",
            "https://codexpet.top.evil/pets/a",
            "https://user@codexpet.top/pets/a",
            "https://codexpet.top/pets/../a",
            "https://codexpet.top/pets/a/b",
            "https://openpets.dev/pets/a",
        ] {
            assert!(page(url).is_err());
        }
        for url in [
            "http://codex-pets.net/a",
            "https://raw.githubusercontent.com/other/repo/main/a",
            "https://evil.test/a",
        ] {
            assert!(allowed_download(url).is_err());
        }
    }
    #[test]
    fn atlas_dimensions_and_manifest_agree() {
        // Property: a decoded atlas accepts exactly the two supported dimensions and matching declared versions.
        for (w, h, v, valid) in [
            (1536, 1872, 1, true),
            (1536, 2288, 2, true),
            (1536, 1872, 2, false),
            (192, 208, 1, false),
        ] {
            let mut data = Cursor::new(vec![]);
            image::DynamicImage::new_rgba8(w, h)
                .write_to(&mut data, image::ImageFormat::Png)
                .unwrap();
            let manifest = json!({"id":"synthetic","spritesheetPath":"spritesheet.png","spriteVersionNumber":v}).to_string();
            assert_eq!(validate(manifest.as_bytes(), data.get_ref()).is_ok(), valid);
        }
        assert!(validate(br#"{"spritesheetPath":"x.png"}"#, &[]).is_err());
        assert!(validate(br#"{"id":"a","spritesheetPath":"../x.png"}"#, &[]).is_err());
    }
    #[test]
    fn archives_cannot_escape_or_add_files() {
        // Property: ZIP imports reject traversal, duplicates, symlinks and unrelated files before extraction.
        use std::io::Write;
        for names in [
            ["../pet.json", "spritesheet.webp"],
            ["pet.json", "pet.json"],
            ["pet.json", "extra.txt"],
        ] {
            let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
            for name in names {
                if zip
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .is_ok()
                {
                    zip.write_all(b"{}").unwrap();
                }
            }
            assert!(unpack(zip.finish().unwrap().get_ref()).is_err());
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.add_symlink(
            "pet.json",
            "elsewhere",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.start_file("spritesheet.webp", zip::write::SimpleFileOptions::default())
            .unwrap();
        assert!(unpack(zip.finish().unwrap().get_ref()).is_err());
    }
}
