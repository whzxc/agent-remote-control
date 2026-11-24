//! Agent support levels shared by inventory, conversation listing and dispatch.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub native_conversations: bool,
    pub live_activity: bool,
    pub quota: bool,
    pub metadata_projection: bool,
    pub timeline: bool,
    pub caller_attribution: bool,
    pub subagents: bool,
    pub navigation: bool,
    pub dispatch_defaults: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct AgentProfile {
    pub id: &'static str,
    pub capabilities: AgentCapabilities,
    pub caller_env: Option<&'static str>,
    pub default_quota_provider: Option<&'static str>,
}

impl AgentProfile {
    const fn new(
        id: &'static str,
        native_conversations: bool,
        caller_env: Option<&'static str>,
        default_quota_provider: Option<&'static str>,
        subagents: bool,
        navigation: bool,
    ) -> Self {
        Self {
            id,
            capabilities: AgentCapabilities {
                native_conversations,
                live_activity: true,
                quota: default_quota_provider.is_some(),
                metadata_projection: true,
                timeline: true,
                caller_attribution: caller_env.is_some(),
                subagents,
                navigation,
                dispatch_defaults: true,
            },
            caller_env,
            default_quota_provider,
        }
    }
}

const PROFILES: &[AgentProfile] = &[
    AgentProfile::new(
        "antigravity",
        true,
        Some("ANTIGRAVITY_CONVERSATION_ID"),
        Some("antigravity"),
        true,
        false,
    ),
    AgentProfile::new(
        "claude",
        true,
        Some("CLAUDE_CODE_SESSION_ID"),
        Some("claude-code"),
        false,
        false,
    ),
    AgentProfile::new(
        "codex",
        true,
        Some("CODEX_THREAD_ID"),
        Some("codex"),
        true,
        true,
    ),
    AgentProfile::new("pi", true, Some("PI_SESSION_ID"), None, false, false),
    AgentProfile::new("cursor", false, None, Some("cursor"), false, false),
    AgentProfile::new("grok", false, None, Some("grok"), false, false),
    AgentProfile::new("kimi", false, None, Some("kimi-code"), false, false),
    AgentProfile::new("opencode", false, None, Some("opencode-go"), false, false),
];

pub(crate) fn for_agent(id: &str) -> AgentCapabilities {
    PROFILES
        .iter()
        .find(|profile| profile.id == id)
        .map(|profile| profile.capabilities)
        .unwrap_or(AgentProfile::new("", false, None, None, false, false).capabilities)
}

pub(crate) fn default_quota_provider(agent: &str) -> Option<&'static str> {
    PROFILES
        .iter()
        .find(|profile| profile.id == agent)?
        .default_quota_provider
}

pub(crate) fn caller_env_entries() -> impl Iterator<Item = (&'static str, &'static str)> {
    PROFILES
        .iter()
        .filter_map(|profile| Some((profile.id, profile.caller_env?)))
}
