include!("../tooling/build-version.rs");
fn main() {
    build_version();
    let ui =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../dist/ui");
    println!("cargo:rerun-if-changed={}", ui.display());
    fn assets(directory: &std::path::Path, base: &std::path::Path, entries: &mut String) {
        if !directory.exists() {
            return;
        }
        let mut files = std::fs::read_dir(directory)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            if file.is_dir() {
                assets(&file, base, entries);
            } else {
                let name = file
                    .strip_prefix(base)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/");
                if name == "browser.html" || name.starts_with("assets/") {
                    entries.push_str(&format!(
                        "({name:?}, include_bytes!({:?})),",
                        file.to_str().unwrap()
                    ));
                }
            }
        }
    }
    let mut entries = String::new();
    if ui.join("browser.html").exists() {
        assets(&ui, &ui, &mut entries);
    }
    std::fs::write(
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("browser_assets.rs"),
        format!("const BROWSER_ASSETS: &[(&str, &[u8])] = &[{entries}];"),
    )
    .unwrap();
    let base = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../skills/arc-setup");
    println!("cargo:rerun-if-changed={}", base.display());
    let mut files = vec![base.join("SKILL.md")];
    files.extend(
        std::fs::read_dir(base.join("playbooks"))
            .unwrap()
            .map(|e| e.unwrap().path()),
    );
    files.sort();
    let entries = files
        .iter()
        .map(|file| {
            format!(
                "({:?}, include_bytes!({:?})),",
                file.strip_prefix(&base)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
                file.to_str().unwrap()
            )
        })
        .collect::<String>();
    std::fs::write(
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("package_skills.rs"),
        format!("const SKILLS: &[(&str, &[u8])] = &[{entries}];"),
    )
    .unwrap();
}
