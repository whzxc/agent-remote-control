package core

import (
	"cmp"
	"context"
	"maps"
	"slices"
)

func coordinationTerminalStatus(value any, spelling string) string {
	checkpoint := field(value, "_turnLifecycle")
	if checkpoint == nil && field(value, "terminals") != nil {
		checkpoint = value
	}
	if checkpoint != nil {
		terminal := coordinationCheckpointTerminal(checkpoint)
		if terminal == "interrupted" && spelling == "cancelled" {
			return "cancelled"
		}
		return terminal
	}
	switch spelling {
	case "completed", "failed", "interrupted", "cancelled":
		return spelling
	}
	return ""
}

func coordinationCheckpointTerminal(checkpoint any) string {
	rows := arr(field(checkpoint, "terminals"))
	if len(rows) == 0 {
		return ""
	}
	var maximum uint64
	statuses := map[string]bool{}
	unordered := map[string]bool{}
	for _, row := range rows {
		status := text(row, "status")
		if status == "cancelled" {
			status = "interrupted"
		}
		if !slices.Contains([]string{"completed", "failed", "interrupted"}, status) {
			return ""
		}
		if sequence, known := uintValue(field(row, "sequence")); known {
			if sequence > maximum {
				clear(statuses)
				maximum = sequence
			}
			if sequence == maximum {
				statuses[status] = true
			}
		} else {
			unordered[status] = true
		}
	}
	maps.Copy(statuses, unordered)
	if len(statuses) != 1 {
		return ""
	}
	for status := range statuses {
		return status
	}
	return ""
}

func coordinationScope(raw string) string {
	switch raw {
	case "completed", "failed":
		return "completed"
	case "interrupted", "cancelled":
		return "interrupted"
	case "running", "inProgress", "active", "waiting-permission", "interaction-required":
		return "running"
	default:
		return "unknown"
	}
}

func mergeBulletinLink(link *bulletinLink, turn, status string, checkpoint object) bool {
	if link.Terminals == nil {
		link.Terminals = map[string]any{}
	}
	previous := link.Terminals[turn]
	if checkpoint == nil {
		terminal := coordinationTerminalStatus(nil, status)
		if terminal != "" {
			if terminal == "cancelled" {
				terminal = "interrupted"
			}
			checkpoint = object{"agent": "codex", "threadId": link.ThreadID, "turnId": turn, "owner": nil, "lastLive": nil,
				"terminals": []any{object{"status": terminal, "sequence": nil}}}
		} else if terminal := coordinationTerminalStatus(previous, str(previous)); terminal != "" {
			return false
		}
	}
	scope := coordinationScope(status)
	if checkpoint != nil {
		checkpoint = mergeCoordinationCheckpoint(obj(previous), checkpoint)
		if len(arr(checkpoint["terminals"])) > 0 {
			scope = coordinationScope(coordinationCheckpointTerminal(checkpoint))
		}
	}
	var next any = status
	if checkpoint != nil {
		next = checkpoint
	}
	if wire(previous) == wire(next) && (strPtr(link.ObservedTurnID) != turn || link.ScopeState == scope) {
		return false
	}
	if previous == nil && len(link.Terminals) >= 16 {
		for _, key := range slices.Sorted(maps.Keys(link.Terminals)) {
			if strPtr(link.ObservedTurnID) != key {
				delete(link.Terminals, key)
				break
			}
		}
	}
	link.Terminals[turn] = next
	if strPtr(link.ObservedTurnID) == turn {
		link.ScopeState = scope
	}
	return true
}

func bulletinFromTurn(input coordinationEventInput) error {
	if input.Kind != "turn.terminal" && input.Kind != "turn.successor" {
		return nil
	}
	_, err := withBulletinStore(func(store *bulletinStore) (struct{}, error) {
		return struct{}{}, store.observeTurnEvent(input, currentBulletinClock())
	})
	return err
}

func (store *bulletinStore) observeTurnEvent(input coordinationEventInput, clock bulletinClock) error {
	updated := false
	for _, notice := range store.liveNotices {
		for i := range notice.ThreadLinks {
			link := &notice.ThreadLinks[i]
			if input.Kind == "turn.successor" {
				if len(input.ThreadRefs) != 2 || input.Origin == nil || !sameCoordinationOwner(notice.Owner, *input.Origin) {
					continue
				}
				prior, next := input.ThreadRefs[0], input.ThreadRefs[1]
				if link.ThreadID == prior.ThreadID && prior.ThreadID == next.ThreadID && prior.TurnID != nil && next.TurnID != nil && samePointer(prior.TurnID, link.ObservedTurnID) {
					link.ObservedTurnID = next.TurnID
					known := link.Terminals[*next.TurnID]
					link.ScopeState = coordinationScope(coordinationTerminalStatus(known, str(known)))
					updated = true
				}
				continue
			}
			for _, ref := range input.ThreadRefs {
				if ref.ThreadID == link.ThreadID && ref.TurnID != nil && coordinationTerminalStatus(nil, strPtr(input.Status)) != "" {
					updated = mergeBulletinLink(link, *ref.TurnID, strPtr(input.Status), nil) || updated
				}
			}
		}
	}
	if updated {
		return store.save(clock)
	}
	return nil
}

