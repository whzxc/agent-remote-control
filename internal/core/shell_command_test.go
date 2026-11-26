package core

import (
	"strings"
	"testing"
)

func TestNativeCommandDiagnosesPrivateHostUnreachable(t *testing.T) {
	// Recurring bug class: security native local-network errors need evidence-backed execution host attribution.
	hint := shellLocalNetworkHint(object{"stdout": "EHOSTUNREACH", "stderr": "", "exitCode": 0},
		object{"command": []string{"node", "-e", "fetch('http://192.168.50.10/')"}})
	if hint["code"] != "MACOS_LOCAL_NETWORK_ACCESS" || !strings.Contains(text(hint, "responsibleApplication"), "Agent Remote Control") ||
		!strings.Contains(text(hint, "likelyCause"), "Codex") {
		t.Fatalf("local network diagnosis = %v", hint)
	}
	if hint := shellLocalNetworkHint(object{"stderr": "EHOSTUNREACH 203.0.113.1"}, object{}); hint != nil {
		t.Fatalf("public address received local diagnosis: %v", hint)
	}
}
