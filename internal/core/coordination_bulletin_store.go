package core

import (
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"time"
)

const bulletinInactiveMS = 6 * 60 * 60 * 1000
const bulletinRetentionMS = 7 * 86400 * 1000
const bulletinSnapshotBytes = 2 * 1024 * 1024

var errBulletinCorrupt = errors.New("COORDINATION_CORRUPT: preserve coordination/state.json for local recovery")
var errBulletinCursor = errors.New("COORDINATION_CURSOR_EXPIRED: restart board pagination")
var bulletinClockStart = time.Now()

type bulletinClock struct {
	utc, elapsed int64
	certain      bool
}

func currentBulletinClock() bulletinClock {
	now := time.Now()
	utc, elapsed := now.UnixMilli(), bulletinClockStart.UnixMilli()+now.Sub(bulletinClockStart).Milliseconds()
	return bulletinClock{utc, elapsed, utc-elapsed < 60000 && elapsed-utc < 60000}
}

func (clock bulletinClock) age(at int64) *uint64 {
	if !clock.certain || clock.elapsed < at {
		return nil
	}
	return new(uint64((clock.elapsed - at) / 1000))
}

type bulletinApplied struct {
	Digest string `json:"digest"`
	Result object `json:"result"`
	At     int64  `json:"at"`
}
type bulletinSession struct {
	ID           string                `json:"id"`
	Owner        coordinationPrincipal `json:"owner"`
	CreatedAt    int64                 `json:"createdAt"`
	LastActiveAt int64                 `json:"lastActiveAt"`
	State        string                `json:"state"`
	Route        *coordinationRoute    `json:"route,omitempty"`
	RouteFailure *string               `json:"routeFailure,omitempty"`
}

func (session bulletinSession) projection() object {
	return object{"id": session.ID, "owner": session.Owner, "state": session.State, "createdAt": coordinationTimestamp(session.CreatedAt), "lastActiveAt": coordinationTimestamp(session.LastActiveAt)}
}

type bulletinLink struct {
	ThreadID         string         `json:"threadId"`
	SessionBindingID *string        `json:"sessionBindingId"`
	ObservedTurnID   *string        `json:"observedTurnId"`
	ScopeState       string         `json:"scopeState"`
	ObservedAt       *int64         `json:"observedAt"`
	Terminals        map[string]any `json:"terminals"`
}

type bulletinRecord struct {
	ID                string                           `json:"id"`
	DispatchID        *string                          `json:"dispatchId,omitempty"`
	Association       *coordinationDispatchAssociation `json:"association,omitempty"`
	Revision          uint64                           `json:"revision"`
	Owner             coordinationPrincipal            `json:"owner"`
	OwnerSessionID    *string                          `json:"ownerSessionId"`
	Resources         []string                         `json:"resources"`
	Intent            *string                          `json:"intent"`
	ExpectedDuration  *uint64                          `json:"expectedDurationSeconds"`
	ThreadLinks       []bulletinLink                   `json:"threadLinks"`
	CauseCode         *string                          `json:"causeCode"`
	Summary           *string                          `json:"summary"`
	EvidenceIDs       []string                         `json:"evidenceIds"`
	FixingCommit      object                           `json:"fixingCommit"`
	Reason            *string                          `json:"reason"`
	SuggestedNextStep *string                          `json:"suggestedNextStep"`
	CreatedAt         int64                            `json:"createdAt"`
	LastActiveAt      int64                            `json:"lastActiveAt"`
	State             string                           `json:"state"`
	ClosedReason      *string                          `json:"closedReason"`
	EndedAt           *int64                           `json:"endedAt"`
	RecoverySelection object                           `json:"recoverySelection"`
	ClearedBy         *coordinationPrincipal           `json:"clearedBy"`
	freshActivity     bool
}

