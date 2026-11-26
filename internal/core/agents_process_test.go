package core

import (
	"strings"
	"testing"
)

func TestAgentStdoutDiagnosticsKeepBoundedRedactedEvidence(t *testing.T) {
	// Recurring bug class: security subprocess diagnostics stay bounded and redact sensitive output.
	var diagnostics object
	for range 100 {
		diagnostics = recordAgentStdoutDiagnostic(diagnostics, []byte(strings.Repeat("credential password=fixture-secret 界\n", 100)))
	}
	if uintOr(diagnostics["skippedLines"], 0) != 100 || diagnostics["truncated"] != true || len(wire(diagnostics)) > 4096 {
		t.Fatalf("diagnostic bounds failed: %s", wire(diagnostics))
	}
	exit := agentExitDiagnostic("PROCESS_EXIT_UNCONFIRMED", diagnostics)
	if strings.Contains(exit, "fixture-secret") || !strings.Contains(exit, "credential") {
		t.Fatalf("exit diagnostic exposed or lost evidence: %q", exit)
	}
	read := agentStdoutReadError(&fixtureStdoutError{}).Error()
	if !strings.HasPrefix(read, "AGENT_STDOUT_READ_FAILED:") || strings.Contains(read, "fixture-secret") {
		t.Fatalf("unexpected stdout error: %q", read)
	}
}

type fixtureStdoutError struct{}

func (*fixtureStdoutError) Error() string { return "broken pipe password=fixture-secret" }
