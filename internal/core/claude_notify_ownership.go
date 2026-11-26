package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

var notificationAcquisitionSession = sync.OnceValue(id)

func readNotificationOwnershipState(thread string) (string, object, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return "", nil, errors.New("INVALID_THREAD_ID")
	}
	path := filepath.Join(root(), "execution", "handoffs", thread+".json")
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return path, object{"currentOwner": "unknown", "history": []any{}}, nil
	}
	return path, obj(value), err
}

func publicNotificationOwnership(state object) object {
	delete(state, "enqueued")
	delete(state, "acquisition")
	return state
}

func readNotificationOwnership(thread string) (object, error) {
	_, state, err := readNotificationOwnershipState(thread)
	return publicNotificationOwnership(state), err
}

func beginNotificationAcquisition(ctx context.Context, thread string) (string, error) {
	source := text(currentOrigin(ctx), "sourceId")
	if source == "" {
		return "", nil
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	path, state, err := readNotificationOwnershipState(thread)
	if err != nil || state["currentOwner"] != "unheld" {
		return "", err
	}
	token := id()
	state["acquisition"] = object{"id": token, "sourceId": source, "observerSession": notificationAcquisitionSession()}
	return token, save(path, state)
}

func endNotificationAcquisition(thread, token string) error {
	if token == "" {
		return nil
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	path, state, err := readNotificationOwnershipState(thread)
	if err != nil || field(state["acquisition"], "id") != token {
		return err
	}
	delete(state, "acquisition")
	return save(path, state)
}

func observeNotificationOwnership(thread string, ownership object) (object, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	path, state, err := readNotificationOwnershipState(thread)
	if err != nil {
		return nil, err
	}
	owner, ok := ownership["owner"].(string)
	if !ok {
		owner = "unknown"
		if ownership["state"] == "unheld" {
			owner = "unheld"
		}
	}
	before := clone(state)
	previous := text(state, "currentOwner")
	if previous == "" || previous == "unknown" {
		previous = text(state, "lastKnownOwner")
		if previous == "" && owner == "desktop" {
			if recorded, err := load(filepath.Join(root(), "execution", thread+".json")); err == nil {
				previous = text(recorded, "owner")
			}
		}
	}
	history := arr(state["history"])
	if owner != "unknown" {
		if previous != "" && previous != owner {
			if history == nil {
				return nil, errors.New("INVALID_HANDOFF_HISTORY")
			}
			var cause any
			a := obj(state["acquisition"])
			if previous == "unheld" && owner == "connector" && a["observerSession"] == notificationAcquisitionSession() {
				cause = a["sourceId"]
			}
			delete(state, "acquisition")
			history = append(history, object{"eventId": hash([]byte(wire([]any{thread, len(history), previous, owner}))), "from": previous,
				"to": owner, "observedAt": now(), "causedBySourceId": cause, "evidence": ownership["evidence"], "timeBasis": "observed-not-transition-time"})
			state["history"] = history
		}
		state["lastKnownOwner"] = owner
	}
	state["currentOwner"], state["state"], state["observedAt"] = owner, ownership["state"], now()
	if notificationObservationChanged(before, state) {
		if err := save(path, state); err != nil {
			return nil, err
		}
	}
	if len(history) != 0 {
		bindings, err := notificationBindingsForThread(thread)
		if err != nil {
			return nil, err
		}
		for _, b := range bindings {
			if b["threadId"] != thread || b["scopeEnd"] != nil || b["continuationBound"] == true || notificationAgent(b) != "codex" {
				continue
			}
			source := text(b, "sourceId")
			cursor := uintOr(field(state["enqueued"], source), 0)
			if cursor >= uint64(len(history)) {
				continue
			}
			if err := enqueueNotificationHandoffs(b, history[cursor:]); err != nil {
				return nil, err
			}
			dispatchSetSection(state, "enqueued")[source] = len(history)
			if err := save(path, state); err != nil {
				return nil, err
			}
		}
	}
	result := publicNotificationOwnership(state)
	result["ownership"] = ownership
	return result, nil
}

func enqueueNotificationHandoffs(binding object, history []any) error {
	source := text(binding, "sourceId")
	state := text(binding["observation"], "state")
	if notificationTerminal(state) || source == "" {
		return nil
	}
	rows := arr(binding["deliveries"])
	for _, handoff := range history {
		observed, err := time.Parse(time.RFC3339Nano, text(handoff, "observedAt"))
		if err != nil || uint64(observed.UnixMilli()) < notificationScopeStarted(binding) {
			continue
		}
		key := "handoff:" + text(handoff, "eventId")
		eventID := hash([]byte(wire([]any{source, binding["threadId"], key})))
		if find(rows, "eventId", eventID) != nil {
			continue
		}
		at := notificationClock()
		d := object{"key": key, "state": "handoff", "taskState": "handoff", "status": "inbox-only", "taskError": handoff,
			"eventId": eventID, "createdAt": at.Unix(), "channel": binding["channel"], "target": text(binding, "target"),
			"timing": newNotificationTiming(at.UnixMilli())}
		if err := appendNotificationInbox(source, notificationEvent(binding, d)); err != nil {
			return err
		}
		rows = append(rows, d)
	}
	binding["deliveries"] = rows
	return persistNotificationBinding(binding)
}

func endNotificationScope(thread, reason string) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	rows, err := notificationBindingsForThread(thread)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row["threadId"] == thread && row["scopeEnd"] == nil {
			row["scopeEnd"] = reason
			if err := persistNotificationBinding(row); err != nil {
				return err
			}
		}
	}
	notificationSignal()
	return nil
}
