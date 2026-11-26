package core

import (
	"strings"
	"testing"
)

func TestPackageIsolatedIdentity(t *testing.T) {
	// Recurring bug class: security Restrict a copied package to the selected isolated bundle identity.
	instance, other := "abc123def456", "other1234567"
	identifier := packageDevIdentifier + ".acceptance-" + instance
	if !packageIdentifierAllowed(identifier, &instance) || packageIdentifierAllowed(identifier, nil) ||
		packageIdentifierAllowed(identifier, &other) || packageIdentifierAllowed(packageIdentifier, &instance) ||
		packageIdentifierAllowed(packageDevIdentifier, &instance) {
		t.Fatal("unexpected isolated bundle authority")
	}
}

func TestPackageIdentityProfiles(t *testing.T) {
	// Algorithmic core: Validate official and isolated bundle identifiers.
	if !packageIdentifierAllowed(packageIdentifier, nil) || !packageIdentifierAllowed(packageDevIdentifier, nil) ||
		packageIdentifierAllowed("com.example.unrelated", nil) {
		t.Fatal("unexpected ordinary bundle authority")
	}
	for _, instance := range []string{"", "short", "UPPERCASE1", "abc-12345", "../abc1234", strings.Repeat("a", 33)} {
		if packageIdentifierAllowed(packageDevIdentifier+".acceptance-"+instance, &instance) {
			t.Fatalf("invalid instance accepted: %q", instance)
		}
	}
}
