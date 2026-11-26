package core

import (
	"maps"
	"math"
	"slices"
	"strings"
	"time"
)

func coordinationRecordTime(row object, key string) int64 {
	at, err := time.Parse(time.RFC3339Nano, text(row, key))
	if err != nil {
		return math.MinInt64
	}
	return at.UnixMilli()
}

func coordinationEventTime(row object) int64 {
	if raw := strPtrValue(row["occurredAt"]); raw != "" {
		if at, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			return at.UnixMilli()
		}
		return math.MinInt64
	}
	return coordinationRecordTime(row, "observedAt")
}

func coordinationRefs(row object) []coordinationThreadRef {
	if refs, ok := row["threadRefs"].([]coordinationThreadRef); ok {
		return refs
	}
	var refs []coordinationThreadRef
	_ = unmarshalJSON([]byte(wire(row["threadRefs"])), &refs)
	return refs
}

func coordinationResourceStrings(value any) []string {
	if resources, ok := value.([]string); ok {
		return resources
	}
	return axStrings(value)
}

func coordinationOverlaps(a, b object) bool {
	left, right := coordinationResourceStrings(a["resources"]), coordinationResourceStrings(b["resources"])
	return slices.ContainsFunc(left, func(value string) bool { return slices.Contains(right, value) })
}

func coordRefMatches(a, b coordinationThreadRef) bool {
	return a.ThreadID == b.ThreadID && a.TurnID != nil && samePointer(a.TurnID, b.TurnID)
}

func staleBlockerRecovery() object {
	return object{"state": "suppressed", "reason": "stale-blocker", "recipients": []object{}, "unresolved": []object{}, "automaticResume": false}
}

func publicCoordinationRecovery(plan object) object {
	if plan == nil {
		return object{"state": "pending", "automaticResume": false}
	}
	count := func(value any) int {
		if rows, ok := value.([]object); ok {
			return len(rows)
		}
		return len(arr(value))
	}
	return object{"state": plan["state"], "reason": plan["reason"], "recipientSessions": count(plan["recipients"]),
		"unresolvedRecipients": count(plan["unresolved"]), "scanned": plan["scanned"], "truncated": plan["truncated"], "coverage": plan["coverage"], "automaticResume": false}
}

func coordinationEventOutcome(row object) string {
	return strPtrValue(row["status"])
}

func strPtrValue(value any) string {
	if pointer, ok := value.(*string); ok {
		return strPtr(pointer)
	}
	return str(value)
}

func coordinationEventOrigin(row object) string {
	if origin, ok := row["origin"].(*coordinationPrincipal); ok {
		if origin != nil {
			return origin.SourceID
		}
		return ""
	}
	return text(row["origin"], "sourceId")
}

func coordinationObserveValue(row object, key string) *string {
	if detail, ok := row["observation"].(*coordinationObservation); ok {
		if detail == nil {
			return nil
		}
		if key == "sessionId" {
			return detail.SessionID
		}
		return detail.SessionBindingID
	}
	return axOptional(field(row["observation"], key))
}

func obsoleteCoordinationRecovery(reference coordinationThreadRef, interrupted int64, events []object) bool {
	edges := map[string][]string{}
	for _, event := range events {
		if event["kind"] != "turn.successor" {
			continue
		}
		pair := coordinationRefs(event)
		if len(pair) == 2 && pair[0].ThreadID == reference.ThreadID && pair[1].ThreadID == reference.ThreadID {
			previous, next := strPtr(pair[0].TurnID), strPtr(pair[1].TurnID)
			edges[previous] = append(edges[previous], next)
		}
	}
	turns := map[string]bool{}
	pending := []string{strPtr(reference.TurnID)}
	for len(pending) > 0 {
		turn := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if !turns[turn] {
			turns[turn] = true
			pending = append(pending, edges[turn]...)
		}
	}
	for _, event := range events {
		completed := event["kind"] == "turn.terminal" && coordinationEventOutcome(event) == "completed"
		newDispatch := event["kind"] == "dispatch.accepted" && coordinationEventTime(event) > interrupted
		if !completed && !newDispatch {
			continue
		}
		for _, ref := range coordinationRefs(event) {
			if ref.ThreadID == reference.ThreadID && completed == turns[strPtr(ref.TurnID)] {
				return true
			}
		}
	}
	return false
}

