//go:build arcfixture

package core

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openDeviceTunnelFixture(t *testing.T, directory string) (context.Context, *deviceManager, *deviceIdentity, *deviceTransferLink) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
	t.Cleanup(cancel)
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
	data := bytes.Repeat([]byte("bounded transfer fixture"), 5200)
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
	for offset := uint64(0); offset < sz; {
		length := min(link.size(), sz-offset)
		result, err := link.upload(ctx, up, source, offset, length)
		offset += length
		if err != nil || uintOr(field(result, "offset"), 0) != offset {
			t.Fatalf("upload range: %v (%v)", result, err)
		}
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
		if err := link.download(ctx, down, target, stamp, receiver, min(link.size(), sz-receiver.offset())); err != nil {
			t.Fatal(err)
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