func (row *bulletinRecord) live() bool {
	return row.State != "closed" && row.State != "withdrawn" && row.State != "cleared"
}
func sameCoordinationOwner(a, b coordinationPrincipal) bool {
	return a.Type == b.Type && (a.Type == "local-authority" || a.Type == "source" && a.SourceID == b.SourceID)
}
func (row *bulletinRecord) project(clock bulletinClock, restarted bool) object {
	age := clock.age(row.LastActiveAt)
	coverage := "observed"
	if age == nil {
		coverage = "clock-uncertain"
	} else if slices.ContainsFunc(row.ThreadLinks, func(link bulletinLink) bool {
		return slices.Contains([]string{"unknown", "unconfirmed", "conflict", "interrupted"}, link.ScopeState)
	}) {
		coverage = "thread-observation-gap"
	} else if restarted && !row.freshActivity {
		coverage = "restart-gap"
	}
	result := object{"id": row.ID, "revision": row.Revision, "ownerSessionId": row.OwnerSessionID, "resources": row.Resources,
		"createdAt": coordinationTimestamp(row.CreatedAt), "lastActiveAt": coordinationTimestamp(row.LastActiveAt),
		"inactivityAgeSeconds": age, "observedAt": coordinationTimestamp(clock.utc), "activityCoverage": coverage, "state": row.State}
	if row.Owner.Type == "local-authority" {
		result["localOrigin"] = true
	} else if row.Owner.Type == "source" {
		result["ownerSourceId"] = row.Owner.SourceID
	} else {
		result["ownerSourceId"] = nil
	}
	if row.DispatchID != nil {
		result["dispatchId"], result["provenance"], result["association"] = *row.DispatchID, "dispatch-derived", row.Association
	}
	if row.Intent != nil {
		links := []object{}
		for _, link := range row.ThreadLinks {
			links = append(links, object{"threadId": link.ThreadID, "observedTurnId": link.ObservedTurnID, "scopeState": link.ScopeState})
		}
		result["intent"], result["expectedDurationSeconds"], result["threadLinks"], result["closedReason"] = row.Intent, row.ExpectedDuration, links, row.ClosedReason
	} else {
		result["causeCode"], result["summary"], result["provenance"] = row.CauseCode, row.Summary, "source-reported"
		result["openedAt"], result["clearedAt"] = coordinationTimestamp(row.CreatedAt), nil
		if row.EndedAt != nil {
			result["clearedAt"] = coordinationTimestamp(*row.EndedAt)
		}
		result["fixingCommit"], result["reason"], result["evidenceIds"], result["suggestedNextStep"], result["clearedBy"] = row.FixingCommit, row.Reason, row.EvidenceIDs, row.SuggestedNextStep, row.ClearedBy
		result["recoverySelection"] = publicCoordinationRecovery(row.RecoverySelection)
	}
	return result
}

type bulletinState struct {
	Epoch                            string                     `json:"epoch"`
	Revision                         uint64                     `json:"revision"`
	DispatchAdmissionCleanupComplete bool                       `json:"dispatchAdmissionCleanupComplete"`
	Notices                          []*bulletinRecord          `json:"notices"`
	Blockers                         []*bulletinRecord          `json:"blockers"`
	Sessions                         []*bulletinSession         `json:"sessions"`
	Applied                          map[string]bulletinApplied `json:"applied"`
	Pending                          []coordinationEventInput   `json:"pending"`
	Budgets                          map[string][2]int64        `json:"budgets"`
}

type bulletinStore struct {
	path                         string
	state                        bulletinState
	restarted, dirty             bool
	savedAt                      int64
	maintainedAt, maintenanceDue int64
	revoked                      []string
}