type coordinationLiveTurn struct {
	Thread, Turn, Status string
	Checkpoint           object
}

var coordinationLiveTurns func(context.Context, *service, []string) []coordinationLiveTurn

func bulletinTick(ctx context.Context, service *service) error {
	if err := maintainBulletin(ctx); err != nil {
		return err
	}
	if coordinationLiveTurns != nil {
		cost := currentRuntimeCost(ctx)
		keys, err := withBulletinStore(func(store *bulletinStore) ([]string, error) {
			return store.linkedThreads(cost), nil
		})
		if err != nil {
			return err
		}
		live := coordinationLiveTurns(ctx, service, keys)
		_, err = withBulletinStore(func(store *bulletinStore) (struct{}, error) {
			return struct{}{}, store.observeLiveTurns(live, currentBulletinClock(), cost)
		})
		if err != nil {
			return err
		}
	}
	if err := maintainBulletin(ctx); err != nil {
		return err
	}
	return reconcileBulletin()
}

func (store *bulletinStore) observeLiveTurns(live []coordinationLiveTurn, clock bulletinClock, cost *runtimeCost) error {
	for _, notice := range store.liveNotices {
		cost.rows.Add(1)
		for i := range notice.ThreadLinks {
			link := &notice.ThreadLinks[i]
			current, previousScope := strPtr(link.ObservedTurnID), link.ScopeState
			observed := false
			for _, turn := range live {
				if turn.Thread != link.ThreadID || !coordinationIdentifier(turn.Turn) {
					continue
				}
				cost.rows.Add(1)
				store.dirty = mergeBulletinLink(link, turn.Turn, turn.Status, turn.Checkpoint) || store.dirty
				if turn.Turn == current {
					observed = true
				}
			}
			if !observed && link.ScopeState == "running" {
				store.dirty = mergeBulletinLink(link, current, "unknown", nil) || store.dirty
			}
			if observed && clock.certain && link.ScopeState != "unknown" && (link.ScopeState == "running" || link.ScopeState != previousScope) {
				link.ObservedAt = new(clock.elapsed)
				notice.LastActiveAt, notice.freshActivity = max(notice.LastActiveAt, clock.elapsed), true
				store.dirty = true
			}
		}
	}
	if store.dirty {
		store.maintainedAt = 0
	}
	return store.flush(clock)
}

func init() {
	coordinationEventProjections = append(coordinationEventProjections, bulletinFromTurn)
}

func mergeCoordinationCheckpoint(previous, incoming object) object {
	result := clone(incoming)
	records := append(slices.Clone(arr(incoming["terminals"])), arr(previous["terminals"])...)
	var newest uint64
	for _, record := range records {
		if seq, ok := uintValue(field(record, "sequence")); ok {
			newest = max(newest, seq)
		}
	}
	terminals := []any{}
	for _, record := range records {
		seq, known := uintValue(field(record, "sequence"))
		if known && seq != newest {
			continue
		}
		if !slices.ContainsFunc(terminals, func(row any) bool { return wire(row) == wire(record) }) {
			terminals = append(terminals, record)
		}
	}
	rank := func(value any) int {
		switch str(value) {
		case "completed":
			return 0
		case "failed":
			return 1
		case "interrupted", "cancelled":
			return 2
		}
		return 3
	}
	slices.SortFunc(terminals, func(a, b any) int {
		if order := cmp.Compare(rank(field(a, "status")), rank(field(b, "status"))); order != 0 {
			return order
		}
		if field(a, "sequence") == nil && field(b, "sequence") != nil {
			return -1
		}
		if field(a, "sequence") != nil && field(b, "sequence") == nil {
			return 1
		}
		return 0
	})
	result["terminals"] = terminals
	ownerRank := func(value any) int {
		switch field(value, "state") {
		case "running":
			return 4
		case "interaction-required":
			return 5
		case "unconfirmed":
			switch field(value, "reason") {
			case "turn-not-found":
				return 1
			case "runtime-ownership-unknown":
				return 2
			case "inconsistent-native-state":
				return 3
			}
		}
		return 0
	}
	for _, key := range []string{"owner", "lastLive"} {
		old, current := previous[key], result[key]
		if old == nil {
			continue
		}
		oldRev, newRev := uintOr(field(old, "revision"), 0), uintOr(field(current, "revision"), 0)
		if current == nil || oldRev > newRev || oldRev == newRev && ownerRank(old) > ownerRank(current) {
			result[key] = old
		}
	}
	return result
}
