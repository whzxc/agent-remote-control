//! Shared UI message resources; setup follows the app's language preference.
use crate::*;
use std::sync::OnceLock;

pub fn locale() -> String {
    let prefs = crate::preferences::read();
    match string(&prefs, "language") {
        "en" => "en".into(),
        "zh-CN" => "zh-CN".into(),
        _ => prefs["resolved-language"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let language = std::env::var("LC_ALL")
                    .or_else(|_| std::env::var("LC_MESSAGES"))
                    .or_else(|_| std::env::var("LANG"))
                    .unwrap_or_default()
                    .replace('_', "-")
                    .to_lowercase();
                if language.starts_with("zh-cn")
                    || language.starts_with("zh-sg")
                    || language.starts_with("zh-hans")
                {
                    "zh-CN"
                } else {
                    "en"
                }
                .into()
            }),
    }
}
pub fn text<'a>(locale: &str, key: &'a str) -> &'a str {
    static EN: OnceLock<Value> = OnceLock::new();
    static ZH: OnceLock<Value> = OnceLock::new();
    let en = EN.get_or_init(|| {
        serde_json::from_str(include_str!("../../ui/locales/en.json"))
            .expect("English UI resources")
    });
    let zh = ZH.get_or_init(|| {
        serde_json::from_str(include_str!("../../ui/locales/zh-CN.json"))
            .expect("Chinese UI resources")
    });
    (if locale == "zh-CN" {
        zh[key].as_str()
    } else {
        None
    })
    .or_else(|| en[key].as_str())
    .unwrap_or(key)
}