func openBulletinStore(path string) (*bulletinStore, error) {
	store := &bulletinStore{path: path}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		store.state = bulletinState{Epoch: id(), DispatchAdmissionCleanupComplete: true, Notices: []*bulletinRecord{}, Blockers: []*bulletinRecord{},
			Sessions: []*bulletinSession{}, Applied: map[string]bulletinApplied{}, Pending: []coordinationEventInput{}, Budgets: map[string][2]int64{}}
		return store, nil
	}
	if err != nil {
		return nil, errors.New("COORDINATION_STORAGE: cannot read bulletin")
	}
	if info.Size() > bulletinSnapshotBytes {
		return nil, errors.New("COORDINATION_CAPACITY: bulletin snapshot exceeds budget")
	}
	data, err := os.ReadFile(path)
	if err != nil || decodeCoordinationRecord(data, &store.state) != nil {
		return nil, errBulletinCorrupt
	}
	state := store.state
	if len(state.Notices) > 256 || len(state.Blockers) > 128 || len(state.Sessions) > 128 || len(state.Pending) > 512 || len(state.Applied) > 2048 ||
		state.Notices == nil || state.Blockers == nil || state.Sessions == nil || state.Applied == nil || state.Pending == nil || state.Budgets == nil {
		return nil, errBulletinCorrupt
	}
	for _, rows := range [][]*bulletinRecord{state.Notices, state.Blockers} {
		for _, row := range rows {
			if row == nil || !coordinationIdentifier(row.ID) || len(row.Resources) > 16 ||
				len(row.Resources) == 0 && (row.DispatchID == nil || row.Association == nil || len(row.Association.Resources) > 0) ||
				len(row.ThreadLinks) > 16 {
				return nil, errBulletinCorrupt
			}
			for _, link := range row.ThreadLinks {
				if len(link.Terminals) > 16 {
					return nil, errBulletinCorrupt
				}
			}
		}
	}
	for _, session := range state.Sessions {
		if session == nil {
			return nil, errBulletinCorrupt
		}
	}
	for _, row := range state.Notices {
		for i := range row.ThreadLinks {
			if row.ThreadLinks[i].ScopeState == "running" || row.ThreadLinks[i].ScopeState == "active" || row.ThreadLinks[i].ScopeState == "awaiting-interaction" {
				row.ThreadLinks[i].ScopeState = "unknown"
			}
		}
	}
	store.restarted = true
	return store, nil
}

func (store *bulletinStore) save(clock bulletinClock) error {
	bytes := []byte(wire(store.state))
	if len(bytes) > bulletinSnapshotBytes {
		return errors.New("COORDINATION_CAPACITY: bulletin snapshot exceeds budget")
	}
	if err := coordinationAtomicBytes(store.path, bytes); err != nil {
		return err
	}
	store.dirty = false
	store.savedAt = clock.elapsed
	store.maintainedAt = 0
	return nil
}

func (store *bulletinStore) event(row *bulletinRecord, blocker bool) error {
	resources := row.Resources
	if len(resources) == 0 && row.DispatchID != nil {
		resources = []string{"unattributed:dispatch"}
	}
	status, kind, evidence := row.State, "notice.changed", "notice"
	if blocker {
		kind, evidence = "blocker.changed", "blocker"
	}
	event := newCoordinationEvent(fmt.Sprintf("bulletin-%s-%d", row.ID, row.Revision), kind, resources)
	event.Origin, event.Status = &row.Owner, &status
	event.EvidenceRefs = append(event.EvidenceRefs, coordinationEvidenceRef{evidence, row.ID})
	chunk := 4
	if !blocker {
		event.Observation = &coordinationObservation{SessionID: row.OwnerSessionID}
		if len(row.ThreadLinks) > 0 {
			chunk = 2
			event.Observation.SessionBindingID = row.ThreadLinks[0].SessionBindingID
			for _, link := range row.ThreadLinks {
				event.ThreadRefs = append(event.ThreadRefs, coordinationThreadRef{link.ThreadID, link.ObservedTurnID})
			}
		}
	}
	if len(store.state.Pending)+(len(resources)+chunk-1)/chunk*max(1, len(row.ThreadLinks)) > 512 {
		return errors.New("COORDINATION_CAPACITY: pull board to reconcile pending events")
	}
	for start := 0; start < len(resources); start += chunk {
		part := event
		part.Resources = resources[start:min(start+chunk, len(resources))]
		part.TransitionID = fmt.Sprintf("%s-%d", event.TransitionID, start/chunk)
		if len(part.ThreadRefs) == 0 {
			store.state.Pending = append(store.state.Pending, part)
		} else {
			for index, ref := range part.ThreadRefs {
				linked := part
				linked.ThreadRefs = []coordinationThreadRef{ref}
				linked.TransitionID = fmt.Sprintf("%s-%d", part.TransitionID, index)
				store.state.Pending = append(store.state.Pending, linked)
			}
		}
	}
	store.state.Revision++
	return nil
}

