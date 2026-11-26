package core

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestDeviceLinkLoadsRustIdentityAndPairingsInPlace(t *testing.T) {
	// Contract: Go reuses Rust's device keys, SPKI fingerprints, and persisted pairing records on an isolated upgrade.
	// The prebuilt Rust fixture generated and paired both identities through the
	// local device routes. Only the controller's advertised addresses were
	// replaced with a documentation address before checking in the capture.
	roles := []string{"member", "controller"}
	identities := make(map[string]*deviceIdentity)
	managers := make(map[string]*deviceManager)
	for _, role := range roles {
		directory := t.TempDir()
		fixture := make(map[string][]byte)
		for _, name := range []string{"identity.json", "peers.json"} {
			body, err := os.ReadFile(filepath.Join("testdata", "rust-device-link", role, name))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, name), body, 0o600); err != nil {
				t.Fatal(err)
			}
			fixture[name] = body
		}
		identity, err := loadDeviceIdentity(directory)
		if err != nil {
			t.Fatal(err)
		}
		manager, err := newDeviceManager(t.Context(), directory)
		if err != nil {
			t.Fatal(err)
		}
		if manager.stored.IdentityID == nil || identity.id != *manager.stored.IdentityID {
			t.Fatalf("%s: derived SPKI fingerprint %q differs from the ID persisted by Rust", role, identity.id)
		}
		for name, before := range fixture {
			after, err := os.ReadFile(filepath.Join(directory, name))
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("%s: loading %s changed its bytes: %v", role, name, err)
			}
		}
		if err := manager.persist(manager.stored); err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(filepath.Join(directory, "peers.json"))
		if err != nil || !bytes.Equal(fixture["peers.json"], after) {
			t.Fatalf("%s: persisting the loaded pairings changed Rust's JSON bytes: %v", role, err)
		}
		identities[role], managers[role] = identity, manager
	}
	controller, member := identities["controller"], identities["member"]
	pairedController := managers["member"].stored.Controller
	if pairedController == nil || pairedController.DeviceID != controller.id || pairedController.PublicKey != controller.publicKey {
		t.Fatal("Rust member pairing does not pin the controller's Go-derived SPKI")
	}
	pairedMember, found := managers["controller"].stored.Members[member.id]
	if !found || pairedMember.DeviceID != member.id || pairedMember.PublicKey != member.publicKey {
		t.Fatal("Rust controller pairing does not pin the member's Go-derived SPKI")
	}
}
