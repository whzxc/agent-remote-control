// Shared by the Core and Desktop build scripts. Cargo builds need no Node runtime.
pub fn build_version() -> String {
    println!("cargo:rerun-if-env-changed=ARC_BUILD_VERSION");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    for name in ["HEAD", "refs", "packed-refs"] {
        println!(
            "cargo:rerun-if-changed={}",
            root.join(".git").join(name).display()
        );
    }
    println!(
        "cargo:rerun-if-changed={}",
        root.join("tooling/build-version.rs").display()
    );
    let value = std::env::var("ARC_BUILD_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::process::Command::new("git")
                .current_dir(root)
                .args(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_owned())
        })
        .unwrap_or_else(|| "0.0.0".to_owned());
    let version = value.strip_prefix('v').unwrap_or(&value);
    let parts: Vec<_> = version.split('.').collect();
    assert!(
        parts.len() == 3
            && parts.iter().all(|part| !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))),
        "Invalid stable build version"
    );
    println!("cargo:rustc-env=ARC_BUILD_VERSION={version}");
    version.to_owned()
}
