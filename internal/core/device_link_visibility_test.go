package core

import "testing"

func TestDeviceTaskOwnershipSurvivesSourceRenewal(t *testing.T) {
	// Algorithmic core: task ownership follows the pinned device across source renewal and excludes other or local principals.
	for _, test := range []struct {
		origin object
		owns   bool
	}{
		{object{"sourceId": "controller", "authType": "peer", "deviceId": "device-a"}, true},
		{object{"sourceId": "renewed", "authType": "peer", "deviceId": "device-a"}, true},
		{object{"sourceId": "older", "authType": "peer", "ingressId": "peer:device-a"}, true},
		{object{"sourceId": "other", "authType": "peer", "deviceId": "device-b"}, false},
		{object{"sourceId": "controller", "authType": "local", "deviceId": "device-a"}, false},
	} {
		if got := deviceOwnsOrigin(test.origin, "device-a"); got != test.owns {
			t.Errorf("ownership of %v = %v", test.origin, got)
		}
	}
}
