//go:build arcfixture

package core

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestRelayMemberLeavesOnlyWhenBothWorkerRoutesAreGone(t *testing.T) {
	// Recurring bug class: lifecycle disconnected relay members can remove local ingress state only after both routes confirm deletion.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	token, err := ensureFrontDoorSecret()
	if err != nil {
		t.Fatal(err)
	}
	ipc, err := listenPrivate(ctx, "core", token, newInProcess(&service{}), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()
	closeGateway, err := startFixtureIngressGateway(ctx, token, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeGateway()
	var public, challenge atomic.Int32
	public.Store(200)
	challenge.Store(404)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.WriteHeader(int(public.Load()))
		} else {
			w.WriteHeader(int(challenge.Load()))
		}
	}))
	defer worker.Close()
	// Save the same local membership record used when leaving an unavailable worker.
	relay, ingress := id(), id()
	if err := saveRelay(object{"id": relay, "url": worker.URL, "owner": false, "ingressId": ingress}); err != nil {
		t.Fatal(err)
	}
	if _, err := gatewayRequest(ctx, "ingress", http.MethodPost, object{
		"id": ingress, "name": "Relay fixture", "controlSource": "shared-relay", "transport": "relay", "auth": "oauth", "enabled": false,
		"config": object{"relayUrl": "https://relay.example", "relayInstanceId": hash([]byte("fixture"))},
	}); err != nil {
		t.Fatal(err)
	}
	leave := func() (any, error) { return gatewayRequest(ctx, "relay/leave", http.MethodPost, object{"id": relay}) }
	if result, err := leave(); err == nil {
		t.Fatalf("live Worker was removed: %v", result)
	}
	public.Store(404)
	challenge.Store(403)
	if result, err := leave(); err == nil {
		t.Fatalf("forbidden Worker was removed: %v", result)
	}
	if _, err := gatewayRequest(ctx, "ingress/"+ingress, http.MethodGet, nil); err != nil {
		t.Fatal(err)
	}
	challenge.Store(404)
	if result, err := leave(); err != nil || field(result, "left") != true {
		t.Fatalf("removed Worker retained membership: %v (%v)", result, err)
	}
	if result, err := gatewayRequest(ctx, "relay/list", http.MethodGet, nil); err != nil || len(arr(field(result, "relays"))) != 0 {
		t.Fatalf("relay membership retained: %v (%v)", result, err)
	}
	if _, err := gatewayRequest(ctx, "ingress/"+ingress, http.MethodGet, nil); err == nil {
		t.Fatal("the removed membership left its ingress behind")
	}
}

func TestRelayRetryReusesOnlyAnUndeployedDraft(t *testing.T) {
	// Recurring bug class: retry-replay cancelled Worker deploys must reuse the draft identity without replacing an existing deployment.
	initial, err := relayDraft(nil, object{"name": "Initial"})
	if err != nil || !relayUndeployed(initial) {
		t.Fatalf("new draft %v: %v", initial, err)
	}
	retry, err := relayDraft(clone(initial), object{"name": "Retry"})
	if err != nil || retry["id"] != initial["id"] || retry["workerName"] != initial["workerName"] || retry["name"] != "Retry" {
		t.Fatalf("retried draft %v: %v", retry, err)
	}
	for key, value := range (object{"deploymentStarted": true, "owner": false, "deleted": true, "url": "https://relay.example", "ingressId": "configured"}) {
		used := clone(initial)
		used[key] = value
		if relayUndeployed(used) {
			t.Fatalf("retry replaced a relay with %s=%v", key, value)
		}
	}
}
