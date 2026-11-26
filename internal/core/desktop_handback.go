package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/google/uuid"
)

var nativeDesktopTargetExited func(any) bool
var reopenNativeDesktopTask func(context.Context, *service, string, object) (bool, error)
var nativeDesktopWriterEvidence func(context.Context, string, string) object

func desktopHandbackObservation(thread string) (object, error) {
	if uuid.Validate(thread) != nil {
		return nil, nil
	}
	value, err := cachedLoad(filepath.Join(root(), "desktop-handback", thread+".json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	previous := obj(value)
	binding, err := codexExecutionRecord(thread)
	if err != nil {
		return nil, err
	}
	if from := binding["continuedFrom"]; from != nil && (previous == nil || wire(previous["instance"]) == wire(from)) {
		if binding["transport"] == "local-daemon" {
			return object{"rootThreadId": binding["handbackRoot"], "state": "in-instance", "instance": binding["desktopTarget"], "previousOwnHold": previous["ownHold"]}, nil
		}
		current := clone(previous)
		if current == nil {
			current = object{}
		}
		current["rootThreadId"], current["instance"], current["state"] = binding["handbackRoot"], from, "continued"
		return current, nil
	}
	return previous, nil
}

func publishDesktopHandback(thread string, state object) error {
	path := filepath.Join(root(), "desktop-handback", thread+".json")
	if value, err := cachedLoad(path); err == nil && wire(value) == wire(state) {
		return nil
	}
	return save(path, state)
}

func returnedDesktopInstance(thread string) (any, error) {
	status, err := desktopHandbackObservation(thread)
	if err != nil {
		return nil, err
	}
	if status["state"] == "continued" {
		return nil, nil
	}
	target := status["instance"]
	if target == nil {
		binding, err := codexExecutionRecord(thread)
		if err != nil {
			return nil, err
		}
		target = binding["desktopInstance"]
	}
	if nativeDesktopTargetExited != nil && nativeDesktopTargetExited(target) ||
		fixtureUsesDesktop != nil && status["state"] == "handed-back" {
		return target, nil
	}
	return nil, nil
}

func desktopHandbackActive(ctx context.Context, s *service, rpc *rpcConnection, thread string) (bool, error) {
	native, err := rpc.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, 3*time.Second)
	if err != nil {
		return false, err
	}
	record := field(native, "thread")
	if field(record, "id") != thread {
		return false, errors.New("DESKTOP_HANDBACK_THREAD_MISMATCH")
	}
	if nativeThreadHasInteraction(s, thread) {
		return true, nil
	}
	switch field(field(record, "status"), "type") {
	case "active":
		return true, nil
	case "idle", "notLoaded":
		return false, nil
	case "systemError":
		last, err := rpc.call(ctx, "thread/turns/list", object{"threadId": thread, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, 3*time.Second)
		if err != nil {
			return false, err
		}
		if rows, _ := field(last, "data").([]any); len(rows) != 0 {
			switch field(rows[0], "status") {
			case "failed", "completed", "interrupted":
				return false, nil
			}
		}
	}
	return false, errors.New("DESKTOP_HANDBACK_ACTIVITY_UNKNOWN")
}

func desktopHandbackMember(ctx context.Context, s *service, rpc *rpcConnection, proxy, target any, home, thread, rootThread, reason string) (object, error) {
	previous, err := desktopHandbackObservation(thread)
	if err != nil || previous["state"] == "continued" {
		return previous, err
	}
	if prior := previous["instance"]; prior != nil {
		target = prior
	}
	state := object{"rootThreadId": rootThread, "instance": target}
	if !nativeDesktopTargetExited(target) {
		state["state"] = "in-instance"
		return state, nil
	}
	priorHold := obj(previous["ownHold"])
	connection := field(proxy, "connection")
	if rpc != nil {
		connection = rpc.connection
		if previous["checkedConnection"] == connection && priorHold != nil {
			state["ownHold"] = priorHold
		} else {
			active, err := desktopHandbackActive(ctx, s, rpc, thread)
			if err != nil {
				return nil, err
			}
			if active {
				state["state"] = "running"
				if priorHold != nil {
					state["state"], state["ownHold"] = "held", priorHold
				}
				return state, nil
			}
			reply, err := rpc.call(ctx, "thread/unsubscribe", object{"threadId": thread}, 3*time.Second)
			if err != nil {
				return nil, err
			}
			status := text(reply, "status")
			if !slices.Contains([]string{"unsubscribed", "notLoaded", "notSubscribed"}, status) {
				return nil, errors.New("DESKTOP_HANDBACK_UNCONFIRMED")
			}
			if previous["state"] == "running" {
				reason = "turn-settled"
			}
			state["ownHold"] = object{"state": "dropped", "evidence": "thread/unsubscribe", "nativeStatus": status, "connection": connection, "observedAt": now(), "reason": reason}
		}
	} else if nativeDesktopTargetExited(proxy) {
		state["ownHold"] = object{"state": "dropped", "evidence": "connection-close", "connection": connection, "observedAt": now(), "reason": reason, "basis": "proxy-process-exited"}
	} else if priorHold == nil {
		return nil, errors.New("DESKTOP_HANDBACK_CONNECTION_UNCONFIRMED")
	}
	if field(state["ownHold"], "nativeStatus") != "unsubscribed" {
		if priorHold != nil {
			state["ownHold"] = priorHold
		} else if previousConnection := text(proxy, "connection"); previousConnection != "" {
			for _, file := range []string{"desktop-last-disconnect.json", "private-last-disconnect.json"} {
				if closed, err := cachedLoad(filepath.Join(root(), file)); err == nil && field(closed, "connection") == previousConnection {
					state["ownHold"] = object{"state": "dropped", "evidence": "connection-close", "connection": previousConnection,
						"observedAt": field(closed, "observedAt"), "reason": reason, "confirmedAt": now(), "nativeStatus": field(state["ownHold"], "nativeStatus")}
					break
				}
			}
		}
	}
	state["checkedConnection"] = connection
	if wire(state["ownHold"]) != wire(priorHold) || previous["checkedConnection"] != connection {
		state["state"] = "unconfirmed"
		if err := publishDesktopHandback(thread, state); err != nil {
			return nil, err
		}
	}
	switch probeWriter(home, thread)["state"] {
	case "unheld":
		state["state"] = "handed-back"
	case "held":
		state["state"] = "held"
	default:
		state["state"] = "unconfirmed"
	}
	return state, nil
}

func desktopHandbackDescendants(ctx context.Context, rpc *rpcConnection, home, thread string) ([][2]string, error) {
	if rpc != nil {
		if edges, err := desktopHandbackNativeDescendants(ctx, rpc, thread); err == nil {
			return edges, nil
		}
	}
	return codexSpawnedDescendants(ctx, home, thread)
}

func desktopHandbackNativeDescendants(ctx context.Context, rpc *rpcConnection, thread string) ([][2]string, error) {
	var edges [][2]string
	var cursor any
	seen := map[string]bool{}
	for {
		page, err := rpc.call(ctx, "thread/list", object{"ancestorThreadId": thread, "sourceKinds": []string{"subAgentThreadSpawn"},
			"modelProviders": []string{}, "limit": 100, "cursor": cursor}, 5*time.Second)
		if err != nil {
			return nil, err
		}
		rows, ok := field(page, "data").([]any)
		if !ok {
			return nil, errors.New("DESKTOP_HANDBACK_INVALID_THREAD_LIST")
		}
		for _, row := range rows {
			child := text(row, "id")
			if uuid.Validate(child) != nil || child == thread {
				return nil, errors.New("DESKTOP_HANDBACK_INVALID_DESCENDANT")
			}
			parent := text(field(field(field(row, "source"), "subAgent"), "thread_spawn"), "parent_thread_id")
			if parent == "" {
				return nil, errors.New("DESKTOP_HANDBACK_PARENT_MISSING")
			}
			edges = append(edges, [2]string{child, parent})
		}
		cursor = field(page, "nextCursor")
		if cursor == nil {
			return edges, nil
		}
		key := wire(cursor)
		if seen[key] {
			return nil, errors.New("DESKTOP_HANDBACK_CURSOR_REPEATED")
		}
		seen[key] = true
	}
}

func desktopHandbackTargets(thread string, target any, edges [][2]string) (map[string]any, error) {
	parents, targets := map[string]string{}, map[string]any{thread: target}
	for _, edge := range edges {
		child := edge[0]
		if child == thread || uuid.Validate(child) != nil {
			return nil, errors.New("DESKTOP_HANDBACK_INVALID_DESCENDANT")
		}
		parents[child] = edge[1]
		state, err := desktopHandbackObservation(child)
		if err != nil {
			return nil, err
		}
		if state["instance"] != nil {
			targets[child] = state["instance"]
		}
	}
	for child := range parents {
		var path []string
		cursor := child
		for targets[cursor] == nil {
			next, ok := parents[cursor]
			if !ok || len(path) >= len(parents) {
				return nil, errors.New("DESKTOP_HANDBACK_INVALID_SPAWN_TREE")
			}
			path = append(path, cursor)
			cursor = next
		}
		for _, member := range path {
			targets[member] = targets[cursor]
		}
	}
	delete(targets, thread)
	return targets, nil
}

func reconcileDesktopHandback(ctx context.Context, s *service, home, thread string, startup bool) (bool, error) {
	unlock := lockReceipt("codex-thread:" + thread)
	defer unlock()
	binding, err := codexExecutionRecord(thread)
	if err != nil {
		return false, err
	}
	target, backend, proxy := binding["desktopInstance"], binding["backend"], binding["desktopProxy"]
	previous := binding["pendingPreviousSubtree"] == true
	if previous {
		target, backend, proxy = binding["continuedFrom"], binding["previousSubtreeBackend"], binding["previousSubtreeProxy"]
	}
	if target == nil {
		return true, nil
	}
	if !nativeDesktopTargetExited(target) {
		return false, nil
	}
	rpc, err := s.desktopBackendRPC(ctx, str(backend))
	if err != nil && !nativeDesktopTargetExited(proxy) {
		return false, err
	}
	reason := "instance-exit"
	if startup {
		reason = "startup-reconciliation"
	}
	parent, err := desktopHandbackMember(ctx, s, rpc, proxy, target, home, thread, thread, reason)
	if err != nil {
		parent = object{"rootThreadId": thread, "instance": target, "state": "unconfirmed", "reason": "activity-or-release-unconfirmed"}
	}
	if err := publishDesktopHandback(thread, parent); err != nil {
		return false, err
	}
	edges, err := desktopHandbackDescendants(ctx, rpc, home, thread)
	if err != nil {
		return false, err
	}
	targets, err := desktopHandbackTargets(thread, parent["instance"], edges)
	if err != nil {
		return false, err
	}
	var ids []string
	for child := range targets {
		ids = append(ids, child)
	}
	slices.Sort(ids)
	blockers := []object{}
	for _, child := range ids {
		release := lockReceipt("codex-thread:" + child)
		status, err := desktopHandbackMember(ctx, s, rpc, proxy, targets[child], home, child, thread, reason)
		if err != nil {
			status = object{"rootThreadId": thread, "instance": targets[child], "state": "unconfirmed"}
		}
		err = publishDesktopHandback(child, status)
		release()
		if err != nil {
			return false, err
		}
		if status["state"] != "handed-back" && status["state"] != "continued" {
			blockers = append(blockers, object{"threadId": child, "state": status["state"]})
		}
	}
	delete(parent, "descendants")
	if len(blockers) > 0 {
		if parent["state"] == "handed-back" {
			parent["state"] = "subtree-held"
		}
		parent["descendants"] = blockers
	}
	if err := publishDesktopHandback(thread, parent); err != nil {
		return false, err
	}
	if previous && len(blockers) == 0 {
		delete(binding, "pendingPreviousSubtree")
		delete(binding, "previousSubtreeBackend")
		delete(binding, "previousSubtreeProxy")
		if err := save(filepath.Join(root(), "execution", thread+".json"), binding); err != nil {
			return false, err
		}
	}
	return len(blockers) == 0 && (parent["state"] == "handed-back" || parent["state"] == "continued"), nil
}

func startNativeDesktopHandback(ctx context.Context, s *service) error {
	if nativeDesktopTargetExited == nil || fixtureUsesDesktop != nil {
		return nil
	}
	dir := filepath.Join(root(), "execution")
	done := make(chan struct{})
	lifetime, cancel := context.WithCancel(ctx)
	s.cleanup = append(s.cleanup, func() { cancel(); <-done })
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		startup := true
		settled := map[string]string{}
		for lifetime.Err() == nil {
			entries, _ := os.ReadDir(dir)
			for _, entry := range entries {
				if lifetime.Err() != nil {
					return
				}
				thread := entry.Name()
				if len(thread) != 41 || filepath.Ext(thread) != ".json" {
					continue
				}
				thread = thread[:36]
				binding, err := codexExecutionRecord(thread)
				if err != nil || binding["desktopInstance"] == nil && binding["pendingPreviousSubtree"] != true {
					continue
				}
				digest := wire(binding)
				if settled[thread] == digest {
					continue
				}
				_, home, err := codexInputs()
				if err != nil {
					continue
				}
				if complete, err := reconcileDesktopHandback(lifetime, s, home, thread, startup); err == nil && complete {
					settled[thread] = digest
				}
			}
			startup = false
			select {
			case <-lifetime.Done():
			case <-ticker.C:
			}
		}
	}()
	return nil
}

func init() {
	registerAfterIndexStartup(20, startNativeDesktopHandback)
}

var prepareNativeDesktopFollowup func(context.Context, *service, string, string, string) (object, error)

func requireUnheldDesktopWriter(ctx context.Context, home, thread string) error {
	lock := probeWriter(home, thread)
	if lock["state"] == "unheld" {
		return nil
	}
	if lock["state"] == "held" {
		if nativeDesktopWriterEvidence != nil {
			holder := nativeDesktopWriterEvidence(ctx, home, thread)
			if holder["origin"] == "main-desktop" {
				return errors.New(wire(object{"code": "DESKTOP_TASK_HANDED_BACK",
					"message": "This task is in use in your main Desktop. ARC did not deliver the input.", "threadId": thread,
					"next": object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread}}}))
			}
			lock["holder"] = holder
		}
		lock["owner"] = "external"
	}
	return errors.New(wire(writerBusy(thread, lock)))
}

