//go:build arcfixture

package core

import (
	"context"
	"testing"
	"time"
)

func TestDeviceTunnelChallengeExpiresAfterUseAndSessionEndsOnRevocation(t *testing.T) {
	// Recurring bug class: security a signed challenge must be single-use and session tokens must expire when a controller is revoked.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	member, err := newDeviceManager(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	memberIdentity, err := loadDeviceIdentity(member.directory)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	member.enabled, member.identity = true, memberIdentity
	member.stored.Controller = &devicePeer{DeviceID: controller.id, PublicKey: controller.publicKey, Name: "Controller"}
	member.authority = func(context.Context, string, object) (any, error) { return nil, nil }
	if _, err := member.tunnelChallenge(memberIdentity.id); err == nil {
		t.Fatal("unpaired identity received a challenge")
	}
	challenge, err := member.tunnelChallenge(controller.id)
	if err != nil {
		t.Fatal(err)
	}
	nonce := text(challenge, "challenge")
	sig, err := controller.sign([]byte(deviceTunnelTranscript(memberIdentity.id, controller.id, nonce)))
	if err != nil {
		t.Fatal(err)
	}
	body := object{"deviceId": controller.id, "challenge": nonce, "signature": sig}
	session, err := member.tunnelAuthenticate(body)
	if err != nil {
		t.Fatal(err)
	}
	token := text(session, "token")
	device, err := member.tunnelDevice(token)
	if err != nil || device != controller.id {
		t.Fatalf("session did not retain its paired key: %v", err)
	}
	if _, err := member.tunnelAuthenticate(body); err == nil {
		t.Fatal("same challenge authenticated twice")
	}
	wait, stop := member.tunnelContext(ctx)
	defer stop()
	if _, err := member.revoke(ctx, controller.id); err != nil {
		t.Fatal(err)
	}
	if _, err := member.tunnelDevice(token); err == nil {
		t.Fatal("revoked controller retained its session")
	}
	select {
	case <-wait.Done():
	case <-time.After(time.Second):
		t.Fatal("revocation left the active tunnel context running")
	}
}