func (store *bulletinStore) prune(clock bulletinClock) {
	expired := func(at int64, seconds uint64) bool { age := clock.age(at); return age != nil && *age >= seconds }
	before := len(store.state.Notices) + len(store.state.Blockers) + len(store.state.Sessions)
	discard := func(row *bulletinRecord) bool {
		if row.EndedAt == nil || !expired(*row.EndedAt, bulletinRetentionMS/1000) {
			return false
		}
		for _, event := range store.state.Pending {
			for _, ref := range event.EvidenceRefs {
				if ref.ID == row.ID {
					return false
				}
			}
		}
		return true
	}
	store.state.Notices = slices.DeleteFunc(store.state.Notices, discard)
	store.state.Blockers = slices.DeleteFunc(store.state.Blockers, discard)
	store.state.Sessions = slices.DeleteFunc(store.state.Sessions, func(s *bulletinSession) bool {
		return s.State != "active" && expired(s.LastActiveAt, bulletinRetentionMS/1000)
	})
	maps.DeleteFunc(store.state.Applied, func(_ string, a bulletinApplied) bool { return expired(a.At, bulletinRetentionMS/1000) })
	maps.DeleteFunc(store.state.Budgets, func(_ string, bucket [2]int64) bool { return clock.elapsed-bucket[0] >= 60000 })
	if before != len(store.state.Notices)+len(store.state.Blockers)+len(store.state.Sessions) {
		store.state.Revision++
	}
}

func (store *bulletinStore) maintain(clock bulletinClock, revoked []string, cost *runtimeCost) error {
	if clock.certain && store.maintainedAt != 0 && clock.elapsed >= store.maintainedAt && (store.maintenanceDue == 0 || clock.elapsed < store.maintenanceDue) && slices.Equal(revoked, store.revoked) {
		return store.flush(clock)
	}
	changed := false
	due := int64(0)
	schedule := func(at int64) {
		if at > clock.elapsed && (due == 0 || at < due) {
			due = at
		}
	}
	for index, rows := range [][]*bulletinRecord{store.state.Notices, store.state.Blockers} {
		blocker := index == 1
		for _, row := range rows {
			if !row.live() {
				if row.EndedAt != nil {
					schedule(*row.EndedAt + bulletinRetentionMS)
					if clock.certain && clock.elapsed-*row.EndedAt >= bulletinRetentionMS {
						changed = true
					}
				}
				continue
			}
			cost.rows.Add(1)
			isRevoked := row.Owner.Type == "source" && slices.Contains(revoked, row.Owner.SourceID)
			age := clock.age(row.LastActiveAt)
			inactive := age != nil && *age >= bulletinInactiveMS/1000
			ended := len(row.ThreadLinks) > 0 && !slices.ContainsFunc(row.ThreadLinks, func(link bulletinLink) bool {
				return !slices.Contains([]string{"completed", "failed", "ended"}, link.ScopeState)
			})
			state, reason := row.State, ""
			switch {
			case blocker && isRevoked:
				state, reason = "uncertain", "source-revoked"
			case blocker && inactive:
				state, reason = "stale", "owner-inactive"
			case !blocker && isRevoked:
				state, reason = "closed", "source-revoked"
			case !blocker && ended:
				state, reason = "closed", "threads-ended"
			case !blocker && inactive:
				state, reason = "withdrawn", "owner-inactive"
			}
			schedule(row.LastActiveAt + bulletinInactiveMS)
			if state == row.State {
				continue
			}
			row.State, row.ClosedReason = state, &reason
			row.Revision++
			if blocker && state == "stale" {
				row.RecoverySelection = staleBlockerRecovery()
			}
			if !blocker {
				row.EndedAt = new(clock.utc)
				schedule(clock.utc + bulletinRetentionMS)
			}
			if err := store.event(row, blocker); err != nil {
				return err
			}
			changed = true
		}
	}
	if changed {
		store.prune(clock)
		if err := store.save(clock); err != nil {
			return err
		}
	} else if err := store.flush(clock); err != nil {
		return err
	}
	store.maintainedAt, store.maintenanceDue, store.revoked = clock.elapsed, due, slices.Clone(revoked)
	return nil
}

