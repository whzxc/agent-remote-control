//! Device-owned UI preferences. The renderer cache is imported once, then follows Core.
use crate::*;
fn lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}
pub fn defaults() -> Value {
    json!({"theme":"system","theme-color":"arc","language":"auto","notifications":"on","update-auto-check":"on","update-auto-download":"on","update-skipped-version":"","update-last-check":"0","quota-display":"remaining","quota-reset-display":"countdown","agents-max-visible":"4"})
}
fn stored() -> Value {
    let path = root().join("ui-preferences.json");
    let mut value = load(&path).unwrap_or(json!({"values":{},"imported":false}));
    if value["arc-palette"] != true {
        if value["values"]["theme-color"] == "forest" {
            value["values"]["theme-color"] = json!("arc");
        }
        value["arc-palette"] = json!(true);
        // Persist the migration even if the user later selects forest again.
        let _ = save(&path, &value);
    }
    value
}
fn effective(stored: &Value) -> Value {
    let mut values = defaults();
    if let Some(fields) = stored["values"].as_object() {
        for (key, value) in fields {
            values[key] = value.clone();
        }
    }
    values
}
pub fn read() -> Value {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    effective(&stored())
}
pub fn write(body: Value) -> Result<Value> {
    change(body, false)
}
pub fn import(body: Value) -> Result<Value> {
    change(body, true)
}
fn change(body: Value, importing: bool) -> Result<Value> {
    let _guard = lock().lock().map_err(|e| e.to_string())?;
    let mut stored = stored();
    if importing && stored["imported"] == true {
        return Ok(effective(&stored));
    }
    let values = stored["values"]
        .as_object_mut()
        .ok_or("invalid preference store")?;
    for (key, value) in body["values"]
        .as_object()
        .ok_or("values must be an object")?
    {
        if key.len() > 128 || !value.is_null() && !value.as_str().is_some_and(|s| s.len() <= 16384)
        {
            return Err("invalid preference".into());
        }
        if importing && values.contains_key(key) {
            continue;
        }
        if value.is_null() {
            values.remove(key);
        } else {
            values.insert(
                key.clone(),
                if importing && key == "theme-color" && value == "forest" {
                    json!("arc")
                } else {
                    value.clone()
                },
            );
        }
    }
    if importing {
        stored["imported"] = json!(true);
    }
    save(&root().join("ui-preferences.json"), &stored)?;
    Ok(effective(&stored))
}
