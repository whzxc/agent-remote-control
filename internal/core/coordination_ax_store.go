package core

import (
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const axEntryBytes = 16 * 1024
const axSnapshotBytes = 8 * 1024 * 1024
const axMaxEntries = 1000

var errAXCapacity = errors.New("COORDINATION_CAPACITY: export closed AX records with cli ax export --to <path>; preserve open records and required history")
var errAXCorrupt = errors.New("COORDINATION_CORRUPT: preserve coordination/ax for explicit local recovery")
var axVerificationOps = []string{"command", "review", "native", "agent_review"}

type axEntry struct {
	ID                 string                   `json:"id"`
	Revision           uint64                   `json:"revision"`
	Kind               string                   `json:"kind"`
	Symptom            string                   `json:"symptom"`
	Expected           string                   `json:"expected"`
	ReproductionHints  string                   `json:"reproductionHints"`
	Severity           *string                  `json:"severity"`
	Resources          []string                 `json:"resources"`
	Source             object                   `json:"source"`
	ARCVersion         *string                  `json:"arcVersion"`
	Evidence           []object                 `json:"evidence"`
	FirstSeenAt        *string                  `json:"firstSeenAt"`
	LastSeenAt         *string                  `json:"lastSeenAt"`
	OccurrenceCount    uint64                   `json:"occurrenceCount"`
	CandidateState     *string                  `json:"candidateState"`
	Status             string                   `json:"status"`
	Resolution         *string                  `json:"resolution"`
	MergedInto         *string                  `json:"mergedInto"`
	History            []object                 `json:"history"`
	Fingerprint        string                   `json:"fingerprint"`
	Occurrences        []string                 `json:"occurrences"`
	Applied            []string                 `json:"applied"`
	Pending            []coordinationEventInput `json:"pending"`
	UpdatedMS          int64                    `json:"updatedMs"`
	ExportedRevision   *uint64                  `json:"exportedRevision"`
	CandidateSignature *string                  `json:"candidateSignature"`
	CandidateBuild     *string                  `json:"candidateBuild"`
}

type axSnapshot struct {
	Epoch             string              `json:"epoch"`
	Revision          uint64              `json:"revision"`
	Entries           map[string]*axEntry `json:"entries"`
	ReportBuckets     map[string][2]int64 `json:"reportBuckets"`
	CandidateBucket   [2]int64            `json:"candidateBucket"`
	CandidateOverflow uint64              `json:"candidateOverflow"`
}

type axStore struct {
	dir  string
	data axSnapshot
}

func axOptional(value any) *string {
	if text, ok := value.(string); ok {
		return &text
	}
	return nil
}

func axClip(value string, limit int) string {
	runes := []rune(value)
	return string(runes[:min(limit, len(runes))])
}

func axTokens(text string) []string {
	values := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && !unicode.In(r, unicode.Other_Alphabetic)
	})
	slices.Sort(values)
	return slices.Compact(values)
}

