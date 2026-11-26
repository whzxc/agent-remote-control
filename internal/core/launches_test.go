package core

import (
	"strings"
	"testing"
)

func TestShutdownRejectsLaunchesAndAdoptions(t *testing.T) {
	// Recurring bug class: concurrency shutdown rejects spawns and adoptions after the publication barrier closes.
	var launches launches
	if err := launches.run(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	launches.close()
	err := launches.run(func() error { t.Fatal("launch admitted after shutdown"); return nil })
	if err == nil || !strings.HasPrefix(err.Error(), "CORE_SHUTTING_DOWN:") {
		t.Fatalf("expected shutdown error, got %v", err)
	}
}
