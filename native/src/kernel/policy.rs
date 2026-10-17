use crate::*;
pub fn allows(policy: &Value, name: &str) -> bool {
    name == "guide"
        || policy == "all"
        || policy["allowlist"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|v| v == name))
}

pub fn default_policy() -> Value {
    let exposure = &crate::catalog()["toolExposure"]["tools"];
    json!({"allowlist":crate::catalog()["ops"].as_array().unwrap().iter().filter_map(|t| {
        let name = string(t,"name");
        exposure[name]["presets"].as_array().is_some_and(|p| p.iter().any(|v|v=="common")).then_some(name)
    }).collect::<Vec<_>>()})
}
