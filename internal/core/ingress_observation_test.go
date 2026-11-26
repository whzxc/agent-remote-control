package core

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIngressObservationCorrelatesRequestsWithoutRetainingContent(t *testing.T) {
	// Recurring bug class: security request observations must correlate types and safe metadata without retaining credentials or request content.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	req := httptest.NewRequest("POST", "http://127.0.0.1/oauth/register?state=hidden-query", nil)
	req.Header.Set("Authorization", "Bearer hidden-authorization")
	req.Header.Set("CF-Ray", "abcdef0123456789-SJC")
	trace := observeIngressRequest(&networkIngress{id: "wire"}, "wire-connection", req)
	trace.oauthClient("hidden-client")
	trace.oauthFields("/oauth/register", "body", object{
		"client_name": "hidden-name", "user": object{"name": "hidden-profile", "email": "hidden-address"},
		"modes": []any{"hidden-one", "hidden-two", "hidden-three", "hidden-four"},
	})
	log, err := queryLogs(object{"ingressId": "wire"})
	if err != nil {
		t.Fatal(err)
	}
	rows := log["rows"].([]object)
	if len(rows) != 2 || rows[0]["traceId"] != rows[1]["traceId"] || text(rows[0], "traceId") == "" {
		t.Fatalf("uncorrelated observations %v", rows)
	}
	var data object
	for _, row := range rows {
		if row["event"] == "request_metadata" {
			data = row
		}
	}
	schema := field(data["schema"], "fields")
	if data["oauthClientHash"] != hash([]byte("hidden-client")) || data["cfRay"] != "abcdef0123456789-SJC" ||
		field(field(schema, "user"), "type") != "object" || uintOr(field(field(schema, "modes"), "omittedItems"), 0) != 1 {
		t.Fatalf("unexpected observation %v", data)
	}
	if strings.Contains(wire(rows), "hidden-") {
		t.Fatal("the observation retained a submitted value")
	}
}
