package core

import (
	"path/filepath"
	"testing"
)

func TestPrimaryCodexHomeDoesNotInheritManagedProfiles(t *testing.T) {
	// Recurring bug class: persistence An inherited managed credential directory cannot select the native session home.
	profiles := filepath.FromSlash("/state/accounts/codex/profiles")
	managed := filepath.Join(profiles, "00000000-0000-4000-8000-000000000001/home")
	other := filepath.FromSlash("/other-state/accounts/codex/profiles/00000000-0000-4000-8000-000000000002/home")
	user := filepath.FromSlash("/user")
	custom := filepath.FromSlash("/custom-codex")
	for _, tc := range []struct {
		configured *string
		want       string
	}{
		{&managed, filepath.Join(user, ".codex")},
		{&other, filepath.Join(user, ".codex")},
		{&custom, custom},
		{nil, filepath.Join(user, ".codex")},
	} {
		got, ok := primaryCodexHome(tc.configured, profiles, &user)
		if !ok || got != tc.want {
			t.Fatalf("primary home = %q, want %q", got, tc.want)
		}
	}
}
