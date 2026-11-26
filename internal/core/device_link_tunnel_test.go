//go:build arcfixture

package core

import (
	"context"
	"net"
	"net/netip"
	"strings"
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

func TestDeviceTunnelWaitBoundsKeepTheOriginalRequestID(t *testing.T) {
	// Contract: peer requests use bounded tunnel waits without changing the original receipt identity.
	const requestID = "fixture-original"
	request := object{"op": "codex_wait", "requestId": requestID, "args": object{"timeoutMs": 120_000}}
	if err := deviceValidateTunnelWait(object{"body": request}); err == nil || managementErrorCode(err.Error()) != "DEVICE_TUNNEL_LIMIT" {
		t.Fatalf("oversized tunnel wait: %v", err)
	}
	deviceTuneForTunnel(request)
	if request["requestId"] != requestID || uintOr(field(request["args"], "timeoutMs"), 0) != 15000 {
		t.Fatalf("bounded tunnel request: %v", request)
	}
	if err := deviceValidateTunnelWait(object{"body": request}); err != nil {
		t.Fatal(err)
	}
}

func TestPeerTunnelRejectsOversizedBodiesAndBoundsChallenges(t *testing.T) {
	// Contract: authenticated peer tunnels cap JSON bodies and concurrent challenges.
	ctx, manager, identity, link := openDeviceTunnelFixture(t, t.TempDir())
	const route = "challenge"
	body := object{"version": deviceProtocolVersion, "deviceId": identity.id}
	for range deviceTunnelAuthCap {
		if _, err := devicePostTunnel(ctx, link.path.tunnelURL, route, "", body, time.Second); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := devicePostTunnel(ctx, link.path.tunnelURL, route, "", body, time.Second); err == nil ||
		managementErrorCode(err.Error()) != "DEVICE_BUSY" {
		t.Fatalf("unexpected tunnel admission result: %v", err)
	}
	if _, err := devicePostTunnel(ctx, link.path.tunnelURL, "request", link.path.token,
		object{"version": deviceProtocolVersion, "body": strings.Repeat("x", deviceTunnelRequestCap)}, time.Second); err == nil ||
		managementErrorCode(err.Error()) != "DEVICE_TUNNEL_LIMIT" {
		t.Fatalf("oversized peer request result: %v", err)
	}
	if _, err := manager.revoke(ctx, identity.id); err != nil {
		t.Fatal(err)
	}
}

func TestRefusedPeerAddressDoesNotWaitForHeartbeat(t *testing.T) {
	// Recurring bug class: lifecycle definitive LAN refusal must reach the caller without waiting for the heartbeat retry bound.
	identity, err := loadDeviceIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	address := socket.Addr().(*net.TCPAddr).AddrPort()
	socket.Close()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, err := (&deviceSession{}).connect(ctx, identity, identity.id, []netip.AddrPort{address, address}); err == nil ||
		ctx.Err() != nil || managementErrorCode(err.Error()) != "DEVICE_CONNECTION_REFUSED" {
		t.Fatalf("refused peer address result: %v", err)
	}
}
