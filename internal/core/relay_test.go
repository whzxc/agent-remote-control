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
	// The Worker runs on loopback. Keep the fixture independent of system proxy discovery.
	if _, err := managementCall(ctx, "network.set", object{"body": object{"proxyMode": "direct", "proxyUrl": ""}}); err != nil {
		t.Fatal(err)
	}
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

func TestRelayCancellationRetainsDraftRecovery(t *testing.T) {
	// Recurring bug class: lifecycle cancelling a deployment waits for job teardown and retains recovery without its login link.
	jobCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	job := &relayJob{cancel: cancel, done: done, status: object{
		"phase": "connecting", "relayId": "saved", "ingressId": "local", "loginUrl": "https://relay.invalid",
	}}
	released := make(chan struct{})
	releasedClosed := false
	defer func() {
		cancel()
		if !releasedClosed {
			close(released)
		}
		<-done
	}()
	go func() {
		<-jobCtx.Done()
		<-released
		close(done)
	}()
	manager := &relayManager{job: job}
	cancelled := make(chan string, 1)
	go func() { cancelled <- manager.cancel() }()
	select {
	case <-jobCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("relay job did not receive cancellation")
	}
	select {
	case <-cancelled:
		t.Fatal("cancel returned before deployment finished")
	default:
	}
	close(released)
	releasedClosed = true
	if ingress := <-cancelled; ingress != "local" {
		t.Fatalf("cancel lost the current ingress: %s", ingress)
	}
	result := job.snapshot()
	if result["phase"] != "failed" || result["cancelled"] != true || result["relayId"] != "saved" || result["loginUrl"] != nil {
		t.Fatalf("relay job lost recovery after cancellation: %v", result)
	}
}

func TestRelayManagementRequiresLocalAuthority(t *testing.T) {
	// Contract: relay management operations are local-only and use the existing CLI body schema.
	for name, body := range map[string]object{
		"relay.create": {},
		"relay.join":   {"link": "https://example.invalid/#arc-relay=example"},
		"relay.remove": {"id": "00000000-0000-4000-8000-000000000001", "instanceId": hash([]byte("fixture"))},
	} {
		route, method, _, err := managementResolve(name, object{"body": body})
		entry := find(managementCatalog()["operations"], "name", name)
		if err != nil || method != http.MethodPost || entry["localOnly"] != true || route != text(entry, "route") {
			t.Fatalf("%s management shape was %s %s: %v", name, method, route, err)
		}
	}
	if _, _, _, err := managementResolve("relay.remove", object{"body": object{"id": "../escape"}}); err == nil {
		t.Fatal("relay management accepted an invalid removal")
	}
}