func selectCoordinationRecovery(blocker object, events []object, gap bool) object {
	recipients, unresolved := []object{}, []object{}
	if blocker["state"] != "cleared" {
		return object{"state": "suppressed", "reason": "not-cleared", "recipients": recipients, "unresolved": unresolved, "automaticResume": false}
	}
	opened, cleared := coordinationRecordTime(blocker, "openedAt"), coordinationRecordTime(blocker, "clearedAt")
	clearing := coordinationEventOrigin(object{"origin": blocker["clearedBy"]})
	type key struct{ source, session string }
	groups := map[key][]object{}
	seen := map[[2]string]bool{}
	scanned := 0
	truncated := false
	for _, event := range events {
		if event["kind"] != "turn.terminal" || !slices.Contains([]string{"failed", "interrupted", "cancelled"}, coordinationEventOutcome(event)) {
			continue
		}
		at := coordinationEventTime(event)
		if at < opened || at > cleared {
			continue
		}
		for _, ref := range coordinationRefs(event) {
			identity := [2]string{ref.ThreadID, strPtr(ref.TurnID)}
			if ref.TurnID == nil || seen[identity] {
				continue
			}
			overlap := coordinationOverlaps(event, blocker)
			matches := func(row object) bool {
				return slices.ContainsFunc(coordinationRefs(row), func(other coordinationThreadRef) bool { return coordRefMatches(ref, other) })
			}
			if !overlap && !slices.ContainsFunc(events, func(row object) bool {
				return row["kind"] == "notice.changed" && coordinationEventTime(row) <= at && coordinationOverlaps(row, blocker) && matches(row)
			}) {
				continue
			}
			seen[identity] = true
			if scanned == 1000 {
				truncated = true
				continue
			}
			scanned++
			if obsoleteCoordinationRecovery(ref, at, events) {
				continue
			}
			reference := object{"threadId": ref.ThreadID, "turnId": *ref.TurnID, "interruptedAt": at, "timeBasis": event["timeBasis"], "evidenceId": event["eventId"]}
			owners := []string{}
			for _, row := range events {
				if source := coordinationEventOrigin(row); source != "" && row["kind"] == "dispatch.accepted" && matches(row) {
					owners = append(owners, source)
				}
			}
			owners = axSet(owners)
			if len(owners) != 1 {
				unresolved = append(unresolved, reference)
				continue
			}
			owner := owners[0]
			if owner == clearing {
				continue
			}
			bindings := []string{}
			generations := map[string]*string{}
			for _, row := range events {
				if row["kind"] != "notice.changed" || coordinationEventOrigin(row) != owner || coordinationEventTime(row) > at || !matches(row) {
					continue
				}
				session := coordinationObserveValue(row, "sessionId")
				if session != nil && (overlap || coordinationOverlaps(row, blocker)) {
					bindings = append(bindings, *session)
				}
			}
			bindings = axSet(bindings)
			if len(bindings) != 1 {
				unresolved = append(unresolved, reference)
				continue
			}
			session := bindings[0]
			for _, row := range events {
				if row["kind"] == "notice.changed" && coordinationEventOrigin(row) == owner && coordinationEventTime(row) <= at &&
					strPtr(coordinationObserveValue(row, "sessionId")) == session && matches(row) {
					value := coordinationObserveValue(row, "sessionBindingId")
					generations[wire(value)] = value
				}
			}
			if len(generations) == 1 {
				for _, value := range generations {
					reference["sessionBindingId"] = value
				}
			}
			k := key{owner, session}
			groups[k] = append(groups[k], reference)
		}
	}
	keys := slices.Collect(maps.Keys(groups))
	slices.SortFunc(keys, func(a, b key) int {
		if n := strings.Compare(a.source, b.source); n != 0 {
			return n
		}
		return strings.Compare(a.session, b.session)
	})
	for _, key := range keys {
		recipients = append(recipients, object{"sourceId": key.source, "sessionId": key.session, "threadRefs": groups[key]})
	}
	coverage := "retained-events-only"
	if gap || truncated {
		coverage = "partial"
	}
	return object{"state": "selected", "recipients": recipients, "unresolved": unresolved, "scanned": scanned, "truncated": truncated, "coverage": coverage, "automaticResume": false}
}

var coordinationRecoveryMessenger func(object, object) error

func broadcastCoordinationRecovery(id string) error {
	clock := currentBulletinClock()
	blocker, err := withBulletinStore(func(store *bulletinStore) (object, error) {
		for _, row := range store.state.Blockers {
			if row.ID == id && row.State == "cleared" {
				value := row.project(clock, store.restarted)
				value["recoverySelection"] = row.RecoverySelection
				return value, nil
			}
		}
		return nil, nil
	})
	if err != nil || blocker == nil {
		return err
	}
	plan := obj(blocker["recoverySelection"])
	if plan == nil {
		type snapshot struct {
			events []object
			gap    bool
		}
		evidence, err := withCoordinationJournal(func(j *coordinationJournal) (snapshot, error) {
			events, gap, err := j.recoveryEvents()
			return snapshot{events, gap}, err
		})
		if err != nil {
			return err
		}
		selected := selectCoordinationRecovery(blocker, evidence.events, evidence.gap)
		plan, err = withBulletinStore(func(store *bulletinStore) (object, error) {
			for _, row := range store.state.Blockers {
				if row.ID != id {
					continue
				}
				if row.RecoverySelection == nil {
					row.RecoverySelection = selected
					if err := store.save(clock); err != nil {
						return nil, err
					}
				}
				return row.RecoverySelection, nil
			}
			return nil, nil
		})
		if err != nil {
			return err
		}
	}
	if coordinationRecordTime(blocker, "clearedAt") < clock.utc-86400000 {
		return nil
	}
	var recipients []object
	_ = unmarshalJSON([]byte(wire(plan["recipients"])), &recipients)
	for _, recipient := range recipients {
		if coordinationRecoveryMessenger != nil {
			if err := coordinationRecoveryMessenger(blocker, recipient); err != nil {
				return err
			}
		}
	}
	return nil
}
