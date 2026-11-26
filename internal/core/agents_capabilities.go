package core

type agentCapabilities struct {
	NativeConversations bool `json:"nativeConversations"`
	LiveActivity        bool `json:"liveActivity"`
	Quota               bool `json:"quota"`
	MetadataProjection  bool `json:"metadataProjection"`
	Timeline            bool `json:"timeline"`
	CallerAttribution   bool `json:"callerAttribution"`
	Subagents           bool `json:"subagents"`
	Navigation          bool `json:"navigation"`
	DispatchDefaults    bool `json:"dispatchDefaults"`
}

type agentProfile struct {
	id, callerEnv, quotaProvider  string
	native, subagents, navigation bool
}

var agentProfiles = []agentProfile{
	{"antigravity", "ANTIGRAVITY_CONVERSATION_ID", "antigravity", true, true, false},
	{"claude", "CLAUDE_CODE_SESSION_ID", "claude-code", true, false, false},
	{"codex", "CODEX_THREAD_ID", "codex", true, true, true},
	{"pi", "PI_SESSION_ID", "", true, false, false},
	{"cursor", "", "cursor", false, false, false},
	{"grok", "", "grok", false, false, false},
	{"kimi", "", "kimi-code", false, false, false},
	{"opencode", "", "opencode-go", false, false, false},
}

func knownAgentProfile(id string) agentProfile {
	for _, profile := range agentProfiles {
		if profile.id == id {
			return profile
		}
	}
	return agentProfile{}
}

func capabilitiesForAgent(id string) agentCapabilities {
	profile := knownAgentProfile(id)
	return agentCapabilities{NativeConversations: profile.native, LiveActivity: true, Quota: profile.quotaProvider != "",
		MetadataProjection: true, Timeline: true, CallerAttribution: profile.callerEnv != "", Subagents: profile.subagents,
		Navigation: profile.navigation, DispatchDefaults: true}
}

func defaultAgentQuotaProvider(id string) string {
	return knownAgentProfile(id).quotaProvider
}
