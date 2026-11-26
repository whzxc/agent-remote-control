//go:build arcfixture

package core

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type peerTunnelTestClient struct{}

func init() {
	doDeviceTunnelRequest = func(client *http.Client, request *http.Request) (*http.Response, error) {
		if fixture, ok := request.Context().Value(peerTunnelTestClient{}).(*http.Client); ok {
			client = fixture
		}
		return client.Do(request)
	}
}

func TestSlowPeerTunnelKeepsLivenessAndYieldsImmediatelyToLAN(t *testing.T) {
	// Recurring bug class: lifecycle slow tunnel heartbeats must retain liveness and never block healthy LAN recovery.
	base := t.TempDir()
	ctx, manager, identity, _ := openDeviceTunnelFixture(t, base)
	requestHeld, release := make(chan struct{}), make(chan struct{})
	var holdRequest atomic.Bool
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case deviceReadPath + "hello":
			select {
			case <-time.After(2500 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		case deviceReadPath + "request":
			if holdRequest.Load() {
				close(requestHeld)
				select {
				case <-release:
					http.Error(w, "fixture lost the tunnel response", http.StatusBadGateway)
				case <-r.Context().Done():
				}
				return
			}
		}
		result, err := manager.serveTunnel(w, r)
		if err != nil {
			httpReply(w, http.StatusOK, object{"ok": false, "error": object{"code": managementErrorCode(err.Error()), "message": err.Error()}})
			return
		}
		httpReply(w, http.StatusOK, object{"ok": true, "result": result})
	}))
	defer provider.Close()
	url := provider.URL + "/arc-peer/3"
	manager.tunnelURL = func() *string { return &url }
	ctx = context.WithValue(ctx, peerTunnelTestClient{}, provider.Client())
	liveAddress := closedPeerFixtureAddress(t)

	peer := &deviceMember{peer: devicePeer{DeviceID: manager.identity.id, Name: "Fixture member", TunnelURL: &url},
		identity: identity, ctx: ctx, slots: make(chan struct{}, 8), changed: make(chan struct{})}
	defer peer.business.close()
	defer peer.heartbeat.close()
	directory := filepath.Join(base, "controller")
	records, err := openDeviceRecords(directory)
	if err != nil {
		t.Fatal(err)
	}
	controller := &deviceController{ctx: ctx, directory: directory, members: map[string]*deviceMember{peer.peer.DeviceID: peer}, records: records}
	controller.resolveLAN = func(context.Context, *deviceMember) ([]netip.AddrPort, error) {
		return []netip.AddrPort{liveAddress}, nil
	}
	assertPath := func(want string) {
		t.Helper()
		rows := decodedTaskList(controller.list(false)["devices"])
		if len(rows) != 1 || field(rows[0], "state") != "online" || field(rows[0], "path") != want {
			t.Fatalf("member state on %s = %s", want, wire(controller.list(true)))
		}
	}
	for range 2 {
		if missed := controller.heartbeat(ctx, peer, 0); missed != 0 {
			t.Fatalf("slow tunnel missed its heartbeat: %s", wire(controller.list(true)))
		}
		assertPath("tunnel")
	}
	request := object{"device": peer.peer.DeviceID, "op": "guide", "args": object{}}
	holdRequest.Store(true)
	done := make(chan error, 1)
	go func() {
		_, err := controller.forward(ctx, "query", request, nil, object{})
		done <- err
		close(done)
	}()
	defer func() { close(release); <-done }()
	select {
	case <-requestHeld:
	case <-ctx.Done():
		t.Fatal("tunnel did not accept the in-flight read")
	}
	var stopLAN func()
	liveAddress, stopLAN = pairedDeviceListener(t, ctx, manager.identity, identity, manager.servePeer)
	short, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	controller.heartbeat(short, peer, 0)
	if short.Err() != nil {
		t.Fatal("LAN recovery waited for the slow tunnel hello")
	}
	assertPath("lan")
	// Stop holding the tunnel response while subsequent reads use LAN.
	holdRequest.Store(false)
	select {
	case release <- struct{}{}:
	case <-ctx.Done():
		t.Fatal("held tunnel request ended before the LAN recovery assertion")
	}
	if err := <-done; err == nil || managementErrorCode(err.Error()) != "DEVICE_RESPONSE_LOST" {
		t.Fatalf("in-flight tunnel read unexpectedly changed paths: %v", err)
	}
	if result, err := controller.forward(ctx, "query", request, nil, object{}); err != nil || result["isError"] == true {
		t.Fatalf("new read did not use the recovered LAN channel: %s, %v", wire(result), err)
	}
	stopLAN()
	provider.Close()
	bounded, finish := context.WithTimeout(ctx, 5*time.Second)
	defer finish()
	controller.heartbeat(bounded, peer, 0)
	if bounded.Err() != nil || len(decodedTaskList(controller.list(false)["devices"])) != 0 {
		t.Fatalf("losing LAN and the tunnel did not mark the member offline: %s", wire(controller.list(true)))
	}
}

func closedPeerFixtureAddress(t *testing.T) netip.AddrPort {
	t.Helper()
	socket, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	return socket.Addr().(*net.TCPAddr).AddrPort()
}
