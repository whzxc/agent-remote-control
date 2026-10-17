use super::*;
pub fn credential() -> std::result::Result<Credential, Failure> {
    // OpenCode uses xdg-basedir on all platforms, not macOS Application Support.
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or(home()?.join(".local/share"));
    let v = file(&data.join("opencode/auth.json"))?;
    Credential::new(
        v["opencode-go"]["key"].as_str().unwrap_or("").into(),
        "opencode-login",
    )
}
pub async fn read(
    client: &reqwest::Client,
    c: &Credential,
) -> std::result::Result<Reading, Failure> {
    let v = get(client
        .get("https://opencode.ai/zen/go/v1/usage")
        .bearer_auth(&c.secret))
    .await?;
    let mut windows = vec![];
    for id in ["rolling", "weekly", "monthly"] {
        let q = &v["usage"][id];
        if let Some(mut w) = window(id, "go", id, number(&q["percent"]), date(&q["resetsAt"])) {
            w.exhausted = match q["status"].as_str() {
                Some("ok") => Some(false),
                Some("exhausted") | Some("blocked") => Some(true),
                _ => None,
            };
            windows.push(w)
        }
    }
    Reading::new(windows, v)
}
