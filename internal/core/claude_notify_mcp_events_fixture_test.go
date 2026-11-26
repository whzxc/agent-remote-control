//go:build arcfixture

package core

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestNotificationWebhookChallengeAndSubscriptionScopes(t *testing.T) {
	// Contract: the frozen notification methods verify the exact callback, bind the principal, and reject replay.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	const secret = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		at, err := strconv.ParseInt(r.Header.Get("webhook-timestamp"), 10, 64)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		id := r.Header.Get("webhook-id")
		signature, err := notificationSignature(secret, id, at, body)
		if err != nil || r.Header.Get("webhook-signature") != signature || !strings.HasPrefix(id, "msg_verification_") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var sent object
		if err := decodeObject(body, &sent); err != nil || sent["type"] != "verification" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, wire(object{"challenge": sent["challenge"]}))
	}))
	defer server.Close()
	t.Setenv("ARC_FIXTURE_WEBHOOK", server.URL+"/")
	old := notificationEventAuthorize
	t.Cleanup(func() { notificationEventAuthorize = old })
	notificationEventAuthorize = func(_ context.Context, _ *service, source requestSource, principal string) (requestSource, notificationEventAccess) {
		if principal == "owner" || principal == "other" {
			return source, notificationEventConnected
		}
		return source, notificationEventPrincipalRevoked
	}
	ctx := context.Background()
	s := &service{}
	source := requestSource{origin: object{"sourceId": "source", "eventPrincipal": "owner"}, policy: "all"}
	list, err := notificationEventsRequest(ctx, s, source, "events/list", nil)
	events := arr(list["events"])
	if err != nil || len(events) != 1 || field(events[0], "name") != "notification" {
		t.Fatalf("events = %v, %v", list, err)
	}
	args := object{"name": "notification", "arguments": object{"op": "task_status", "args": object{}},
		"delivery": object{"mode": "webhook", "url": server.URL + "/", "secret": secret}}
	sub, err := notificationEventsRequest(ctx, s, source, "events/subscribe", args)
	id := text(sub, "id")
	if err != nil || !strings.HasPrefix(id, "sub_") || sub["cursor"] != nil || sub["truncated"] != false {
		t.Fatalf("subscription = %v, %v", sub, err)
	}
	args["cursor"] = "old"
	if _, err := notificationEventsRequest(ctx, s, source, "events/subscribe", args); err == nil || field(mcpMethodFailure(err)["data"], "reason") != "replay_not_supported" {
		t.Fatalf("replay error = %v", err)
	}
	delete(args, "cursor")
	other := requestSource{origin: object{"sourceId": "source", "eventPrincipal": "other"}, policy: "all"}
	if _, err := notificationEventsRequest(ctx, s, other, "events/unsubscribe", args); err != nil {
		t.Fatal(err)
	}
	status, err := notificationStatus(ctx, operationRequest{args: object{"all": true}, source: source})
	if err != nil || find(field(status, "subscriptions"), "id", id) == nil {
		t.Fatalf("foreign unsubscribe affected owner = %v, %v", status, err)
	}
	if _, err := notificationEventsRequest(ctx, s, source, "events/unsubscribe", args); err != nil {
		t.Fatal(err)
	}
	status, err = notificationStatus(ctx, operationRequest{args: object{"all": true}, source: source})
	if err != nil || find(field(status, "subscriptions"), "id", id) != nil {
		t.Fatalf("unsubscribe readback = %v, %v", status, err)
	}
}
