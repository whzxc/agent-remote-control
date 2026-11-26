//! Shared field/provider descriptors are consumed by Rust and the Vue form.
use crate::*;
pub fn descriptor() -> &'static Value {
    static VALUE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/core/ingress-config.json")).expect("embedded ingress descriptor")
    })
}
pub fn defaults() -> Value {
    Value::Object(
        descriptor()["fields"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, field)| (key.clone(), field["default"].clone()))
            .collect(),
    )
}
pub fn secrets() -> impl Iterator<Item = (&'static str, &'static str)> {
    descriptor()["fields"]
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, field)| field["savedFlag"].as_str().map(|flag| (key.as_str(), flag)))
}
pub(crate) fn configured(s: &Value) -> bool {
    if s["connectionMode"] == "local" {
        return true;
    }
    if s["connectionMode"] == "relay" {
        return !string(s, "relayUrl").is_empty() && !string(s, "relayInstanceId").is_empty();
    }
    if s["connectionMode"] != "https" {
        return !string(s, "tunnelId").is_empty() && !string(s, "apiKey").is_empty();
    }
    let provider = &descriptor()["providers"][string(s, "httpsProvider")];
    if provider.is_null() {
        return false;
    }
    let named = provider["mode"]
        .as_str()
        .is_none_or(|key| s[key] == "named");
    let needs_token =
        provider["tokenRequired"] == "always" || provider["tokenRequired"] == "named" && named;
    let token = provider["credential"].as_str().unwrap_or("");
    let credential_ready = if s["httpsProvider"] == "cloudflare" && s["cloudflareAuth"] == "login" {
        crate::cloudflare::configured(s)
    } else {
        !string(s, token).is_empty()
    };
    let endpoint = if s["httpsProvider"] == "ngrok" {
        "ngrokEndpoint"
    } else {
        "httpsUrl"
    };
    (!needs_token || credential_ready) && (!named || !string(s, endpoint).is_empty())
}

pub(crate) fn binding(s: &Value) -> String {
    if s["connectionMode"] == "relay" {
        return hash(json!([s["relayUrl"], s["relayInstanceId"]]).to_string());
    }
    if s["connectionMode"] == "https" {
        hash(
            json!([
                "https",
                s["httpsProvider"],
                s["cloudflareMode"],
                s["cloudflareToken"],
                s["cloudflareAuth"],
                s["cloudflareTunnelId"],
                s["ngrokAuthtoken"],
                s["ngrokMode"],
                s["ngrokEndpoint"],
                s["pinggyMode"],
                s["pinggyToken"],
                s["localxposeMode"],
                s["localxposeAccessToken"],
                s["localxposeRegion"],
                s["httpsUrl"],
                s["httpsHost"],
                s["httpsPort"]
            ])
            .to_string(),
        )
    } else {
        hash(json!([s["tunnelId"], s["apiKey"]]).to_string())
    }
}
pub(crate) fn validate_config(s: &Value) -> Result<()> {
    let o = s.as_object().ok_or("Invalid configuration format")?;
    crate::proxy::validate(
        s["proxyMode"].as_str().ok_or("Invalid proxy mode")?,
        s["proxyUrl"].as_str().ok_or("Invalid proxy address")?,
    )?;
    if o.len() != descriptor()["fields"].as_object().unwrap().len() || !s["autoStart"].is_boolean()
    {
        return Err("Invalid configuration field".into());
    }
    for (key, field) in descriptor()["fields"].as_object().unwrap() {
        if let Some(max) = field["maxBytes"].as_u64() {
            let value = s[key].as_str().ok_or("Invalid configuration type")?;
            if value.len() > max as usize || value.contains('\0') {
                return Err("Invalid configuration value".into());
            }
        }
    }
    if !["tunnel", "https", "relay", "local"].contains(&string(s, "connectionMode")) {
        return Err("Invalid connection method".into());
    }
    if s["connectionMode"] == "relay" {
        crate::relay::validate_config(s)?;
    }
    let providers = descriptor()["providers"].as_object().unwrap();
    if !["token", "login"].contains(&string(s, "cloudflareAuth")) {
        return Err("Invalid Cloudflare login method".into());
    }
    if !string(s, "cloudflareTunnelId").is_empty() {
        uuid::Uuid::parse_str(string(s, "cloudflareTunnelId"))
            .map_err(|_| "Invalid Cloudflare Tunnel ID")?;
    }
    if !providers.contains_key(string(s, "httpsProvider")) {
        return Err("Invalid HTTPS provider".into());
    }
    for (id, provider) in providers {
        if let Some(mode) = provider["mode"].as_str() {
            // Inactive LocalXpose quick mode remains readable; selecting it is unsupported.
            let valid = provider["modes"].as_array().unwrap().contains(&s[mode]);
            if !valid
                && !(id == "localxpose" && s[mode] == "quick" && s["httpsProvider"] != id.as_str())
            {
                return Err(format!("Invalid {} mode", string(provider, "label")));
            }
        }
        if let Some(key) = provider["credential"].as_str() {
            if string(s, key).chars().any(char::is_whitespace) {
                return Err(format!(
                    "{} Token cannot contain whitespace",
                    string(provider, "label")
                ));
            }
        }
    }
    if s["httpsProvider"] == "ngrok"
        && s["ngrokMode"] == "named"
        && !string(s, "ngrokEndpoint").is_empty()
    {
        crate::https_tunnel::ngrok_endpoint(string(s, "ngrokEndpoint"))?;
    }
    if !["us", "eu", "ap"].contains(&string(s, "localxposeRegion")) {
        return Err("Invalid LocalXpose region".into());
    }
    string(s, "httpsHost")
        .parse::<std::net::IpAddr>()
        .map_err(|_| "Listener address must be an IP address")?;
    if !s["httpsPort"]
        .as_u64()
        .is_some_and(|p| (1..=65535).contains(&p))
    {
        return Err("Invalid listener port".into());
    }
    let url = string(s, "httpsUrl");
    if !url.is_empty() {
        let u = reqwest::Url::parse(url).map_err(|_| "Invalid HTTPS URL")?;
        if u.scheme() != "https"
            || u.host_str().is_none()
            || u.path() != "/mcp"
            || u.query().is_some()
            || u.fragment().is_some()
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err(
                "Enter an HTTPS URL ending in /mcp without credentials or query parameters.".into(),
            );
        }
    }
    let id = string(s, "tunnelId");
    if !id.is_empty()
        && (!id.starts_with("tunnel_")
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
    {
        return Err("Invalid Tunnel ID format".into());
    }
    Ok(())
}