func axStrings(value any) []string {
	result := []string{}
	for _, value := range arr(value) {
		if text, ok := value.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func axSet(values []string, extra ...string) []string {
	values = append(values, extra...)
	slices.Sort(values)
	return slices.Compact(values)
}

func axFingerprint(args object) string {
	resources := []string{}
	for _, key := range axStrings(args["resources"]) {
		kind, _, _ := strings.Cut(key, ":")
		resources = append(resources, kind)
	}
	kind := text(args, "kind")
	if kind == "" {
		kind = "friction"
	}
	return hash([]byte(wire([]any{kind, axTokens(text(args, "symptom")), axSet(resources)})))
}

func axOccurrence(args object) string {
	refs := []string{}
	for _, key := range []string{"receiptIds", "requestIds"} {
		for _, ref := range axStrings(args[key]) {
			refs = append(refs, "receipt:"+ref)
		}
	}
	if len(refs) == 0 {
		for _, ref := range axStrings(args["threadIds"]) {
			refs = append(refs, "thread:"+ref)
		}
	}
	if len(refs) == 0 {
		return hash([]byte(text(args, "requestId")))
	}
	return hash([]byte(wire(axSet(refs))))
}

func (entry *axEntry) owns(actor object) bool {
	return actor["type"] == "local-authority" || (actor["type"] == "source" && entry.Source["sourceId"] == actor["sourceId"])
}

func (entry *axEntry) projection(actor object) object {
	var value object
	_ = decodeObject([]byte(wire(entry)), &value)
	for _, key := range []string{"fingerprint", "occurrences", "applied", "pending", "updatedMs", "exportedRevision", "candidateSignature", "candidateBuild"} {
		delete(value, key)
	}
	if !entry.owns(actor) {
		delete(value, "reproductionHints")
		delete(value, "evidence")
		history := []object{}
		for _, h := range entry.History {
			row := selectFields(h, "action", "at", "actor", "revision")
			row["evidenceUnavailable"] = object{"reason": "Decision details are restricted to the reporting source and local authority.",
				"next": object{"via": "cli", "op": nil, "command": "arc cli control ax_list --stdin", "stdin": object{"id": entry.ID}, "hint": "Run locally to read recorded decision details as local authority. Older actions may have no recorded reason."}}
			history = append(history, row)
		}
		value["history"] = history
		return value
	}
	if actor["type"] != "local-authority" {
		evidence := []object{}
		for _, item := range entry.Evidence {
			if item["source"] == nil || field(item["source"], "sourceId") == actor["sourceId"] {
				evidence = append(evidence, item)
			}
		}
		value["evidence"] = evidence
	}
	for _, raw := range arr(value["history"]) {
		history := obj(raw)
		switch text(history, "action") {
		case "fix", "document", "wontfix", "merged", "reopen", "confirm", "reject":
			if field(history["detail"], "reason") == nil {
				history["reasonUnavailable"] = "No reason was recorded for this action."
			}
		}
	}
	return value
}

func (entry *axEntry) observe(kind string) {
	resources := entry.Resources
	if len(resources) == 0 {
		resources = []string{"app:installed"}
	}
	event := newCoordinationEvent(fmt.Sprintf("%s-%d", entry.ID, entry.Revision), kind, resources)
	principal := coordinationPrincipal{Type: "arc"}
	if entry.CandidateSignature == nil {
		_ = decodeCoordinationRecord([]byte(wire(entry.Source)), &principal)
	}
	event.Origin = &principal
	status := entry.Status
	if entry.CandidateState != nil && *entry.CandidateState == "rejected" {
		status = "rejected"
	}
	event.Status = &status
	event.EvidenceRefs = append(event.EvidenceRefs, coordinationEvidenceRef{"ax", entry.ID})
	entry.Pending = append(entry.Pending, event)
}

func (entry *axEntry) record(action string, actor object, detail object, ms int64) {
	entry.Revision++
	entry.UpdatedMS = ms
	entry.History = append(entry.History, object{"action": action, "at": coordinationTimestamp(ms), "actor": actor, "revision": entry.Revision, "detail": detail})
}

func (entry *axEntry) addEvidence(value object) {
	if len(entry.Evidence) >= 16 {
		entry.Evidence = slices.Delete(entry.Evidence, 1, 2)
	}
	entry.Evidence = append(entry.Evidence, value)
}

func openAXStore(dir string) (*axStore, error) {
	if err := platform.PrivateDir(dir); err != nil {
		return nil, err
	}
	store := &axStore{dir: dir}
	path := filepath.Join(dir, "state.json")
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		store.data = axSnapshot{Epoch: id(), Entries: map[string]*axEntry{}, ReportBuckets: map[string][2]int64{}}
		return store, nil
	}
	if err != nil {
		return nil, errAXCorrupt
	}
	if info.Size() > axSnapshotBytes {
		return nil, errAXCapacity
	}
	data, err := os.ReadFile(path)
	if err != nil || decodeCoordinationRecord(data, &store.data) != nil || store.data.Entries == nil || store.data.ReportBuckets == nil {
		return nil, errAXCorrupt
	}
	_, err = store.bytes()
	return store, err
}

func (store *axStore) bytes() ([]byte, error) {
	if len(store.data.Entries) > axMaxEntries || len(store.data.ReportBuckets) > 1024 {
		return nil, errAXCapacity
	}
	for id, e := range store.data.Entries {
		if e == nil || id != e.ID || !coordinationIdentifier(id) {
			return nil, errAXCorrupt
		}
		if len(wire(e)) > axEntryBytes {
			return nil, errAXCapacity
		}
	}
	bytes := []byte(wire(store.data))
	if len(bytes) > axSnapshotBytes {
		return nil, errAXCapacity
	}
	return bytes, nil
}

func (store *axStore) save() error {
	bytes, err := store.bytes()
	if err != nil {
		return err
	}
	return coordinationAtomicBytes(filepath.Join(store.dir, "state.json"), bytes)
}

func (store *axStore) prune(ms int64) bool {
	pruned := false
	for key, e := range store.data.Entries {
		if (e.Status == "closed" || e.Status == "merged") && ms-e.UpdatedMS > 180*86400*1000 && e.ExportedRevision != nil && *e.ExportedRevision == e.Revision && len(e.Pending) == 0 {
			delete(store.data.Entries, key)
			pruned = true
		}
	}
	for key, bucket := range store.data.ReportBuckets {
		if ms-bucket[0] >= 60000 {
			delete(store.data.ReportBuckets, key)
			pruned = true
		}
	}
	return pruned
}

func (store *axStore) resolve(prefix string) (string, error) {
	if store.data.Entries[prefix] != nil {
		return prefix, nil
	}
	matches := []string{}
	for _, key := range slices.Sorted(maps.Keys(store.data.Entries)) {
		if strings.HasPrefix(key, prefix) {
			matches = append(matches, key)
		}
	}
	switch len(matches) {
	case 0:
		return "", errors.New("AX_NOT_FOUND: query ax_list")
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("INVALID_ARGUMENT: ambiguous prefix; use a full AX id: %s", strings.Join(matches, ", "))
	}
}

func (store *axStore) canonical(key string) (string, error) {
	key, err := store.resolve(key)
	if err != nil {
		return "", err
	}
	for range axMaxEntries + 1 {
		entry := store.data.Entries[key]
		if entry == nil {
			return "", errors.New("AX_NOT_FOUND: query ax_list")
		}
		if entry.MergedInto == nil {
			return key, nil
		}
		key = *entry.MergedInto
	}
	return "", errAXCorrupt
}

func (store *axStore) mutate(op string, args, actor object, evidence []object, ms int64) (object, error) {
	request := text(args, "requestId")
	for _, key := range slices.Sorted(maps.Keys(store.data.Entries)) {
		if entry := store.data.Entries[key]; slices.Contains(entry.Applied, request) {
			result := axDecisionResult(entry, actor)
			result["duplicateCandidates"], result["replayed"] = []object{}, true
			return result, nil
		}
	}
	store.prune(ms)
	var result object
	var err error
	switch op {
	case "ax_report":
		key := text(actor, "sourceId")
		if key == "" {
			key = "local"
		}
		bucket, ok := store.data.ReportBuckets[key]
		if !ok || ms-bucket[0] >= 60000 {
			bucket = [2]int64{ms, 0}
		}
		if bucket[1] >= 10 {
			return nil, errors.New("COORDINATION_RATE_LIMIT: wait one minute and retry the same requestId")
		}
		bucket[1]++
		store.data.ReportBuckets[key] = bucket
		result, err = store.report(args, actor, evidence, ms, "")
	case "ax_candidate", "ax_triage":
		result, err = store.decision(op, args, actor, evidence, ms)
	default:
		return nil, errors.New("INVALID_ARGUMENT: read guide for AX operations")
	}
	if err != nil {
		return nil, err
	}
	store.data.Revision++
	return result, store.save()
}

func (store *axStore) report(args, actor object, evidence []object, ms int64, importID string) (object, error) {
	fingerprint := axFingerprint(args)
	key := importID
	for _, id := range slices.Sorted(maps.Keys(store.data.Entries)) {
		entry := store.data.Entries[id]
		if entry.Fingerprint == fingerprint && entry.Status != "candidate" && strPtr(entry.CandidateState) != "rejected" {
			var err error
			key, err = store.canonical(id)
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if key == "" {
		key = "ax-" + id()
	}
	entry := store.data.Entries[key]
	fresh := entry == nil
	if fresh {
		kind := text(args, "kind")
		if kind == "" {
			kind = "friction"
		}
		entry = &axEntry{ID: key, Kind: kind, Symptom: text(args, "symptom"), Expected: text(args, "expected"), ReproductionHints: text(args, "reproductionHints"),
			Severity: axOptional(args["severity"]), Resources: axStrings(args["resources"]), Source: actor, Evidence: []object{}, Status: "open",
			History: []object{}, Fingerprint: fingerprint, Occurrences: []string{}, Applied: []string{}, Pending: []coordinationEventInput{}, UpdatedMS: ms}
		if importID == "" {
			entry.ARCVersion = new(arcVersion())
			entry.FirstSeenAt = new(coordinationTimestamp(ms))
			entry.LastSeenAt = entry.FirstSeenAt
		}
		store.data.Entries[key] = entry
	}
	entry.Applied = axSet(entry.Applied, text(args, "requestId"))
	if !fresh && entry.owns(actor) {
		if severity := axOptional(args["severity"]); severity != nil && !samePointer(entry.Severity, severity) {
			previous := entry.Severity
			entry.Severity = severity
			entry.record("severity-changed", actor, object{"previous": previous, "severity": severity}, ms)
			entry.observe("ax.changed")
		}
		hints, hasHints := args["reproductionHints"].(string)
		if entry.Expected != text(args, "expected") || hasHints && hints != entry.ReproductionHints {
			entry.Expected = text(args, "expected")
			if hasHints {
				entry.ReproductionHints = hints
			}
			entry.record("enriched", actor, object{}, ms)
			entry.observe("ax.changed")
		}
	}
	if occurrence := axOccurrence(args); !slices.Contains(entry.Occurrences, occurrence) {
		entry.Occurrences = axSet(entry.Occurrences, occurrence)
		if entry.Kind == "friction" {
			entry.OccurrenceCount++
		}
		entry.LastSeenAt = nil
		if importID == "" {
			entry.LastSeenAt = new(coordinationTimestamp(ms))
		}
		for _, item := range evidence {
			item["source"] = actor
			entry.addEvidence(item)
		}
		reopen := entry.Status == "closed"
		if reopen {
			entry.Status = "open"
			entry.Resolution = nil
		}
		if fresh {
			entry.record("reported", actor, object{"reportedOnly": importID != ""}, ms)
			entry.observe("ax.created")
		} else {
			if reopen {
				entry.record("reopen", actor, object{"reportedOnly": importID != ""}, ms)
			} else {
				entry.Revision++
				entry.UpdatedMS = ms
			}
			entry.observe("ax.changed")
		}
	}
	return object{"entry": entry.projection(actor), "duplicateCandidates": store.duplicates(key, text(args, "symptom"))}, nil
}

func strPtr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (store *axStore) duplicates(key, symptom string) []object {
	tokens := axTokens(symptom)
	rows := []object{}
	for _, id := range slices.Sorted(maps.Keys(store.data.Entries)) {
		entry := store.data.Entries[id]
		if id == key || entry.Status == "merged" || entry.Status == "candidate" {
			continue
		}
		other := axTokens(entry.Symptom)
		intersection := 0
		for _, token := range tokens {
			if _, found := slices.BinarySearch(other, token); found {
				intersection++
			}
		}
		score := float64(intersection) / float64(max(1, len(tokens)+len(other)-intersection))
		if score >= 0.35 {
			rows = append(rows, object{"id": id, "score": score, "reason": "symptom-token-overlap"})
		}
	}
	slices.SortStableFunc(rows, func(a, b object) int {
		l, r := a["score"].(float64), b["score"].(float64)
		if l > r {
			return -1
		}
		if l < r {
			return 1
		}
		return 0
	})
	return rows[:min(8, len(rows))]
}

func axVerificationReasons(action string, args object, evidence []object) []object {
	reasons := []object{}
	field := "document"
	if action == "fix" {
		field = "commit"
	}
	if text(args, field) == "" {
		reasons = append(reasons, object{"code": "missing-change", "field": field})
	}
	ids := axStrings(args["evidenceIds"])
	if len(ids) == 0 {
		reasons = append(reasons, object{"code": "no-evidence"})
	}
	for _, id := range ids {
		var fact object
		accepted := false
		for _, e := range evidence {
			if e["id"] != id || e["availability"] != "available" {
				continue
			}
			if fact == nil {
				fact = e
			}
			if readReceiptState(text(e, "state"), true) == receiptCompleted && slices.Contains(axVerificationOps, text(e, "operation")) {
				accepted = true
				break
			}
		}
		if accepted {
			continue
		}
		reason := object{"code": "evidence-not-accepted", "id": id, "reason": "unavailable"}
		if fact != nil {
			reason["state"], reason["operation"] = fact["state"], fact["operation"]
			reason["reason"] = "unsupported-operation"
			if readReceiptState(text(fact, "state"), true) != receiptCompleted {
				reason["reason"] = "not-completed"
			}
		}
		reasons = append(reasons, reason)
	}
	return reasons
}

func axDecisionResult(e *axEntry, actor object) object {
	result := object{"entry": e.projection(actor)}
	if e.Status == "triaged" && e.owns(actor) && len(e.History) > 0 {
		last := e.History[len(e.History)-1]
		action := text(last, "action")
		if action == "fix" || action == "document" {
			detail := obj(last["detail"])
			var facts []object
			_ = unmarshalJSON([]byte(wire(detail["verification"])), &facts)
			result["verification"] = object{"acceptedOperations": axVerificationOps, "reasons": axVerificationReasons(action, detail, facts)}
			result["next"] = object{"via": "query", "op": "ax_list", "args": object{"id": e.ID}, "hint": "Read the current revision. Attach the change reference and available completed receipts from command, review, native, or agent_review. Retry ax_triage with the current expectedRevision and a new requestId after correcting the reported verification reasons."}
		}
	}
	return result
}

func (store *axStore) decision(op string, args, actor object, evidence []object, ms int64) (object, error) {
	key, err := store.resolve(text(args, "id"))
	if err != nil {
		return nil, err
	}
	entry := store.data.Entries[key]
	if !entry.owns(actor) {
		return nil, errors.New("AX_FORBIDDEN: only the reporting source or local authority may decide this entry")
	}
	rev, ok := uintValue(args["expectedRevision"])
	if !ok || rev != entry.Revision {
		return nil, fmt.Errorf("AX_REVISION_CONFLICT: current revision %d; query ax_list before deciding", entry.Revision)
	}
	if entry.Status == "merged" {
		return nil, errors.New("AX_MERGED: triage the canonical entry from ax_list")
	}
	action := text(args, "action")
	if op == "ax_candidate" && (entry.Status != "candidate" || (action != "confirm" && action != "reject")) {
		return nil, errors.New("AX_STATE_CONFLICT: only pending candidates may be confirmed or rejected")
	}
	if op == "ax_triage" && (entry.Status == "candidate" || strPtr(entry.CandidateState) == "rejected") {
		return nil, errors.New("AX_STATE_CONFLICT: confirm the candidate first")
	}
	detail := clone(args)
	delete(detail, "requestId")
	switch action {
	case "confirm":
		entry.CandidateState, entry.Status = new("confirmed"), "open"
		entry.OccurrenceCount = uint64(len(entry.Occurrences))
	case "reject":
		entry.CandidateState, entry.Status = new("rejected"), "closed"
	case "fix", "document":
		entry.Resolution, entry.Status = &action, "closed"
		if len(axVerificationReasons(action, args, evidence)) > 0 {
			entry.Status = "triaged"
		}
		detail["verification"] = evidence
	case "wontfix":
		entry.Resolution, entry.Status = &action, "closed"
	case "merged":
		targetID, err := store.canonical(text(args, "mergedInto"))
		if err != nil {
			return nil, err
		}
		if key == targetID {
			return nil, errors.New("AX_MERGE_CYCLE: choose another canonical entry")
		}
		target := store.data.Entries[targetID]
		if target.Status == "candidate" || strPtr(target.CandidateState) == "rejected" || !target.owns(actor) || target.Kind != entry.Kind {
			return nil, errors.New("AX_FORBIDDEN: merge requires authority over a confirmed target of the same kind")
		}
		target.Occurrences = axSet(target.Occurrences, entry.Occurrences...)
		if target.Kind != "idea" {
			target.OccurrenceCount = uint64(len(target.Occurrences))
		}
		for _, item := range entry.Evidence {
			target.addEvidence(item)
		}
		if target.Status == "closed" {
			target.Status, target.Resolution = "open", nil
		}
		if strPtr(entry.FirstSeenAt) < strPtr(target.FirstSeenAt) {
			target.FirstSeenAt = entry.FirstSeenAt
		}
		if strPtr(entry.LastSeenAt) > strPtr(target.LastSeenAt) {
			target.LastSeenAt = entry.LastSeenAt
		}
		target.record("merged-from", actor, object{"id": key}, ms)
		target.observe("ax.changed")
		entry.Resolution, entry.Status, entry.MergedInto = &action, "merged", &targetID
	case "reopen":
		entry.Resolution, entry.Status = nil, "open"
	default:
		return nil, errors.New("INVALID_ARGUMENT: read guide for ax_triage")
	}
	entry.Applied = axSet(entry.Applied, text(args, "requestId"))
	entry.record(action, actor, detail, ms)
	entry.observe("ax.changed")
	return axDecisionResult(entry, actor), nil
}

func (store *axStore) counts() (open, blocking, candidates int) {
	for _, entry := range store.data.Entries {
		switch entry.Status {
		case "open", "triaged":
			open++
			if strPtr(entry.Severity) == "blocking" {
				blocking++
			}
		case "candidate":
			candidates++
		}
	}
	return
}

func (store *axStore) list(args, actor object, authority string, ms int64) (object, error) {
	selected := text(args, "id")
	if selected != "" && store.data.Entries[selected] == nil {
		raw, hasPrefix := strings.CutPrefix(selected, "ax-")
		if _, err := uuid.Parse(raw); !hasPrefix || err != nil {
			selected, err = store.resolve(selected)
			if err != nil {
				return nil, err
			}
		}
	}
	filters := maps.Clone(args)
	delete(filters, "cursor")
	delete(filters, "limit")
	scope := hash([]byte(wire([]any{axActorIdentity(actor), authority, filters})))
	after := ""
	if value := text(args, "cursor"); value != "" {
		payload, sig, ok := strings.Cut(value, ".")
		if !ok || sig != hash([]byte(store.data.Epoch+":"+payload)) {
			return nil, errors.New("AX_CURSOR_EXPIRED: restart ax_list without cursor")
		}
		data, err := base64.RawURLEncoding.DecodeString(payload)
		var cursor object
		if err != nil || decodeObject(data, &cursor) != nil {
			return nil, errors.New("AX_CURSOR_EXPIRED")
		}
		if cursor["scope"] != scope || uintOr(cursor["revision"], 0) != store.data.Revision || uintOr(cursor["expires"], 0) < uint64(ms) {
			return nil, errors.New("AX_CURSOR_EXPIRED: authority, filters or entries changed; restart ax_list without cursor")
		}
		after = text(cursor, "after")
	}
	since := int64(0)
	if value := text(args, "since"); value != "" {
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return nil, errors.New("INVALID_ARGUMENT: since must be RFC3339")
		}
		since = at.UnixMilli()
	}
	resource := text(args, "resource")
	if resource != "" {
		var retained []string
		for _, e := range store.data.Entries {
			retained = append(retained, e.Resources...)
		}
		var err error
		resource, err = resolveCoordinationResource(resource, retained)
		if err != nil {
			return nil, err
		}
	}
	status := text(args, "status")
	if status == "" {
		status = text(args, "state")
	}
	severity := text(args, "severity")
	limit := uintOr(args["limit"], 50)
	rows := []object{}
	size := 0
	var next any
	for _, id := range slices.Sorted(maps.Keys(store.data.Entries)) {
		e := store.data.Entries[id]
		if id <= after || selected != "" && id != selected || status != "" && e.Status != status || severity != "" && severity != strPtr(e.Severity) || since != 0 && e.UpdatedMS < since || resource != "" && !slices.Contains(e.Resources, resource) {
			continue
		}
		row := e.projection(actor)
		encoded := wire(row)
		if uint64(len(rows)) >= limit || size+len(encoded) > 120*1024 {
			payload := base64.RawURLEncoding.EncodeToString([]byte(wire(object{"scope": scope, "revision": store.data.Revision, "expires": ms + 900000, "after": after})))
			next = payload + "." + hash([]byte(store.data.Epoch+":"+payload))
			break
		}
		size += len(encoded)
		after = id
		rows = append(rows, row)
	}
	open, blocking, candidates := store.counts()
	return object{"entries": rows, "nextCursor": next, "triageDue": args["beforeRelease"] == true || open >= 8 || blocking > 0,
		"counts": object{"open": open, "blocking": blocking, "candidates": candidates, "candidateOverflow": store.data.CandidateOverflow}, "observedAt": coordinationTimestamp(ms)}, nil
}

func (store *axStore) attention(actor object, triage bool) []object {
	items := []object{}
	for _, id := range slices.Sorted(maps.Keys(store.data.Entries)) {
		e := store.data.Entries[id]
		if len(items) < 20 && e.Status == "candidate" && e.owns(actor) {
			items = append(items, object{"kind": "ax-candidate", "id": id, "revision": e.Revision, "severity": e.Severity, "summary": axClip(e.Symptom, 160),
				"occurrenceCount": e.OccurrenceCount, "ownerSourceId": e.Source["sourceId"], "next": object{"via": "query", "op": "ax_list", "args": object{"id": id}}})
		}
	}
	open, blocking, _ := store.counts()
	if triage && (open >= 8 || blocking > 0) {
		items = append(items, object{"kind": "ax-triage", "id": "ax-triage", "open": open, "blocking": blocking,
			"next": object{"via": "query", "op": "ax_list", "args": object{"status": "open"}}})
	}
	return items
}

func (store *axStore) export(path string) (object, error) {
	if _, err := os.Lstat(path); err == nil {
		return nil, errors.New("AX_EXPORT_EXISTS: choose a new export path")
	}
	bytes := []byte(wire(clone(object{"format": "arc-ax-export-v1", "entries": store.data.Entries})))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, errors.New("COORDINATION_STORAGE: cannot create AX export; choose a new private path")
	}
	_, err = file.Write(bytes)
	if errors.Join(err, file.Sync(), file.Close()) != nil {
		_ = os.Remove(path)
		return nil, errors.New("COORDINATION_STORAGE: AX export incomplete; restore disk capacity and export again")
	}
	if indexSyncDirectory(filepath.Dir(path)) != nil {
		return nil, errors.New("COORDINATION_STORAGE: cannot sync AX export directory")
	}
	for _, entry := range store.data.Entries {
		entry.ExportedRevision = new(entry.Revision)
	}
	return object{"exported": len(store.data.Entries), "sha256": hash(bytes)}, store.save()
}

func (store *axStore) candidate(friction, observation string, principal *coordinationPrincipal, refs []coordinationEvidenceRef, build string, ms int64) (object, error) {
	source := object{"type": "arc"}
	if principal != nil && (principal.Type == "source" || principal.Type == "local-authority") {
		source = axActor(coordinationReader{principal: *principal})
	}
	signature := hash([]byte(friction))
	pruned := store.prune(ms)
	keys := slices.Sorted(maps.Keys(store.data.Entries))
	var entry *axEntry
	for _, key := range keys {
		row := store.data.Entries[key]
		if strPtr(row.CandidateSignature) == signature && strPtr(row.CandidateBuild) == build && strPtr(row.CandidateState) == "rejected" && ms-row.UpdatedMS < 86400000 {
			if pruned {
				return object{"suppressed": true, "reason": "recent-rejection", "id": row.ID}, store.save()
			}
			return object{"suppressed": true, "reason": "recent-rejection", "id": row.ID}, nil
		}
		if strPtr(row.CandidateState) == "rejected" || row.Status == "merged" {
			continue
		}
		if strPtr(row.CandidateSignature) != signature && !slices.ContainsFunc(row.Evidence, func(item object) bool { return item["friction"] == friction }) {
			continue
		}
		if entry == nil || entry.Status == "candidate" && row.Status != "candidate" {
			entry = row
		}
	}
	observation = hash([]byte(observation))
	if entry != nil && slices.Contains(entry.Occurrences, observation) {
		if pruned {
			return object{"coalesced": true, "id": entry.ID, "candidate": entry.Status == "candidate"}, store.save()
		}
		return object{"coalesced": true, "id": entry.ID, "candidate": entry.Status == "candidate"}, nil
	}
	if ms-store.data.CandidateBucket[0] >= 3600000 {
		store.data.CandidateBucket = [2]int64{ms, 0}
	}
	fresh := entry == nil
	if fresh {
		if store.data.CandidateBucket[1] >= 20 {
			store.data.CandidateOverflow = saturatingIncrement(store.data.CandidateOverflow)
			return object{"suppressed": true, "reason": "candidate-rate-limit", "overflow": store.data.CandidateOverflow}, store.save()
		}
		store.data.CandidateBucket[1]++
		symptoms := map[string]string{"receipt-stalled": "Receipt progress stalled", "owner-discovery-timeout": "Thread owner discovery timed out", "delivery-failed": "Notification delivery failed"}
		entry = &axEntry{ID: "ax-" + id(), Kind: "friction", Symptom: symptoms[friction],
			Expected: "Inspect the referenced observation and confirm or reject this friction hypothesis",
			Severity: new("workaround"), Resources: []string{}, Source: source, ARCVersion: new(arcVersion()), Evidence: []object{},
			FirstSeenAt: new(coordinationTimestamp(ms)), CandidateState: new("pending"), Status: "candidate", History: []object{},
			Fingerprint: hash([]byte(signature)), Occurrences: []string{}, Applied: []string{}, Pending: []coordinationEventInput{},
			CandidateSignature: &signature, CandidateBuild: &build}
		store.data.Entries[entry.ID] = entry
	}
	entry.Occurrences = axSet(entry.Occurrences, observation)
	entry.OccurrenceCount = uint64(len(entry.Occurrences))
	if entry.Status == "closed" {
		entry.Status, entry.Resolution = "open", nil
		entry.record("reopen", object{"type": "arc"}, object{}, ms)
	}
	entry.addEvidence(object{"kind": "candidate-observation", "friction": friction, "references": refs, "coreBuild": build, "observedAt": coordinationTimestamp(ms), "source": source})
	entry.LastSeenAt = new(coordinationTimestamp(ms))
	if fresh {
		entry.record("candidate-created", object{"type": "arc"}, object{}, ms)
		entry.observe("ax.created")
	} else {
		entry.Revision++
		entry.UpdatedMS = ms
		entry.observe("ax.changed")
	}
	store.data.Revision++
	return object{"entry": entry.projection(source), "confirmationNeeded": entry.Status == "candidate"}, store.save()
}
