//go:build arcfixture

package core

import (
	"context"
	"net"
	"net/netip"
	"path/filepath"
	"testing"
	"time"
)

func TestGoDevicePairingRequiresApprovalAndForwardsPinnedRequest(t *testing.T) {
	// Contract: arc-peer/3 consumes an offer only once and authorizes a private Core request under the approved controller identity.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	_, err := changePreferences(object{"values": object{"device-link": "on"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	local := &service{}
	core := newInProcess(local)
	listener, err := listenPrivate(ctx, "core", token, core, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	newFixture := func(directory string) *deviceManager {
		m, err := newDeviceManager(ctx, directory)
		if err != nil {
			t.Fatal(err)
		}
		address, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatal(err)
		}
		m.stored.Port = uint16(address.Addr().(*net.TCPAddr).Port)
		address.Close()
		m.allow = netip.Addr.IsLoopback
		m.bindings = func(port uint16) ([]deviceLANBinding, error) {
			return []deviceLANBinding{{addr: netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)}}, nil
		}
		m.dialAddresses = func(inputs []string) ([]netip.AddrPort, error) {
			return deviceScopeAddresses(inputs, nil, netip.Addr.IsLoopback)
		}
		m.discovery = func(*deviceIdentity, uint16, []deviceLANBinding) (func(), error) { return func() {}, nil }
		if err := m.reconcile(true); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = m.reconcile(false) })
		return m
	}
	member := newFixture(filepath.Join(state, "device-link"))
	controller := newFixture(filepath.Join(t.TempDir(), "device-link"))
	owner := &gatewayOwner{bridge: &gatewayBridge{}}
	prev := deviceCorePeerSource
	t.Cleanup(func() { deviceCorePeerSource = prev })
	deviceCorePeerSource = func(_ context.Context, id, key string, _ bool) (requestSource, error) {
		if id != controller.identity.id || key != controller.identity.publicKey {
			return requestSource{}, context.Canceled
		}
		return requestSource{origin: object{"deviceId": id, "authType": "peer", "sourceId": "approved-controller", "controlSource": "custom"}, policy: "all"}, nil
	}
	member.authority = func(_ context.Context, op string, body object) (any, error) {
		if op != "peer_connect" || body["deviceId"] != controller.identity.id || body["publicKey"] != controller.identity.publicKey {
			return nil, context.Canceled
		}
		return object{}, nil
	}
	member.control = func(ctx context.Context, id string, body object) (any, error) {
		return owner.bridge.call(ctx, newPrivateRequest(ctx, "PeerControl", object{"Peer": privatePeerAuthority{DeviceID: id}}, body))
	}
	offer, err := member.offer()
	if err != nil {
		t.Fatal(err)
	}
	type pairResult struct {
		output any
		err    error
	}
	paired := make(chan pairResult, 1)
	go func() {
		output, err := controller.dispatch(ctx, "pair", object{"pairingString": offer["pairingString"]})
		paired <- pairResult{output, err}
	}()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
wait:
	for {
		select {
		case result := <-paired:
			t.Fatalf("pairing ended before local approval: %v", result.err)
		case <-ctx.Done():
			t.Fatal("controller did not prove the offer before timeout")
		case <-tick.C:
			pending, err := member.dispatch(ctx, "pending", object{})
			if err != nil {
				t.Fatal(err)
			}
			if field(field(pending, "pending"), "deviceId") == controller.identity.id {
				break wait
			}
		}
	}
	if _, err := member.decide(ctx, true); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-paired:
		if result.err != nil || field(result.output, "paired") != true || field(result.output, "deviceId") != member.identity.id {
			t.Fatalf("approval did not complete pairing: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	snapshot := controller.snapshot()
	members := snapshot["members"].([]object)
	if len(members) != 1 || members[0]["deviceId"] != member.identity.id {
		t.Fatalf("controller did not retain the approved member: %v", members)
	}

	sockets, err := controller.dialAddresses(members[0]["addresses"].([]string))
	if err != nil {
		t.Fatal(err)
	}
	var session deviceSession
	defer session.close()
	channel, err := session.connect(ctx, controller.identity, member.identity.id, sockets)
	if err != nil {
		t.Fatal(err)
	}
	reply, err := channel.request(ctx, deviceReadPath+"request", object{
		"version": deviceProtocolVersion, "tool": "query", "body": object{"op": "guide", "args": object{}},
		"origin": object{"sourceId": "untrusted-upstream", "deviceId": "forged"},
	}, time.Second)
	if err != nil || field(reply, "isError") == true {
		t.Fatalf("approved peer did not reach Core: %v", err)
	}
	if value, err := egressToolValue(reply); err != nil || field(value, "arcVersion") == nil {
		t.Fatalf("peer guide wire reply is invalid: %v", err)
	}
	if _, err := channel.request(ctx, deviceReadPath+"request", object{
		"version": deviceProtocolVersion, "tool": "query", "body": object{"op": "devices", "args": object{}}, "origin": object{},
	}, time.Second); err == nil || managementErrorCode(err.Error()) != "DEVICE_PEER_FORBIDDEN" {
		t.Fatalf("peer Device link call escaped the member boundary: %v", err)
	}
}
