include!("../tooling/build-version.rs");
fn main() {
    let version = build_version();
    let mut config: serde_json::Value =
        serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_else(|_| "{}".to_owned()))
            .expect("Invalid TAURI_CONFIG");
    config["version"] = version.into();
    println!("cargo:rustc-env=TAURI_CONFIG={config}");
    std::env::set_var("TAURI_CONFIG", config.to_string());
    tauri_build::build();
}
