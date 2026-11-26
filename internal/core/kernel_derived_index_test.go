//go:build arcfixture

package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNotificationAndReceiptScaleRebuildKeepsCoreReady(t *testing.T) {
	// Recurring bug class: lifecycle installed-scale index migration prevented guide, query and Desktop leases from starting.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	gate := filepath.Join(root(), "index-gate")
	t.Setenv("ARC_FIXTURE_INDEX_GATE", gate)
	if err := saveBytes(gate, nil); err != nil {
		t.Fatal(err)
	}
	coreOwner, notificationOwner := coreReceiptStore().base, notificationOwnerPath()
	const receipts, bindings = 9000, 1100
	payload := strings.Repeat("x", 6000)
	for range receipts {
		request := id()
		row := object{"requestId": request, "state": "completed", "backendSession": "fixture", "result": object{"payload": payload}}
		if err := saveBytes(filepath.Join(coreOwner, request+".json"), []byte(wire(row))); err != nil {
			t.Fatal(err)
		}
	}
	for index := range bindings {
		thread := fmt.Sprintf("scale-%d", index)
		row := newNotificationBinding(thread, "turn", "/fixture", "source", time.Now())
		row["scopeEnd"] = "scope-ended"
		row["observation"] = object{"state": "completed", "recordedStatus": "completed", "reconciliation": "reconciled"}
		if err := saveBytes(notificationBindingPath(thread, "turn"), []byte(wire(row))); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	s := &service{runtime: &runtimeState{leases: make(map[string]lease)}}
	defer s.close()
	prepareRuntimeIndexes(s)(ctx)
	started := time.Now()
	if _, err := s.runtime.request("runtime/lease", object{"id": id(), "kind": "desktop", "pid": os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"guide", "runtime_metrics"} {
		reply := callTool(ctx, s, requestSource{local: true, policy: "all"}, "query", object{"op": op, "args": object{}}, nil)
		if reply["isError"] != false {
			t.Fatalf("%s was unavailable behind the startup gate: %v", op, reply)
		}
	}
	if _, err := notificationStatusIndex(); err == nil || !strings.HasPrefix(err.Error(), "INDEX_NOT_READY") {
		t.Fatalf("notification owner before gate release = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("readiness took %v while the index was held", elapsed)
	}
	if err := os.Remove(gate); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.indexStartupDone:
	case <-ctx.Done():
		t.Fatal("retained indexes did not publish")
	}
	for owner, rows := range map[string]int{coreOwner: receipts, notificationOwner: bindings} {
		header, err := indexCurrent(owner)
		if err != nil || header.Count != rows {
			t.Fatalf("installed-scale owner %s = %v, %v", owner, header, err)
		}
	}
}

func TestStartupIndexGatePublishesAndAdoptsReceiptOwners(t *testing.T) {
	// Recurring bug class: lifecycle owner reads raced startup before their durable resident index was ready.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	gate := filepath.Join(root(), "index-gate")
	t.Setenv("ARC_FIXTURE_INDEX_GATE", gate)
	if err := saveBytes(gate, nil); err != nil {
		t.Fatal(err)
	}
	owners := []string{coreReceiptStore().base, agentReceiptStore().base}
	consumers := make(chan error, 2)
	previous := afterIndexStartup
	registerAfterIndexStartup(0, func(ctx context.Context, _ *service) error {
		for _, owner := range owners {
			if _, err := indexCurrent(owner); err != nil {
				consumers <- err
				return err
			}
			if err := indexAvailable(ctx, owner); err != nil {
				consumers <- err
				return err
			}
		}
		consumers <- nil
		return nil
	})
	defer func() { afterIndexStartup = previous }()
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
	awaitConsumer := func() {
		t.Helper()
		select {
		case err := <-consumers:
			if err != nil {
				t.Fatalf("consumer started before durable publication: %v", err)
			}
		case <-ctx.Done():
			t.Fatal("index startup did not start its consumers")
		}
	}
	awaitConsumer()
	s.close()
	s = &service{}
	prepareRuntimeIndexes(s)(ctx)
	for i, header := range published() {
		if header.Generation != first[i].Generation {
			t.Fatalf("restart rebuilt a published owner: %v, previous %v", header, first[i])
		}
	}
	awaitConsumer()
}