func prepareReturnedDesktopThread(ctx context.Context, s *service, thread string, previous any) (string, error) {
	_, home, err := codexInputs()
	if err != nil {
		return "", err
	}
	if err := requireUnheldDesktopWriter(ctx, home, thread); err != nil {
		return "", err
	}
	old, err := desktopHandbackObservation(thread)
	if err != nil {
		return "", err
	}
	rootThread := nonemptyTaskText(text(old, "rootThreadId"), thread)
	taskSettings, err := notificationSettings()
	if err != nil {
		return "", err
	}
	var binding object
	if taskSettings["desktopRecovery"] == "independent" && fixtureUsesDesktop == nil && prepareNativeDesktopFollowup != nil {
		binding, err = prepareNativeDesktopFollowup(ctx, s, home, rootThread, thread)
		if err != nil {
			return "", err
		}
	} else {
		d, err := s.nativeDesktop(ctx)
		if err == nil {
			err = revealNativeDesktopThread(ctx, d, thread)
		}
		if err == nil {
			binding = object{"owner": "desktop", "transport": "ipc"}
		} else {
			if !desktopMissingEndpoint(err) && !desktopMissingOwner(err) {
				return "", err
			}
			rpc, err := s.codexUtility(ctx)
			if err != nil {
				return "", err
			}
			if err := requireUnheldDesktopWriter(ctx, home, thread); err != nil {
				return "", err
			}
			value, err := rpc.call(ctx, "thread/resume", object{"threadId": thread, "excludeTurns": true}, time.Minute)
			if err != nil {
				if nativeWriterRejected(err) {
					return "", writerFailure(ctx, s, home, thread, err)
				}
				return "", err
			}
			if text(field(value, "thread"), "id") != thread {
				return "", errors.New("native-thread-id-mismatch")
			}
			binding = object{"owner": "connector", "reason": "desktop-handback-no-owner"}
		}
	}
	binding["continuedFrom"], binding["handbackRoot"] = previous, rootThread
	descendants, _ := old["descendants"].([]any)
	if rootThread == thread && old["state"] != "handed-back" && (len(descendants) != 0 || obj(old["ownHold"]) == nil) {
		prior, err := codexExecutionRecord(thread)
		if err != nil {
			return "", err
		}
		binding["pendingPreviousSubtree"], binding["previousSubtreeBackend"], binding["previousSubtreeProxy"] = true, prior["backend"], prior["desktopProxy"]
		if binding["desktopProxy"] == nil {
			binding["desktopProxy"] = prior["desktopProxy"]
		}
	}
	if err := save(filepath.Join(root(), "execution", thread+".json"), binding); err != nil {
		return "", err
	}
	if binding["transport"] == "local-daemon" && revealNativeDesktopBackendTask != nil {
		if err := revealNativeDesktopBackendTask(ctx, thread, binding); err != nil {
			return "", err
		}
	}
	return text(binding, "owner"), nil
}