func (store *bulletinStore) flush(clock bulletinClock) error {
	if store.dirty && clock.elapsed-store.savedAt >= 60000 {
		return store.save(clock)
	}
	return nil
}

func (store *bulletinStore) conflicts(resources []string, exclude, source string, clock bulletinClock) []object {
	result := []object{}
	for _, resource := range resources {
		if resource == "unattributed:dispatch" {
			continue
		}
		for index, rows := range [][]*bulletinRecord{store.state.Notices, store.state.Blockers} {
			kind := "notice"
			if index == 1 {
				kind = "blocker"
			}
			for _, row := range rows {
				if len(result) == 100 {
					return result
				}
				if row.ID == exclude || source != "" && row.Owner.SourceID == source || index == 0 && row.State != "active" ||
					index == 1 && !row.live() || !slices.Contains(row.Resources, resource) {
					continue
				}
				result = append(result, object{"id": row.ID, kind + "Id": row.ID, "kind": kind, "resource": resource, "state": row.State,
					"lastActiveAt": coordinationTimestamp(row.LastActiveAt), "inactivityAgeSeconds": clock.age(row.LastActiveAt),
					"boardRead": object{"via": "query", "op": "board", "args": object{"id": row.ID, "view": "full"}}})
			}
		}
	}
	return result
}

func bulletinConflictCoverage(conflicts []object) string {
	if len(conflicts) == 100 {
		return "partial"
	}
	return "observed"
}

func (store *bulletinStore) advisory(resources []string, source string, clock bulletinClock) object {
	rows := store.conflicts(resources, "", source, clock)
	return object{"conflictCoverage": bulletinConflictCoverage(rows), "conflicts": rows, "boardRevision": object{"epoch": store.state.Epoch, "revision": store.state.Revision},
		"boardRead": object{"via": "query", "op": "board", "args": object{}}, "observedAt": coordinationTimestamp(clock.utc)}
}

func (store *bulletinStore) replay(request, digest string) (object, error) {
	applied, ok := store.state.Applied[request]
	if !ok {
		return nil, nil
	}
	if applied.Digest != digest {
		return nil, errors.New("REQUEST_ID_CONFLICT: retry the original arguments and requestId")
	}
	return clone(applied.Result), nil
}

func (store *bulletinStore) mutate(op string, args object, reader coordinationReader, links []bulletinLink, routing *coordinationRouteOutcome, clock bulletinClock) (object, error) {
	request, digest := text(args, "requestId"), bulletinDigest(op, args, reader)
	if result, err := store.replay(request, digest); err != nil || result != nil {
		return result, err
	}
	store.prune(clock)
	if len(store.state.Applied) >= 2048 {
		return nil, errors.New("COORDINATION_CAPACITY: retain original receipts; retry after closed history retention")
	}
	actor := reader.principal
	key := actor.SourceID
	if key == "" {
		key = "local-authority"
	}
	bucket, exists := store.state.Budgets[key]
	if !exists || clock.elapsed-bucket[0] >= 60000 {
		bucket = [2]int64{clock.elapsed, 0}
	}
	if bucket[1] >= 30 {
		return nil, errors.New("COORDINATION_RATE_LIMIT: retry the same requestId after one minute")
	}
	bucket[1]++
	store.state.Budgets[key] = bucket
	var result object
	var err error
	if op == "coordination_session" {
		result, err = store.applySession(args, actor, routing, clock)
	} else {
		result, err = store.apply(op, args, actor, links, clock)
	}
	if err != nil {
		return nil, err
	}
	store.state.Applied[request] = bulletinApplied{digest, clone(result), clock.utc}
	return result, store.save(clock)
}

