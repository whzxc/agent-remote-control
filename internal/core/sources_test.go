package core

import (
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestSourceAnswerAttributionUsesCurrentLabels(t *testing.T) {
	// Algorithmic core: Response attribution resolves the current name and preserves absent or local attribution.
	value := object{"response": object{"answeredBy": object{"kind": "source", "sourceId": "fixture"}}, "legacy": object{"result": object{"decision": "accept"}}, "local": object{"answeredBy": object{"kind": "local-ui"}}}
	source := object{"id": "fixture", "label": "Renamed controller", "platform": "claude", "state": "revoked"}
	decorateSourceLabels(value, []any{source})
	by := field(value["response"], "answeredBy")
	if !reflect.DeepEqual(by, object{"kind": "source", "sourceId": "fixture", "label": "Renamed controller", "brand": "claude"}) ||
		field(value["legacy"], "answeredBy") != nil || wire(field(value["local"], "answeredBy")) != `{"kind":"local-ui"}` {
		t.Fatalf("unexpected attribution: %v", value)
	}
}

func TestReceiptBatchLabelProjectionPreservesRecordedOwnership(t *testing.T) {
	// Recurring bug class: persistence Historical receipt batches share one label snapshot without changing recorded account identity or input.
	sources, accounts := []any{}, []any{}
	for n := range 7 {
		sources = append(sources, object{"id": fmt.Sprintf("source-%d", n), "label": fmt.Sprintf("label-%d", n), "authorizationFacts": object{"email": "same@example.test"}})
	}
	for n := range 15 {
		accounts = append(accounts, object{"id": fmt.Sprintf("account-%d", n), "alias": fmt.Sprintf("alias-%d", n)})
	}
	opaque := object{"origin": object{"sourceId": "source-0", "authType": "oauth", "sourceLabel": "recorded"}, "agentAccountId": "account-0", "agentAccountAlias": "recorded"}
	unchanged := wire(opaque)
	rows := []any{}
	for n := range 3008 {
		rows = append(rows, object{"origin": object{"sourceId": fmt.Sprintf("source-%d", n%7), "authType": "oauth", "accountId": "recorded-account"},
			"agentAccountId": fmt.Sprintf("account-%d", n%15), "arguments": opaque})
	}
	batch := object{"records": rows}
	started := time.Now()
	decorateSourceLabels(batch, sources)
	decorateAccountLabels(batch, accounts)
	if time.Since(started) >= 2*time.Second {
		t.Fatal("label projection exceeded the polling interval")
	}
	for n, row := range rows {
		origin := field(row, "origin")
		if text(origin, "sourceLabel") != fmt.Sprintf("label-%d", n%7) || text(row, "agentAccountAlias") != fmt.Sprintf("alias-%d", n%15) ||
			field(origin, "accountId") != "recorded-account" || wire(field(row, "arguments")) != unchanged {
			t.Fatalf("unexpected receipt projection at %d: %v", n, row)
		}
	}
	obj(sources[0])["label"] = "renamed-source"
	obj(accounts[0])["alias"], obj(accounts[0])["removedAt"] = "renamed-account", now()
	decorateSourceLabels(batch, sources)
	decorateAccountLabels(batch, accounts)
	if text(field(rows[0], "origin"), "sourceLabel") != "renamed-source" || field(rows[0], "agentAccountAlias") != "renamed-account" ||
		field(rows[0], "agentAccountId") != "account-0" || field(rows[0], "agentAccountRemoved") != true {
		t.Fatalf("unexpected updated labels: %v", rows[0])
	}
}

func TestSourceGrantAuthorityTracksRevocation(t *testing.T) {
	// Recurring bug class: security Grant admission must use the authoritative source independently of account projection.
	row := object{"ingressId": "ingress", "credential": object{"grantId": "grant"}, "state": "connected", "accountId": "missing-account"}
	rows := []any{row}
	if !sourceGrantActive(rows, "ingress", "grant") || sourceGrantActive(rows, "other", "grant") || sourceGrantActive(rows, "ingress", "other") {
		t.Fatal("grant matched the wrong source")
	}
	row["state"] = "revoked"
	if sourceGrantActive(rows, "ingress", "grant") {
		t.Fatal("revoked grant admitted")
	}
	row["state"], row["connectionRemoved"] = "connected", true
	if sourceGrantActive(rows, "ingress", "grant") {
		t.Fatal("removed connection still admits its grant")
	}
}

func sourceLifecycleFixture() object {
	return object{"id": "example-local", "ingressId": "local-cli", "credential": object{"type": "local"}, "product": "local-cli", "state": "connected", "connectedAt": 123}
}

func TestBuiltinSourceAuthorityCannotBeRevoked(t *testing.T) {
	// Recurring bug class: security A disconnect request must preserve shared Local CLI and panel authority.
	source := sourceLifecycleFixture()
	before := wire(source)
	if err := revokeControlSource(source); err == nil || managementErrorCode(err.Error()) != "LOCAL_SOURCE_PROTECTED" || wire(source) != before {
		t.Fatalf("unexpected local revocation: %v %v", source, err)
	}
	source["product"] = "custom"
	if requireControlSource(source) == nil {
		t.Fatal("product metadata changed local authority")
	}
}

func TestBuiltinSourceLifecycleRepairIsIdempotent(t *testing.T) {
	// Recurring bug class: persistence Repair revoked or removed Local CLI rows without replacing historical identity.
	for _, row := range []struct {
		state   string
		removed bool
	}{{"revoked", false}, {"connected", true}, {"disconnected", true}, {"revoked", true}} {
		source := sourceLifecycleFixture()
		source["state"], source["connectionRemoved"], source["connectionName"] = row.state, row.removed, "Old local connection"
		if !repairBuiltinSource(source, "local") || !reflect.DeepEqual(source, sourceLifecycleFixture()) || repairBuiltinSource(source, "local") {
			t.Fatalf("unexpected local repair: %v", source)
		}
	}
}

func TestExternalSourceAuthorityRemainsRevoked(t *testing.T) {
	// Recurring bug class: security Local authority repair must never restore an external credential.
	for _, kind := range []string{"ingress", "oauth-grant", "local"} {
		source := sourceLifecycleFixture()
		source["ingressId"] = "example-external"
		obj(source["credential"])["type"] = kind
		if err := revokeControlSource(source); err != nil || source["state"] != "revoked" {
			t.Fatalf("could not revoke %s source: %v", kind, err)
		}
		before := wire(source)
		if repairBuiltinSource(source, "local") || wire(source) != before {
			t.Fatalf("external %s source was restored", kind)
		}
	}
	source := sourceLifecycleFixture()
	source["state"] = "revoked"
	if repairBuiltinSource(source, "https") {
		t.Fatal("a nonlocal transport repaired a Local CLI source")
	}
}

func TestOAuthSharedIngressUsesClientProduct(t *testing.T) {
	// Recurring bug class: persistence Shared OAuth ingress defaults must preserve the registered client's inferred product.
	for _, row := range []struct{ configured, transport, client, want string }{
		{"chatgpt", "https", "Claude", "claude"}, {"claude", "https", "ChatGPT", "chatgpt"}, {"chatgpt", "https", "Unknown client", "chatgpt"},
		{"shared-relay", "relay", "Claude", "claude"}, {"shared-relay", "relay", "Unknown client", "custom"},
	} {
		if got := oauthSourceProduct(object{"controlSource": row.configured, "transport": row.transport}, row.client); got != row.want {
			t.Fatalf("client %s on %s resolved to %s, want %s", row.client, row.transport, got, row.want)
		}
	}
}
