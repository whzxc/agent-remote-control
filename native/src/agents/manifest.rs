//! ACP launch descriptions. Static facts never substitute for session negotiation.
use super::*;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default = "acp")]
    pub protocol: String,
    #[serde(default)]
    pub integration: Integration,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub search_dirs: Vec<String>,
    #[serde(default = "version_args")]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub compatibility: Compatibility,
}
fn acp() -> String {
    "acp-v1".into()
}
fn version_args() -> Vec<String> {
    vec!["--version".into()]
}
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Integration {
    Native,
    Adapter,
    #[default]
    Custom,
}
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compatibility {
    #[serde(default)]
    pub help_args: Vec<String>,
    #[serde(default)]
    pub help_contains: Vec<String>,
    #[serde(default)]
    pub identity_contains: Vec<String>,
    #[serde(default)]
    pub version_requirement: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub authentication: String,
    #[serde(default)]
    pub caveats: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err("INVALID_OR_DUPLICATE_AGENT_ID".into());
        }
        if self.protocol != "acp-v1"
            || self.command.trim().is_empty()
            || self.command.contains('\0')
            || self.args.iter().any(|s| s.contains('\0'))
            || ((!self.compatibility.help_contains.is_empty()
                || !self.compatibility.identity_contains.is_empty())
                && self.compatibility.help_args.is_empty())
        {
            return Err("INVALID_ACP_MANIFEST".into());
        }
        Ok(())
    }
    pub fn candidates(&self) -> Vec<PathBuf> {
        let mut paths = driver::search_paths();
        paths.extend(self.search_dirs.iter().filter_map(|s| {
            if let Some(relative) = s.strip_prefix("~/") {
                dirs::home_dir().map(|h| h.join(relative))
            } else {
                Some(PathBuf::from(s))
            }
        }));
        let mut found = Vec::new();
        for name in std::iter::once(&self.command).chain(&self.aliases) {
            for p in driver::discover_in(name, &paths) {
                if !found.contains(&p) {
                    found.push(p);
                }
            }
        }
        found
    }
}
pub(super) fn builtins() -> Result<Vec<Manifest>> {
    serde_json::from_str(include_str!("../../../shared/core/builtins.json")).map_err(|e| e.to_string())
}