func (store *bulletinStore) applySession(args object, actor coordinationPrincipal, routing *coordinationRouteOutcome, clock bulletinClock) (object, error) {
	store.state.Revision++
	sessionID := text(args, "sessionId")
	if args["action"] == "register" {
		active, recent := 0, 0
		for _, row := range store.state.Sessions {
			if sameCoordinationOwner(row.Owner, actor) {
				if row.State == "active" {
					active++
				}
				if age := clock.age(row.CreatedAt); age == nil || *age < 3600 {
					recent++
				}
			}
		}
		if len(store.state.Sessions) >= 128 || active >= 8 || recent >= 4 {
			return nil, errors.New("COORDINATION_CAPACITY: close unused sessions; at most four registrations per hour and eight active sessions per source")
		}
		session := &bulletinSession{ID: id(), Owner: actor, CreatedAt: clock.utc, LastActiveAt: clock.elapsed, State: "active"}
		if routing != nil {
			if routing.route == nil {
				session.RouteFailure = new(routing.state)
			} else {
				route := *routing.route
				route.BindingID = new(id())
				session.Route = &route
			}
		}
		store.state.Sessions = append(store.state.Sessions, session)
		return object{"session": session.projection()}, nil
	}
	for _, session := range store.state.Sessions {
		if session.ID != sessionID {
			continue
		}
		if !sameCoordinationOwner(session.Owner, actor) && actor.Type != "local-authority" {
			return nil, errors.New("COORDINATION_OWNER_REQUIRED: only the session owner or local authority may close it")
		}
		session.State, session.Route, session.RouteFailure = "closed", nil, nil
		return object{"session": session.projection()}, nil
	}
	return nil, errors.New("COORDINATION_NOT_FOUND: read board sessions")
}

