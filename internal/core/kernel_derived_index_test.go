//go:build arcfixture

package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStartupIndexGatePublishesAndAdoptsReceiptOwners(t *testing.T) {
	// Recurring bug class: lifecycle owner reads raced startup before their durable resident index was ready.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	gate := filepath.Join(root(), "index-gate")
	t.Setenv("ARC_FIXTURE_INDEX_GATE", gate)
	if err := saveBytes(gate, nil); err != nil {
		t.Fatal(err)
	}
	owners := []string{coreReceiptStore().base, agentReceiptStore().base}
	s := &service{}
	start := prepareRuntimeIndexes(s)
	defer func() { s.close() }()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	start(ctx)
	for _, owner := range owners {
		if _, err := findReceiptIndex(ctx, owner); err == nil || !strings.HasPrefix(err.Error(), "INDEX_NOT_READY:") {
			t.Fatalf("gated owner %s = %v", owner, err)
		}
		if _, err := os.Stat(filepath.Join(indexDirectory(owner), "current.json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("owner %s published through the gate: %v", owner, err)
		}
	}
	if err := os.Remove(gate); err != nil {
		t.Fatal(err)
	}
	published := func() []indexManifest {
		t.Helper()
		var manifests []indexManifest
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for _, owner := range owners {
			for {
				if _, err := findReceiptIndex(ctx, owner); err == nil {
					header, err := indexCurrent(owner)
					if err != nil {
						t.Fatalf("readable owner without a durable index: %v", err)
					}
					manifests = append(manifests, header)
					break
				}
				select {
				case <-ctx.Done():
					t.Fatalf("owner %s did not publish within the startup budget", owner)
				case <-tick.C:
				}
			}
		}
		return manifests
	}
	first := published()
	s.close()
	s = &service{}
	prepareRuntimeIndexes(s)(ctx)
	for i, header := range published() {
		if header.Generation != first[i].Generation {
			t.Fatalf("restart rebuilt a published owner: %v, previous %v", header, first[i])
		}
	}
}
