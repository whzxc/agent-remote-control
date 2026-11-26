package core

import (
	"slices"
	"testing"
)

func TestClaudeAuthorizationDestination(t *testing.T) {
	// Recurring bug class: lifecycle Current Claude Code authorization links must progress interactive login.
	if claudeAuthorizationURL("https://claude.com/cai/oauth/authorize?client_id=fixture&state=fixture") == "" {
		t.Fatal("official authorization link rejected")
	}
}

func TestClaudeAuthorizationDestinationScope(t *testing.T) {
	// Algorithmic core: Accept authorization only for official HTTPS destinations, paths, and ports.
	for _, target := range []string{
		"https://claude.com.example.org/cai/oauth/authorize", "http://claude.com/cai/oauth/authorize",
		"https://user@claude.com/cai/oauth/authorize", "https://claude.com:444/cai/oauth/authorize", "https://claude.com/other",
	} {
		if claudeAuthorizationURL(target) != "" {
			t.Errorf("unrelated authorization target accepted: %s", target)
		}
	}
}

func TestClaudeHostKeychainNamespace(t *testing.T) {
	// Recurring bug class: persistence Preserve the host's configured Keychain namespace during native sign-in reads.
	if want := []string{"PATH=tools"}; !slices.Equal(isolatedClaudeEnvironment(want, ""), want) {
		t.Fatal("a default configuration was injected")
	}
	configured := []string{"CLAUDE_CONFIG_DIR=custom", "CLAUDE_SECURESTORAGE_CONFIG_DIR=vault"}
	if !slices.Equal(isolatedClaudeEnvironment(configured, ""), configured) || !slices.Equal(isolatedClaudeEnvironment(configured, "profile"), []string{"CLAUDE_CONFIG_DIR=profile"}) {
		t.Fatal("host storage namespace leaked into a managed profile")
	}
}

func TestClaudeProfileCredentialIsolation(t *testing.T) {
	// Algorithmic core: Managed child environments contain one profile location and no inherited credential override.
	source := []string{"CLAUDE_CONFIG_DIR=old", "claude_config_dir=other", "ANTHROPIC_API_KEY=secret", "CLAUDE_CODE_USE_VERTEX=1",
		"CLAUDE_CODE_HOST_CREDS_FILE=other-account", "CLAUDE_CODE_USE_GATEWAY=1", "PATH=tools"}
	for _, profile := range []string{"/profiles/a", "/profiles/b"} {
		if actual := isolatedClaudeEnvironment(source, profile); !slices.Equal(actual, []string{"PATH=tools", "CLAUDE_CONFIG_DIR=" + profile}) {
			t.Fatalf("unexpected isolated environment for %s", profile)
		}
	}
}