func (store *bulletinStore) apply(op string, args object, actor coordinationPrincipal, links []bulletinLink, clock bulletinClock) (object, error) {
	blocker := strings.HasPrefix(op, "blocker_")
	kind, rows, totalLimit, ownerLimit := "notice", &store.state.Notices, 256, 16
	if blocker {
		kind, rows, totalLimit, ownerLimit = "blocker", &store.state.Blockers, 128, 8
	}
	project := func(row *bulletinRecord, includeConflicts bool) object {
		result := object{kind: row.project(clock, store.restarted)}
		if includeConflicts {
			conflicts := store.conflicts(row.Resources, row.ID, "", clock)
			result["conflicts"], result["conflictCoverage"] = conflicts, bulletinConflictCoverage(conflicts)
		}
		return result
	}
	if op == "notice_post" || op == "blocker_open" {
		session := axOptional(args["sessionId"])
		if session != nil && !slices.ContainsFunc(store.state.Sessions, func(row *bulletinSession) bool {
			return row.ID == *session && row.State == "active" && sameCoordinationOwner(row.Owner, actor)
		}) {
			return nil, errors.New("COORDINATION_OWNER_REQUIRED: register or select your active coordination session")
		}
		owned := 0
		for _, row := range *rows {
			if row.live() && sameCoordinationOwner(row.Owner, actor) {
				owned++
			}
		}
		if len(*rows) >= totalLimit || owned >= ownerLimit {
			return nil, errors.New("COORDINATION_CAPACITY: close completed work and retain terminal history for seven days")
		}
		row := &bulletinRecord{ID: id(), Revision: 1, Owner: actor, OwnerSessionID: session, Resources: axStrings(args["resources"]), Intent: axOptional(args["intent"]),
			ThreadLinks: links, CauseCode: axOptional(args["causeCode"]), Summary: axOptional(args["summary"]), EvidenceIDs: axStrings(args["evidenceIds"]),
			CreatedAt: clock.utc, LastActiveAt: clock.elapsed, freshActivity: true, State: "active"}
		if seconds, ok := uintValue(args["expectedDurationSeconds"]); ok {
			row.ExpectedDuration = &seconds
		}
		if err := store.event(row, blocker); err != nil {
			return nil, err
		}
		result := project(row, true)
		*rows = append(*rows, row)
		return result, nil
	}
	for _, row := range *rows {
		if row.ID != text(args, "id") {
			continue
		}
		if !sameCoordinationOwner(row.Owner, actor) && actor.Type != "local-authority" {
			return nil, errors.New("COORDINATION_OWNER_REQUIRED: only the owner or local authority may change this record")
		}
		if !row.live() {
			if op == "notice_close" || op == "blocker_clear" {
				return project(row, false), nil
			}
			return nil, errors.New("COORDINATION_STATE_CONFLICT: post a new notice for a new work scope")
		}
		if revision, ok := uintValue(args["expectedRevision"]); op != "notice_close" && (!ok || revision != row.Revision) {
			return nil, errors.New("COORDINATION_REVISION_CONFLICT: read board and use the current revision")
		}
		switch op {
		case "notice_update":
			if intent := axOptional(args["intent"]); intent != nil {
				row.Intent = intent
			}
			if arr(args["resources"]) != nil {
				row.Resources = axStrings(args["resources"])
			}
			if arr(args["threadIds"]) != nil {
				row.ThreadLinks = links
			}
			if seconds, ok := uintValue(args["expectedDurationSeconds"]); ok {
				row.ExpectedDuration = &seconds
			}
			if clock.certain {
				row.LastActiveAt = clock.elapsed
			}
		case "notice_close":
			row.State, row.EndedAt = "closed", new(clock.utc)
			row.ClosedReason = axOptional(args["reason"])
			if row.ClosedReason == nil {
				row.ClosedReason = new("owner-closed")
			}
		case "blocker_clear":
			row.ClearedBy = &actor
			if row.State == "stale" {
				row.RecoverySelection = staleBlockerRecovery()
			}
			row.State, row.EndedAt = "cleared", new(clock.utc)
			row.FixingCommit = obj(args["fixingCommit"])
			row.Reason, row.EvidenceIDs, row.SuggestedNextStep = axOptional(args["reason"]), axStrings(args["evidenceIds"]), axOptional(args["suggestedNextStep"])
		default:
			return nil, errors.New("INVALID_ARGUMENT: read guide for bulletin operations")
		}
		row.Revision++
		if err := store.event(row, blocker); err != nil {
			return nil, err
		}
		result := project(row, !blocker)
		if blocker {
			result["recoverySelection"] = publicCoordinationRecovery(row.RecoverySelection)
		}
		return result, nil
	}
	return nil, errors.New("COORDINATION_NOT_FOUND: read board for the current record")
}

