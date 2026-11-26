//go:build arcfixture

package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openDeviceTunnelFixture(t *testing.T, directory string) (context.Context, *deviceManager, *deviceIdentity, *deviceTransferLink) {
	t.Helper()
	ctx := t.Context()
	member, err := newDeviceManager(ctx, filepath.Join(directory, "member"))
	if err != nil {
		t.Fatal(err)
	}
	memberIdentity, err := loadDeviceIdentity(member.directory)
	if err != nil {
		t.Fatal(err)
	}
	controllerIdentity, err := loadDeviceIdentity(filepath.Join(directory, "controller"))
	if err != nil {
		t.Fatal(err)
	}
	member.enabled, member.identity = true, memberIdentity
	member.stored.Controller = &devicePeer{DeviceID: controllerIdentity.id, PublicKey: controllerIdentity.publicKey, Name: "Fixture controller"}
	member.control = func(context.Context, string, object) (any, error) { return egressTool(object{}, false), nil }
	member.authority = func(context.Context, string, object) (any, error) { return nil, nil }
	t.Cleanup(member.transfers.close)
	app := &gatewayOwner{}
	deviceGateways.Store(app, member)
	t.Cleanup(func() { deviceGateways.Delete(app) })
	ingress := &networkIngress{id: "fixture", owner: app, running: true, entry: object{"transport": "https"}}
	t.Setenv("ARC_STATE_DIR", directory)
	address, err := listenHTTPSIngress(ingress, object{"httpsProvider": "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ingress.stop)
	remote := &deviceMember{peer: devicePeer{DeviceID: memberIdentity.id}, identity: controllerIdentity, status: deviceMemberStatus{online: true}}
	link := &deviceTransferLink{path: devicePreparedPath{tunnelURL: "http://" + address + "/arc-peer/3"}, member: remote}
	if err := link.refresh(ctx); err != nil {
		t.Fatal(err)
	}
	return ctx, member, controllerIdentity, link
}

func TestDeviceTunnelTransfersUseBoundedVerifiedRanges(t *testing.T) {
	// Contract: the public peer route issues a signed session and transfers independently verified ranges both ways.
	directory := t.TempDir()
	ctx, member, controllerIdentity, link := openDeviceTunnelFixture(t, directory)
	const tunnelRangeLimit = 64 * 1024
	if size := link.size(); size == 0 || size > tunnelRangeLimit {
		t.Fatalf("scheduled tunnel range has %d bytes, want 1 through %d", size, tunnelRangeLimit)
	}
	// Cross a range boundary and include a short tail. Each request has its own deadline.
	const transferBytes = tunnelRangeLimit + 17
	pattern := []byte("bounded transfer fixture\x00\xff")
	data := bytes.Repeat(pattern, (transferBytes+len(pattern)-1)/len(pattern))[:transferBytes]
	source, target := filepath.Join(directory, "source"), filepath.Join(directory, "target")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sz := uint64(len(data))
	sum := hash(data)
	up := id()
	if _, err := link.control(ctx, object{"action": "begin", "requestId": up, "spec": object{"path": target, "total": sz, "expectedSha256": sum}}); err != nil {
		t.Fatal(err)
	}
	if _, err := link.control(ctx, object{"action": "put", "requestId": up, "offset": 0,
		"data": base64.StdEncoding.EncodeToString(data[:1]), "sha256": hash(data[1:2])}); err == nil || managementErrorCode(err.Error()) != "SHA256_MISMATCH" {
		t.Fatalf("upload with a wrong range digest: %v", err)
	}
	for offset := uint64(0); offset < sz; {
		length := min(link.size(), sz-offset)
		result, err := link.upload(ctx, up, source, offset, length)
		if err != nil || uintOr(field(result, "offset"), 0) != offset+length {
			t.Fatalf("upload range at %d (%d bytes): %v (%v)", offset, length, result, err)
		}
		offset += length
	}
	if result, err := link.control(ctx, object{"action": "commit", "requestId": up}); err != nil || field(result, "sha256") != sum {
		t.Fatalf("commit upload: %v (%v)", result, err)
	}
	stamp, err := link.control(ctx, object{"action": "stat", "path": target})
	if err != nil {
		t.Fatal(err)
	}
	downloaded := filepath.Join(directory, "download")
	store := &deviceReceiverStore{}
	defer store.close()
	down := id()
	if _, err := store.begin(ctx, directory, down, object{"path": downloaded, "total": sz, "expectedSha256": sum}); err != nil {
		t.Fatal(err)
	}
	receiver, err := store.get(ctx, directory, down)
	if err != nil {
		t.Fatal(err)
	}
	for receiver.offset() < sz {
		offset := receiver.offset()
		length := min(link.size(), sz-offset)
		if err := link.download(ctx, down, target, stamp, receiver, length); err != nil || receiver.offset() != offset+length {
			t.Fatalf("download range at %d advanced to %d: %v", offset, receiver.offset(), err)
		}
	}
	if result, err := receiver.commit(); err != nil || field(result, "sha256") != sum {
		t.Fatalf("commit download: %v (%v)", result, err)
	}
	if got, err := os.ReadFile(downloaded); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("verified download changed the payload: %v", err)
	}
	if _, err := member.revoke(ctx, controllerIdentity.id); err != nil {
		t.Fatal(err)
	}
	if _, err := link.control(ctx, object{"action": "stat", "path": target}); err == nil || managementErrorCode(err.Error()) != "DEVICE_TUNNEL_AUTH" {
		t.Fatalf("revoked session could read transfer metadata: %v", err)
	}
}

func TestAuthenticatedTunnelRemainsAdmittedWithLANSlotsFull(t *testing.T) {
	// Recurring bug class: concurrency idle paired LAN channels must leave capacity for authenticated tunnel requests.
	ctx, member, controller, link := openDeviceTunnelFixture(t, t.TempDir())
	address, _ := pairedDeviceListener(t, ctx, member.identity, controller, member.servePeer)
	for range 8 {
		channel, failure := dialDeviceChannel(ctx, deviceClientTLS(controller, member.identity.id), address)
		if channel == nil {
			t.Fatalf("pinned LAN connection = %v", failure)
		}
		t.Cleanup(channel.close)
		if result, err := channel.request(ctx, deviceReadPath+"hello", object{"version": deviceProtocolVersion}, time.Second); err != nil ||
			field(result, "deviceId") != member.identity.id {
			t.Fatalf("pinned LAN hello = %v, %v", result, err)
		}
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	value, err := link.path.send(bounded, object{"version": deviceProtocolVersion, "tool": "query",
		"body": object{"op": "runtime_metrics", "args": object{}}, "origin": object{}}, 2*time.Second)
	if err != nil || field(value, "isError") == true || field(value, "content") == nil {
		t.Fatalf("tunnel with eight occupied LAN slots = %v, %v", value, err)
	}
}
