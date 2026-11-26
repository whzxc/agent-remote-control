package core

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
)

func TestRelaySignatureBindsOriginChallengeAndExactPayload(t *testing.T) {
	// Contract: arc-relay-v1 requires Ed25519 over the origin, challenge and exact canonical payload hash.
	data, err := generateRelayIdentity()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := loadRelayIdentity(data)
	if err != nil {
		t.Fatal(err)
	}
	e := identity.envelope("https://relay.example", "nonce", object{"op": "list"})
	sig, err := base64.StdEncoding.DecodeString(text(e, "signature"))
	if err != nil {
		t.Fatal(err)
	}
	public, err := base64.StdEncoding.DecodeString(text(e, "publicKey"))
	if err != nil {
		t.Fatal(err)
	}
	message := "arc-relay-v1\nhttps://relay.example\nnonce\n" + hash([]byte(text(e, "payload")))
	if !ed25519.Verify(public, []byte(message), sig) || identity.id() != hash(public) {
		t.Fatal("relay verification failed")
	}
	if ed25519.Verify(public, []byte(strings.Replace(message, "nonce", "other", 1)), sig) {
		t.Fatal("accepted a signature for a different challenge")
	}
}

func TestRelayLinkBindsOriginAndKeepsTokenInFragment(t *testing.T) {
	// Algorithmic core: an invitation embeds its credentials in the fragment and binds the relay origin.
	token := base64.StdEncoding.EncodeToString(make([]byte, 32))
	original := relayShareLink("https://relay.example", token)
	u, key, err := relayParseLink(original)
	if err != nil || u != "https://relay.example" || key != token {
		t.Fatalf("relay link did not round-trip: %s %v", u, err)
	}
	if _, _, err := relayParseLink(strings.Replace(original, "relay.example", "other.example", 1)); err == nil {
		t.Fatal("accepted an invitation on a different relay origin")
	}
	for _, url := range []string{"http://relay.example", "https://user@relay.example", "https://relay.example/path", "https://relay.example/?secret=x"} {
		if _, err := relayOrigin(url); err == nil {
			t.Fatalf("accepted invalid relay origin %s", url)
		}
	}
}