func (store *bulletinStore) board(args object, reader coordinationReader, clock bulletinClock) (object, error) {
	resource := text(args, "resource")
	if resource != "" {
		retained := []string{}
		for _, rows := range [][]*bulletinRecord{store.state.Notices, store.state.Blockers} {
			for _, row := range rows {
				retained = append(retained, row.Resources...)
			}
		}
		var err error
		resource, err = resolveCoordinationResource(resource, retained)
		if err != nil {
			return nil, err
		}
	}
	filters := maps.Clone(args)
	delete(filters, "cursor")
	scope := hash([]byte(wire([]any{store.state.Epoch, store.state.Revision, reader.revision, filters})))
	offset := uint64(0)
	if cursor := text(args, "cursor"); cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		var decoded object
		if err != nil || decodeObject(data, &decoded) != nil || decoded["scope"] != scope {
			return nil, errBulletinCursor
		}
		at, ok := uintValue(decoded["at"])
		if age := clock.age(int64(at)); !ok || age == nil || *age > 900 {
			return nil, errBulletinCursor
		}
		if offset, ok = uintValue(decoded["offset"]); !ok {
			return nil, errBulletinCursor
		}
	}
	type item struct {
		blocker bool
		row     *bulletinRecord
	}
	all := []item{}
	for index, rows := range [][]*bulletinRecord{store.state.Notices, store.state.Blockers} {
		for _, row := range rows {
			if resource != "" && !slices.Contains(row.Resources, resource) {
				continue
			}
			if id := text(args, "id"); id != "" && row.ID != id {
				continue
			}
			switch status := text(args, "state"); status {
			case "":
				if !row.live() && args["id"] == nil {
					continue
				}
			case "all":
			default:
				if row.State != status {
					continue
				}
			}
			all = append(all, item{index == 1, row})
		}
	}
	notices, blockers, lines := []object{}, []object{}, []string{}
	var sessions []object
	if args["includeSessions"] == true {
		sessions = make([]object, 0, len(store.state.Sessions))
		for _, session := range store.state.Sessions {
			sessions = append(sessions, session.projection())
		}
	}
	size, count := 512+len(wire(sessions)), uint64(0)
	for _, item := range all[min(offset, uint64(len(all))):] {
		if count >= uintOr(args["limit"], 50) {
			break
		}
		n := item.row
		projection := n.project(clock, store.restarted)
		if args["view"] != "full" {
			projection = selectFields(projection, "id", "revision", "dispatchId", "provenance", "association", "ownerSourceId", "localOrigin",
				"ownerSessionId", "lastActiveAt", "inactivityAgeSeconds", "observedAt", "activityCoverage", "state")
		}
		if args["view"] == nil || args["view"] == "digest" {
			projection["conflictCount"] = len(store.conflicts(n.Resources, n.ID, "", clock))
		}
		if sameCoordinationOwner(n.Owner, reader.principal) {
			projection["mine"] = true
		}
		age := "unknown"
		if seconds := clock.age(n.LastActiveAt); seconds != nil {
			age = fmt.Sprintf("%ds", *seconds)
		}
		kind, label := "notice", strPtr(n.Intent)
		if item.blocker {
			kind, label = "blocker", strPtr(n.Summary)
		}
		line := fmt.Sprintf("%s %s %s age=%s %s %s", kind, n.ID, n.State, age, strings.Join(n.Resources, ","), label)
		size += len(wire(projection)) + len(line) + 8
		if size > 120*1024 {
			break
		}
		if item.blocker {
			blockers = append(blockers, projection)
		} else {
			notices = append(notices, projection)
		}
		lines = append(lines, line)
		count++
	}
	var next any
	if offset+count < uint64(len(all)) {
		next = base64.RawURLEncoding.EncodeToString([]byte(wire(object{"scope": scope, "at": clock.utc, "offset": offset + count})))
	}
	coverage := "observed"
	if !clock.certain {
		coverage = "clock-uncertain"
	}
	result := object{"notices": notices, "blockers": blockers, "summary": strings.Join(lines, "\n"), "nextCursor": next, "observedAt": coordinationTimestamp(clock.utc), "activityCoverage": coverage}
	if sessions != nil {
		result["sessions"] = sessions
	}
	return result, nil
}

func (store *bulletinStore) attention(reader coordinationReader) []object {
	items := []object{}
	for _, row := range store.state.Blockers {
		if len(items) == 20 {
			break
		}
		if !row.live() || (reader.principal.Type != "local-authority" && !sameCoordinationOwner(row.Owner, reader.principal)) {
			continue
		}
		item := object{"kind": "blocker", "id": row.ID, "revision": row.Revision, "state": row.State, "resources": row.Resources, "summary": row.Summary,
			"next": object{"via": "query", "op": "board", "args": object{"id": row.ID, "view": "full"}}}
		if row.Owner.Type == "source" {
			item["ownerSourceId"] = row.Owner.SourceID
		}
		items = append(items, item)
	}
	return items
}

func (store *bulletinStore) recipientResources(source string) []string {
	result := []string{}
	for index, rows := range [][]*bulletinRecord{store.state.Notices, store.state.Blockers} {
		for _, row := range rows {
			if row.Owner.SourceID == source && (index == 0 && row.State == "active" || index == 1 && row.State != "cleared") {
				result = append(result, row.Resources...)
			}
		}
	}
	return result
}
