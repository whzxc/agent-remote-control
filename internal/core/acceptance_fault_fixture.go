//go:build arcfixture

package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type acceptanceFault struct {
	mode    string
	expires time.Time
}

var acceptanceFaults = struct {
	sync.Mutex
	rows map[string]acceptanceFault
}{rows: map[string]acceptanceFault{}}

func isolatedAcceptanceInstance() bool {
	instance := os.Getenv("ARC_DEV_INSTANCE_ID")
	if instance == "" {
		return false
	}
	marker, err := cachedLoad(filepath.Join(root(), "acceptance-instance.json"))
	return err == nil && field(marker, "instanceId") == instance
}

func fixtureInjectAcceptanceFault(ctx context.Context, args object) (any, error) {
	if !isolatedAcceptanceInstance() || currentOrigin(ctx)["authType"] != "local" {
		return nil, acceptanceFaultUnavailable()
	}
	thread := text(args, "threadId")
	if readNativeDispatchHistory == nil {
		return nil, errors.New(PortPending)
	}
	rows, err := readNativeDispatchHistory(thread)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 || rows[len(rows)-1]["purpose"] != "self-test" {
		return nil, errors.New(`{"code":"ACCEPTANCE_SELF_TEST_REQUIRED","message":"Select an ARC dispatch with purpose:self-test"}`)
	}
	mode := text(args, "mode")
	acceptanceFaults.Lock()
	defer acceptanceFaults.Unlock()
	switch mode {
	case "clear":
		delete(acceptanceFaults.rows, thread)
		return object{"threadId": thread, "mode": "clear", "injected": false}, nil
	case "placeholder", "read-rejection":
	default:
		return nil, errors.New("INVALID_ACCEPTANCE_FAULT: use placeholder, read-rejection or clear")
	}
	ms := max(1, min(600000, uintOr(args["durationMs"], 300000)))
	acceptanceFaults.rows[thread] = acceptanceFault{mode: mode, expires: time.Now().Add(time.Duration(ms) * time.Millisecond)}
	return object{"threadId": thread, "mode": mode, "injected": true, "expiresInMs": ms,
		"next": object{"op": "acceptance_fault", "args": object{"threadId": thread, "mode": "clear"}}}, nil
}

func acceptanceFaultActive(thread, mode string) bool {
	if !isolatedAcceptanceInstance() {
		return false
	}
	acceptanceFaults.Lock()
	defer acceptanceFaults.Unlock()
	fault := acceptanceFaults.rows[thread]
	return fault.mode == mode && fault.expires.After(time.Now())
}

func init() {
	injectAcceptanceFault = fixtureInjectAcceptanceFault
	checkAcceptanceRead = func(method string, args any) error {
		thread := text(args, "threadId")
		if nativeThreadHistoryRead(method) && acceptanceFaultActive(thread, "read-rejection") {
			return errors.New("RPC_REJECTED:" + wire(object{"code": -32600, "message": "thread " + thread + " already has an active writer",
				"data": object{"injected": true, "mode": "read-rejection"}}))
		}
		return nil
	}
	applyAcceptanceSnapshot = func(thread string, state object) object {
		if !acceptanceFaultActive(thread, "placeholder") {
			return state
		}
		state = clone(state)
		history := obj(field(state["turnHistory"], "history"))
		if entities := obj(history["entitiesByKey"]); entities != nil {
			const placeholder = "arc-acceptance-placeholder"
			entities[placeholder] = object{"turnId": nil, "status": "inProgress", "items": []any{}}
			islands := arr(history["islands"])
			if len(islands) != 0 {
				island := obj(islands[len(islands)-1])
				if entries := arr(island["entries"]); entries != nil {
					entries = slices.DeleteFunc(entries, func(entry any) bool { return field(entry, "value") == placeholder })
					island["entries"] = append(entries, object{"value": placeholder})
				}
			}
		}
		state["acceptanceFault"] = object{"injected": true, "mode": "placeholder"}
		return state
	}
}
