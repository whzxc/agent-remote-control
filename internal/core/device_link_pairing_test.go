//go:build arcfixture

package core

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newLoopbackPairingDevice(t *testing.T, ctx context.Context, directory string) *deviceManager {
	t.Helper()
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

func TestGoDevicePairingRequiresApprovalAndForwardsPinnedRequest(t *testing.T) {
	// Contract: arc-peer/3 consumes an offer only once and authorizes a private Core request under the approved controller identity.
	state := t.TempDir()
	t.Setenv("ARC_STATE_DIR", state)
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
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
	local := &service{metadata: object{"instance": id()}}
	defer local.codex.activity.close()
	defer local.taskRecords.codex.close()
	defer local.taskRecords.agent.close()
	defer closeReceiptIndex(coreReceiptStore().base)
	defer closeReceiptIndex(agentReceiptStore().base)
	core := newInProcess(local)
	listener, err := listenPrivate(ctx, "core", token, core, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	member := newLoopbackPairingDevice(t, ctx, filepath.Join(state, "device-link"))
	controller := newLoopbackPairingDevice(t, ctx, filepath.Join(t.TempDir(), "device-link"))
	owner := &gatewayOwner{bridge: &gatewayBridge{}}
	member.authority = func(ctx context.Context, op string, body object) (any, error) {
		return requestSourceAuthority(ctx, owner.bridge, op, body)
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
				snapshot, err := member.dispatch(ctx, "snapshot", object{})
				publicPending := field(snapshot, "pending")
				if err != nil || field(snapshot, "deviceId") != member.identity.id ||
					field(publicPending, "deviceId") != controller.identity.id || uintOr(field(publicPending, "expiresInSeconds"), 0) == 0 ||
					field(publicPending, "publicKey") != nil {
					t.Fatalf("pending Desktop snapshot = %s, %v", wire(snapshot), err)
				}
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
	if _, err := controller.dispatch(ctx, "address", object{"device": member.identity.id, "address": "member.example:7143"}); err != nil {
		t.Fatal(err)
	}
	updated := controller.snapshot()["members"].([]object)
	pairedController := member.snapshot()["controller"]
	if wire(updated[0]["addressOverride"]) != `"member.example:7143"` ||
		field(pairedController, "name") != controller.name() || field(pairedController, "publicKey") != nil {
		t.Fatalf("paired Desktop snapshots = %v, %v", updated, pairedController)
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
	request := id()
	origin := object{"sourceId": "upstream-fixture", "sourceLabel": "Fixture upstream", "controlSource": "custom"}
	act := func(op string, args object) (any, bool) {
		t.Helper()
		reply, err := channel.request(ctx, deviceReadPath+"request", object{"version": deviceProtocolVersion, "tool": "act",
			"body": object{"op": op, "args": args, "requestId": request}, "origin": origin}, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		value, err := egressToolValue(reply)
		if err != nil {
			t.Fatal(err)
		}
		return value, field(reply, "isError") == true
	}
	if value, failed := act("notice_post", object{"intent": "Fixture peer request", "resources": []any{"app:installed"}, "expectedDurationSeconds": 60}); failed {
		t.Fatalf("paired member write: %v", value)
	}
	receipt, failed := act("receipt", object{"requestId": request, "includeOrigin": true})
	ownerOrigin := field(receipt, "origin")
	source, err := pairedSourceAuthority(controller.identity.id, controller.identity.publicKey)
	if err != nil || field(source["credential"], "type") != "peer" || failed || field(receipt, "requestId") != request ||
		field(ownerOrigin, "sourceId") != source["id"] || field(ownerOrigin, "deviceId") != controller.identity.id || field(ownerOrigin, "authType") != "peer" ||
		field(field(ownerOrigin, "peerOrigin"), "sourceId") != origin["sourceId"] {
		t.Fatalf("peer receipt origin %v, authority error %v", receipt, err)
	}
	for _, unrelated := range []object{{"authType": "peer", "deviceId": "other-controller"}, {"authType": "local", "sourceId": "member-local"}} {
		foreign := id()
		if err := coreReceiptStore().reserve(ctx, object{"requestId": foreign, "backendSession": local.metadata["instance"],
			"state": "completed", "operation": "notice_post", "origin": unrelated}); err != nil {
			t.Fatal(err)
		}
		if value, failed := act("receipt", object{"requestId": foreign}); !failed || field(field(value, "error"), "code") != "DEVICE_TASK_NOT_VISIBLE" {
			t.Fatalf("foreign receipt escaped device authorization: %v", value)
		}
	}
	for _, show := range []bool{false, true, false} {
		if _, err := member.dispatch(ctx, "configure", object{"showUpstreamSources": show}); err != nil {
			t.Fatal(err)
		}
		controllerSnapshot := member.snapshot()["controller"]
		sources := decodedTaskList(field(controllerSnapshot, "upstreamSources"))
		found := find(sources, "sourceId", text(origin, "sourceId"))
		if field(controllerSnapshot, "showUpstreamSources") != show || show && found == nil || !show && len(sources) != 0 {
			t.Fatalf("upstream source visibility %v = %s", show, wire(controllerSnapshot))
		}
	}

	ownedTask, localTask := id(), id()
	for _, row := range []object{
		{"threadId": ownedTask, "origin": ownerOrigin},
		{"threadId": localTask, "origin": object{"authType": "local", "sourceId": "member-only"}},
	} {
		row["requestId"], row["backendSession"], row["state"], row["operation"] = id(), local.metadata["instance"], "completed", "send"
		if err := coreReceiptStore().reserve(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	storedPeer, err := loadDeviceStored(controller.directory)
	if err != nil {
		t.Fatal(err)
	}
	peerRow := storedPeer.Members[member.identity.id]
	remote := &deviceMember{peer: peerRow, ctx: ctx, identity: controller.identity, changed: make(chan struct{}), slots: make(chan struct{}, 8)}
	defer remote.heartbeat.close()
	defer remote.business.close()
	records, err := openDeviceRecords(controller.directory)
	if err != nil {
		t.Fatal(err)
	}
	address := sockets[0]
	bridgeController := &deviceController{ctx: ctx, directory: controller.directory, records: records,
		members:    map[string]*deviceMember{member.identity.id: remote},
		resolveLAN: func(context.Context, *deviceMember) ([]netip.AddrPort, error) { return []netip.AddrPort{address}, nil }}
	readActivity := object{"device": member.identity.id, "op": "task_activity", "args": object{}}
	bridgeController.heartbeat(ctx, remote, 0)
	reply, err = bridgeController.forward(ctx, "query", readActivity, nil, origin)
	value, decodeErr := egressToolValue(reply)
	activity := decodedTaskList(field(value, "records"))
	if err != nil || decodeErr != nil || field(reply, "isError") == true || len(activity) != 1 || field(activity[0], "threadId") != ownedTask ||
		len(decodedTaskList(field(value, "availableAgents"))) == 0 || uintOr(field(value, "omittedRecords"), 1) != 0 {
		t.Fatalf("member-local record escaped its inventory boundary: %s, %v, %v", wire(value), err, decodeErr)
	}
	if addressResult, err := controller.dispatch(ctx, "address", object{"device": member.identity.id, "address": address.String()}); err != nil ||
		wire(field(addressResult, "address")) != wire(address.String()) {
		t.Fatalf("controller address override readback = %s, %v", wire(addressResult), err)
	}
	remote.business.close()
	remote.heartbeat.close()
	address = closedPeerFixtureAddress(t)
	bridgeController.heartbeat(ctx, remote, 0)
	unsent := id()
	if len(decodedTaskList(bridgeController.list(false)["devices"])) != 0 {
		t.Fatal("offline member remained in the online inventory")
	}
	if _, err := bridgeController.forward(ctx, "act", object{"device": member.identity.id, "op": "notice_post", "args": object{}},
		unsent, origin); err == nil || managementErrorCode(err.Error()) != "DEVICE_OFFLINE" {
		t.Fatalf("offline write = %v", err)
	}
	if _, err := coreReceiptStore().read(unsent, text(local.metadata, "instance")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("offline write reached the member and created a receipt: %v", err)
	}
	address = sockets[0]
	bridgeController.heartbeat(ctx, remote, 0)
	if reply, err := bridgeController.forward(ctx, "query", readActivity, nil, origin); err != nil || reply["isError"] == true {
		t.Fatalf("member did not return online with its original authority: %s, %v", wire(reply), err)
	}

	if _, err := member.dispatch(ctx, "revoke", object{"deviceId": controller.identity.id}); err != nil {
		t.Fatal(err)
	}
	if _, err := channel.request(ctx, deviceReadPath+"request", object{"version": deviceProtocolVersion,
		"tool": "query", "body": object{"op": "guide", "args": object{}}, "origin": object{}}, time.Second); err == nil {
		t.Fatal("revoked controller kept its live peer channel")
	}
	if _, err := pairedSourceAuthority(controller.identity.id, controller.identity.publicKey); err == nil ||
		managementErrorCode(err.Error()) != "DEVICE_UNPAIRED" {
		t.Fatalf("revoked peer source = %v", err)
	}
	reopened, err := newDeviceManager(ctx, controller.directory)
	if err != nil {
		t.Fatal(err)
	}
	reopened.enabled, reopened.identity = true, controller.identity
	if result, err := reopened.dispatch(ctx, "revoke", object{"deviceId": member.identity.id}); err != nil || field(result, "revoked") != true {
		t.Fatalf("reopened controller did not revoke persisted member: %s, %v", wire(result), err)
	}
	if err := member.reconcile(false); err != nil {
		t.Fatal(err)
	}
	if _, err := member.dispatch(ctx, "offer", object{}); err == nil || managementErrorCode(err.Error()) != "OP_UNAVAILABLE" {
		t.Fatalf("disabled member admitted a new offer: %v", err)
	}
	if err := member.reconcile(true); err != nil || member.snapshot()["deviceId"] != members[0]["deviceId"] {
		t.Fatalf("device reenable lost the approved identity: %s, %v", wire(member.snapshot()), err)
	}
}

func TestAuthenticatedPairingRequiresLocalApprovalAfterDecline(t *testing.T) {
	// Recurring bug class: security an authenticated but declined pairing cannot reuse its consumed offer.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	member := newLoopbackPairingDevice(t, ctx, t.TempDir())
	controller := newLoopbackPairingDevice(t, ctx, t.TempDir())
	member.authority = func(context.Context, string, object) (any, error) {
		return nil, errors.New("local approval required")
	}
	offer, err := member.dispatch(ctx, "offer", object{})
	if err != nil {
		t.Fatal(err)
	}
	request := object{"pairingString": field(offer, "pairingString")}
	done := make(chan error, 1)
	go func() {
		_, err := controller.dispatch(ctx, "pair", request)
		done <- err
	}()
	for {
		snapshot := member.snapshot()
		if field(snapshot["pending"], "deviceId") == controller.identity.id {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("offer ended before its local decision: %v", err)
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("authenticated pairing did not enter local approval")
		}
	}
	if result, err := member.dispatch(ctx, "decline", object{}); err != nil || field(result, "declined") != true ||
		field(result, "deviceId") != controller.identity.id {
		t.Fatalf("local decline = %s, %v", wire(result), err)
	}
	select {
	case err := <-done:
		if err == nil || managementErrorCode(err.Error()) != "DEVICE_PAIRING_DECLINED" {
			t.Fatalf("controller received the wrong decline result: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("local decline did not reach the controller")
	}
	if _, err := controller.dispatch(ctx, "pair", request); err == nil || member.snapshot()["controller"] != nil || member.snapshot()["pending"] != nil {
		t.Fatalf("declined device reused the one-time offer: %v", err)
	}
}

func TestCancelledPairingCannotApplyALateApproval(t *testing.T) {
	// Recurring bug class: concurrency cancellation must invalidate a consumed offer before local approval can create a pairing.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	member := newLoopbackPairingDevice(t, ctx, t.TempDir())
	controller := newLoopbackPairingDevice(t, ctx, t.TempDir())
	member.authority = func(context.Context, string, object) (any, error) {
		t.Error("cancelled pairing attempted to create a peer source")
		return nil, nil
	}
	offer, err := member.offer()
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := controller.dispatch(ctx, "pair", object{"pairingString": offer["pairingString"]})
		result <- err
	}()
	waitForPending := func(want bool) {
		t.Helper()
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			value, err := member.dispatch(ctx, "pending", object{})
			if err != nil {
				t.Fatal(err)
			}
			if (field(value, "pending") != nil) == want {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("member did not reach the expected pairing state")
			case <-tick.C:
			}
		}
	}
	waitForPending(true)
	if _, err := controller.dispatch(ctx, "cancel-pair", object{}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil || !strings.HasPrefix(err.Error(), "DEVICE_PAIRING_CANCELLED:") {
			t.Fatalf("pairing cancellation: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	waitForPending(false)
	if _, err := member.dispatch(ctx, "approve", object{}); err == nil || member.snapshot()["controller"] != nil {
		t.Fatalf("late approval created a pairing: %v", err)
	}
}

func TestDevicePairingRejectsAThreeDeviceCycleBeforeApproval(t *testing.T) {
	// Recurring bug class: security a descendant cannot become its root's controller.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	root := newLoopbackPairingDevice(t, ctx, t.TempDir())
	middle := newLoopbackPairingDevice(t, ctx, t.TempDir())
	leaf := newLoopbackPairingDevice(t, ctx, t.TempDir())
	link := func(controller, member *deviceManager) {
		t.Helper()
		memberOffer, err := member.offer()
		if err != nil {
			t.Fatal(err)
		}
		offer, err := decodeDeviceOffer(text(memberOffer, "pairingString"), netip.Addr.IsLoopback)
		if err != nil {
			t.Fatal(err)
		}
		controller.mu.Lock()
		controller.stored.Members[member.identity.id] = devicePeer{DeviceID: member.identity.id, PublicKey: member.identity.publicKey, Name: "Fixture member", Addresses: offer.Addresses}
		controller.mu.Unlock()
		member.mu.Lock()
		member.stored.Controller = &devicePeer{DeviceID: controller.identity.id, PublicKey: controller.identity.publicKey}
		member.mu.Unlock()
	}
	link(root, middle)
	link(middle, leaf)
	rootOffer, err := root.offer()
	if err != nil {
		t.Fatal(err)
	}
	_, err = leaf.dispatch(ctx, "pair", object{"pairingString": rootOffer["pairingString"]})
	if err == nil || managementErrorCode(err.Error()) != "DEVICE_PAIRING_CYCLE" {
		t.Fatalf("descendant pairing returned %v", err)
	}
	pending, err := root.dispatch(ctx, "pending", object{})
	if err != nil || field(pending, "pending") != nil {
		t.Fatalf("cycle reached approval: %v, %v", pending, err)
	}
}
