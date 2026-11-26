package core

import "testing"

func TestDeviceManagementCatalogAcceptsItsPublishedRouteArguments(t *testing.T) {
	// Contract: enabled Device link management operations resolve their published JSON argument shapes.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	if _, err := changePreferences(object{"values": object{"device-link": "on"}}, false); err != nil {
		t.Fatal(err)
	}
	for _, example := range []struct {
		action string
		args   object
	}{
		{"offer", object{}},
		{"configure", object{"body": object{"port": 17143, "name": "Fixture member"}}},
		{"pair", object{"body": object{"pairingString": "fixture-offer"}}},
		{"address", object{"body": object{"device": "Fixture member", "address": nil}}},
	} {
		name := "device." + example.action
		spec := find(managementCatalog()["operations"], "name", name)
		if invalid := checkSchema("management", name, "", spec["inputSchema"], example.args); invalid != nil {
			t.Errorf("%s rejected its declared arguments: %s", name, wire(invalid))
		}
		if route, method, _, err := managementResolve(name, example.args); err != nil ||
			route != "device/"+example.action || method != "POST" {
			t.Errorf("%s resolution = %s %s, %v", name, method, route, err)
		}
	}
}
