package core

import (
	"encoding/base64"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const coordinationMessageDay = 86400
const coordinationMessageLimit = 2000
const coordinationMessageSnapshotBytes = 4 * 1024 * 1024

var errCoordinationMessageCorrupt = errors.New("COORDINATION_CORRUPT: preserve messages snapshot for local recovery")
var errCoordinationMessageCapacity = errors.New("COORDINATION_CAPACITY: use local messages management to resolve escalations; wait for closed history retention")
var errCoordinationNegotiationLimit = errors.New("NEGOTIATION_LIMIT: three combined automatic replies exhausted; both participants must stop and ask the user to mediate in local ARC management")

type coordinationParticipantRecovery struct {
	State                string    `json:"state"`
	OriginalParticipants [1]string `json:"originalParticipants"`
}
type coordinationNegotiation struct {
	ID                  string                           `json:"id"`
	Participants        []string                         `json:"participants"`
	ParticipantRecovery *coordinationParticipantRecovery `json:"participantRecovery,omitempty"`
	Initiator           string                           `json:"initiator"`
	Resources           []string                         `json:"resources"`
	State               string                           `json:"state"`
	AutomaticReplyCount uint32                           `json:"automaticReplyCount"`
	ReplyLimit          uint32                           `json:"replyLimit"`
	CreatedAt           int64                            `json:"createdAt"`
	ExpiresAt           int64                            `json:"expiresAt"`
	LastMessageID       string                           `json:"lastMessageId"`
	EscalationID        *string                          `json:"escalationId"`
	Decisions           []object                         `json:"decisions"`
}

func (n *coordinationNegotiation) unresolved() bool {
	return len(n.Participants) == 1 || n.ParticipantRecovery != nil && n.ParticipantRecovery.State == "unresolved"
}

type coordinationMessageRow struct {
	Envelope     object             `json:"envelope"`
	Sequence     uint64             `json:"sequence"`
	Digest       string             `json:"digest"`
	Route        *coordinationRoute `json:"route"`
	Due          int64              `json:"due"`
	Attempts     uint32             `json:"attempts"`
	RecoveryRefs []object           `json:"recoveryRefs"`
}
type coordinationMessageData struct {
	Epoch        string                       `json:"epoch"`
	Next         uint64                       `json:"next"`
	Floor        uint64                       `json:"floor"`
	Messages     []*coordinationMessageRow    `json:"messages"`
	Negotiations []*coordinationNegotiation   `json:"negotiations"`
	Pending      []coordinationEventInput     `json:"pending"`
	LastPush     map[string]int64             `json:"lastPush"`
	Routes       map[string]coordinationRoute `json:"routes,omitempty"`
}

func (d *coordinationMessageData) recoverParticipants() bool {
	changed := false
	for _, n := range d.Negotiations {
		if len(n.Participants) != 1 || n.ParticipantRecovery != nil {
			continue
		}
		var pair []string
		consistent := true
		for _, row := range d.Messages {
			if row.Envelope["negotiationId"] != n.ID || row.Envelope["localOrigin"] == "arc" {
				continue
			}
			from, to := text(row.Envelope, "fromSourceId"), text(row.Envelope, "toSourceId")
			endpoints := []string{from, to}
			slices.Sort(endpoints)
			if from == to || !coordinationIdentifier(from) || !coordinationIdentifier(to) || !slices.Contains(endpoints, n.Participants[0]) ||
				!slices.Contains(endpoints, n.Initiator) || pair != nil && !slices.Equal(pair, endpoints) {
				consistent = false
				break
			}
			pair = endpoints
		}
		n.ParticipantRecovery = &coordinationParticipantRecovery{State: "unresolved", OriginalParticipants: [1]string{n.Participants[0]}}
		if pair != nil && consistent {
			n.Participants = pair
			n.ParticipantRecovery.State = "reconstructed"
		}
		changed = true
	}
	return changed
}

type coordinationMessageStore struct {
	path            string
	data            coordinationMessageData
	scannedDeadline bool
	deadline        int64
}

func openCoordinationMessageStore(path string, cost *runtimeCost) (*coordinationMessageStore, error) {
	store := &coordinationMessageStore{path: path}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		store.data = coordinationMessageData{Epoch: id(), Next: 1, Messages: []*coordinationMessageRow{}, Negotiations: []*coordinationNegotiation{},
			Pending: []coordinationEventInput{}, LastPush: map[string]int64{}}
		return store, store.save(cost)
	}
	if err != nil {
		return nil, errors.New("COORDINATION_STORAGE: cannot stat messages")
	}
	if info.Size() > coordinationMessageSnapshotBytes {
		return nil, errors.New("COORDINATION_CAPACITY: messages snapshot exceeds capacity")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("COORDINATION_STORAGE: cannot read messages")
	}
	if cost != nil {
		cost.read.Add(uint64(len(data)))
		cost.parsed.Add(uint64(len(data)))
	}
	var raw object
	if decodeObject(data, &raw) != nil {
		return nil, errCoordinationMessageCorrupt
	}
	_, migrated := raw["recoveryWindows"]
	delete(raw, "recoveryWindows")
	if decodeCoordinationRecord([]byte(wire(raw)), &store.data) != nil || store.data.Next == 0 || store.data.Messages == nil ||
		store.data.Negotiations == nil || store.data.Pending == nil || store.data.LastPush == nil {
		return nil, errCoordinationMessageCorrupt
	}
	for _, n := range store.data.Negotiations {
		if n == nil || len(n.Participants) < 1 || len(n.Participants) > 2 ||
			n.ParticipantRecovery != nil && !slices.Contains([]string{"reconstructed", "unresolved"}, n.ParticipantRecovery.State) {
			return nil, errCoordinationMessageCorrupt
		}
	}
	for _, row := range store.data.Messages {
		if row == nil || row.Envelope == nil {
			return nil, errCoordinationMessageCorrupt
		}
		if row.RecoveryRefs == nil {
			row.RecoveryRefs = []object{}
		}
	}
	if store.data.recoverParticipants() {
		backup := strings.TrimSuffix(path, filepath.Ext(path)) + ".before-participant-recovery.json"
		existing, err := os.ReadFile(backup)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if err := coordinationAtomicBytes(backup, data); err != nil {
				return nil, err
			}
		case err != nil:
			return nil, errors.New("COORDINATION_STORAGE: cannot read participant recovery backup")
		case !slices.Equal(existing, data):
			return nil, errors.New("COORDINATION_STORAGE: preserve both messages snapshot and participant recovery backup; archive the existing backup separately before retrying recovery")
		}
		migrated = true
	}
	for _, row := range store.data.Messages {
		if row.Envelope["localOrigin"] == "arc" && row.Envelope["deliveryState"] == "pending" {
			row.Route = nil
			row.Envelope["deliveryState"] = "pull-only"
			migrated = true
		}
	}
	if cost != nil {
		cost.scanSet.Store(uint64(len(store.data.Messages) + len(store.data.Negotiations)))
	}
	if migrated {
		return store, store.save(cost)
	}
	return store, nil
}

func (store *coordinationMessageStore) save(cost *runtimeCost) error {
	data := []byte(wire(store.data))
	if len(data) > coordinationMessageSnapshotBytes || len(store.data.Messages) > coordinationMessageLimit || len(store.data.Negotiations) > 128 ||
		len(store.data.Pending) > coordinationMessageLimit || len(store.data.LastPush) > 128 || len(store.data.Routes) > 128 {
		return errCoordinationMessageCapacity
	}
	if err := coordinationAtomicBytes(store.path, data); err != nil {
		return err
	}
	if cost != nil {
		cost.changed.Add(1)
	}
	store.scannedDeadline = false
	return nil
}
func (store *coordinationMessageStore) event(transition, kind string, resources []string) {
	index := 0
	for part := range slices.Chunk(resources, 4) {
		store.data.Pending = append(store.data.Pending, newCoordinationEvent(transition+"-"+strconv.Itoa(index), kind, part))
		index++
	}
}
func (store *coordinationMessageStore) negotiation(id string) *coordinationNegotiation {
	for _, n := range store.data.Negotiations {
		if n.ID == id {
			return n
		}
	}
	return nil
}
func (store *coordinationMessageStore) message(id string) *coordinationMessageRow {
	for _, row := range store.data.Messages {
		if row.Envelope["messageId"] == id {
			return row
		}
	}
	return nil
}
func (store *coordinationMessageStore) add(row *coordinationMessageRow) {
	row.Sequence = store.data.Next
	store.data.Next++
	if row.RecoveryRefs == nil {
		row.RecoveryRefs = []object{}
	}
	store.data.Messages = append(store.data.Messages, row)
}
func messageSecond(row object, key string, fallback int64) int64 {
	if value, ok := uintValue(row[key]); ok {
		return int64(value)
	}
	return fallback
}

func (store *coordinationMessageStore) maintain(now int64) bool {
	changed := false
	for _, n := range store.data.Negotiations {
		if !n.unresolved() && n.State == "open" && n.ExpiresAt <= now {
			n.State = "expired"
			store.data.Pending = append(store.data.Pending, newCoordinationEvent(n.ID+"-expired", "negotiation.changed", n.Resources))
			changed = true
		}
	}
	for _, row := range store.data.Messages {
		switch row.Envelope["deliveryState"] {
		case "pending":
			if messageSecond(row.Envelope, "expiresAt", 0) <= now {
				row.Envelope["deliveryState"] = "expired"
				changed = true
			}
		case "sending":
			row.Envelope["deliveryState"] = "unconfirmed"
			changed = true
		}
	}
	store.data.Messages = slices.DeleteFunc(store.data.Messages, func(row *coordinationMessageRow) bool {
		n := store.negotiation(text(row.Envelope, "negotiationId"))
		if messageSecond(row.Envelope, "createdAt", now) > now-7*coordinationMessageDay || n != nil && n.unresolved() {
			return false
		}
		store.data.Floor = max(store.data.Floor, row.Sequence)
		changed = true
		return true
	})
	store.data.Negotiations = slices.DeleteFunc(store.data.Negotiations, func(n *coordinationNegotiation) bool {
		if n.unresolved() || n.State == "escalated" || n.ExpiresAt > now-7*coordinationMessageDay {
			return false
		}
		changed = true
		return true
	})
	maps.DeleteFunc(store.data.LastPush, func(_ string, at int64) bool {
		expired := at <= now-coordinationMessageDay
		changed = changed || expired
		return expired
	})
	return changed
}

func (store *coordinationMessageStore) result(row *coordinationMessageRow) object {
	outcome := coordinationRouteOutcome{row.Route, text(row.Envelope, "deliveryReason")}
	if outcome.state == "" {
		outcome.state = "no-verified-target"
	}
	routing := coordinationRoutingDescription(outcome, text(row.Envelope, "toSourceId"), text(row.Envelope, "toSessionId"))
	return clone(object{"stored": true, "pullable": true, "hint": "The message is stored and pullable through messages.", "message": row.Envelope,
		"negotiation": store.negotiation(text(row.Envelope, "negotiationId")), "deliveryMode": routing["deliveryMode"], "routing": routing})
}

func (store *coordinationMessageStore) beginNegotiation(args object, actor string, pair, resources []string, now int64) (*coordinationNegotiation, error) {
	idValue := text(args, "negotiationId")
	if store.negotiation(idValue) != nil {
		return nil, errors.New("INVALID_ARGUMENT: existing negotiation requires inReplyTo")
	}
	recent := 0
	open := map[string]int{}
	for _, n := range store.data.Negotiations {
		if n.Initiator == actor && n.CreatedAt > now-3600 {
			recent++
		}
		if !n.unresolved() && n.State == "open" {
			for _, recipient := range n.Participants {
				open[recipient]++
			}
		}
	}
	if recent >= 10 || open[pair[0]] >= 4 || open[pair[1]] >= 4 {
		return nil, errors.New("COORDINATION_RATE_LIMIT: at most four open negotiations per source and ten initiations per hour")
	}
	if idValue == "" {
		idValue = id()
	}
	n := &coordinationNegotiation{ID: idValue, Participants: pair, Initiator: actor, Resources: resources, State: "open",
		ReplyLimit: 3, CreatedAt: now, ExpiresAt: now + coordinationMessageDay, Decisions: []object{}}
	store.data.Negotiations = append(store.data.Negotiations, n)
	return n, nil
}

func (store *coordinationMessageStore) replyNegotiation(args object, actor, target string, pair, resources []string, now int64) (*coordinationNegotiation, error) {
	old := store.message(text(args, "inReplyTo"))
	if old == nil {
		return nil, errors.New("INVALID_ARGUMENT: inReplyTo must reference a retained message addressed to you; use relatedIds for other metadata links")
	}
	if old.Envelope["fromSourceId"] != target || old.Envelope["toSourceId"] != actor {
		return nil, errors.New("INVALID_ARGUMENT: inReplyTo must reference a message addressed to you by toSourceId; use relatedIds for other metadata links")
	}
	if args["type"] == "notice" {
		if args["negotiationId"] != nil {
			return nil, errors.New("INVALID_ARGUMENT: notice replies must omit negotiationId; inReplyTo links the message without opening or advancing a negotiation")
		}
		return nil, nil
	}
	n := store.negotiation(text(args, "negotiationId"))
	if n == nil {
		return nil, errors.New("NEGOTIATION_NOT_FOUND: negotiation replies require negotiationId; use type:notice with inReplyTo for a notice reply, or relatedIds to link metadata")
	}
	if n.unresolved() {
		return nil, errors.New("INVALID_ARGUMENT: negotiation participants are unresolved; inspect local messages and the participant recovery backup before starting a separate exchange")
	}
	if old.Envelope["negotiationId"] != n.ID || !slices.Equal(n.Participants, pair) || !slices.Equal(n.Resources, resources) {
		return nil, errors.New("INVALID_ARGUMENT: reply must reference this peer's message in the same negotiation and resource set")
	}
	if (args["type"] == "grant" || args["type"] == "deny") && old.Envelope["type"] != "request" && old.Envelope["type"] != "conditional" {
		return nil, errors.New("INVALID_ARGUMENT: grant or deny must answer a request or conditional")
	}
	if n.ExpiresAt <= now {
		return nil, errors.New("NEGOTIATION_EXPIRED: inspect messages and start a new request")
	}
	if n.State == "resolved" && len(n.Decisions) > 0 && n.Decisions[len(n.Decisions)-1]["action"] == "resolve" {
		return nil, errors.New("NEGOTIATION_RESOLVED: the user resolved this exchange; inspect messages before starting a new request")
	}
	n.AutomaticReplyCount++
	return n, nil
}

func (store *coordinationMessageStore) send(args object, actor string, outcome coordinationRouteOutcome, now int64, cost *runtimeCost) (object, error) {
	digest := hash([]byte(wire([]any{actor, args})))
	mid := text(args, "requestId")
	if previous := store.message(mid); previous != nil {
		if previous.Digest != digest {
			return nil, errors.New("REQUEST_ID_CONFLICT: retain the original message arguments")
		}
		return store.result(previous), nil
	}
	store.maintain(now)
	target := text(args, "toSourceId")
	if target == actor {
		return nil, errors.New("INVALID_ARGUMENT: address another control source")
	}
	pair := []string{actor, target}
	slices.Sort(pair)
	resources, err := coordinationMessageResources(args)
	if err != nil {
		return nil, err
	}
	for _, n := range store.data.Negotiations {
		if n.State == "escalated" && (slices.Equal(n.Participants, pair) || n.unresolved() && slices.ContainsFunc(n.Participants, func(p string) bool { return slices.Contains(pair, p) })) &&
			slices.ContainsFunc(n.Resources, func(key string) bool { return slices.Contains(resources, key) }) {
			return nil, errCoordinationNegotiationLimit
		}
	}
	var n *coordinationNegotiation
	switch {
	case args["inReplyTo"] != nil:
		n, err = store.replyNegotiation(args, actor, target, pair, resources, now)
	case args["type"] == "request":
		n, err = store.beginNegotiation(args, actor, pair, resources, now)
	case args["negotiationId"] != nil || slices.Contains([]string{"grant", "deny", "conditional"}, text(args, "type")):
		err = errors.New("INVALID_ARGUMENT: replies require negotiationId and inReplyTo")
	}
	if err != nil {
		return nil, err
	}
	escalated := false
	var negotiationID any
	if n != nil {
		if n.AutomaticReplyCount > n.ReplyLimit {
			return nil, errCoordinationNegotiationLimit
		}
		n.LastMessageID = mid
		negotiationID = n.ID
		switch {
		case n.AutomaticReplyCount == n.ReplyLimit:
			n.State, n.EscalationID, escalated = "escalated", new(id()), true
		case args["type"] == "grant" || args["type"] == "deny":
			n.State = "resolved"
		default:
			n.State = "open"
		}
	}
	delivery := "pull-only"
	if outcome.route != nil {
		delivery = "pending"
	}
	envelope := object{"messageId": mid, "negotiationId": negotiationID, "inReplyTo": args["inReplyTo"], "fromSourceId": actor, "fromSessionId": args["sessionId"],
		"toSourceId": target, "toSessionId": args["toSessionId"], "type": args["type"], "resources": resources, "summary": args["summary"],
		"conditions": args["conditions"], "relatedIds": args["relatedIds"], "automatic": true, "createdAt": now,
		"expiresAt": now + messageSecond(args, "ttlSeconds", coordinationMessageDay), "deliveryReason": outcome.state, "deliveryState": delivery, "escalated": escalated, "dataOnly": true}
	if len(wire(envelope)) > 4096 {
		return nil, errors.New("COORDINATION_CAPACITY: message envelope exceeds 4 KiB")
	}
	row := &coordinationMessageRow{Envelope: envelope, Digest: digest, Route: outcome.route, Due: now + 30}
	store.add(row)
	store.event(mid+"-created", "message.created", resources)
	if n != nil {
		store.event(mid+"-negotiation", "negotiation.changed", resources)
	}
	if escalated {
		for _, participant := range n.Participants {
			var session any
			for _, row := range slices.Backward(store.data.Messages) {
				if row.Envelope["toSourceId"] == participant && row.Envelope["negotiationId"] == n.ID {
					session = row.Envelope["toSessionId"]
					break
				}
			}
			envelope := object{"messageId": *n.EscalationID + "-" + hash([]byte(participant)), "negotiationId": n.ID, "fromSourceId": nil, "localOrigin": "arc",
				"toSourceId": participant, "toSessionId": session, "type": "notice", "resources": resources,
				"summary":   "Automatic reply budget exhausted. Ask the user to mediate; further automatic negotiation is stopped.",
				"automatic": true, "createdAt": now, "expiresAt": now + coordinationMessageDay, "deliveryState": "pull-only", "escalated": true, "dataOnly": true}
			store.add(&coordinationMessageRow{Envelope: envelope, Due: now + 30})
		}
	}
	return store.result(row), store.save(cost)
}

func (store *coordinationMessageStore) nextBackgroundAt(now int64, cost *runtimeCost) int64 {
	if store.scannedDeadline {
		return store.deadline
	}
	var next int64
	due := func(at int64) {
		if at != 0 && (next == 0 || at < next) {
			next = at
		}
	}
	if len(store.data.Pending) > 0 {
		due(now)
	}
	for _, n := range store.data.Negotiations {
		if cost != nil {
			cost.rows.Add(1)
		}
		if !n.unresolved() && n.State == "open" {
			due(n.ExpiresAt)
		}
		if !n.unresolved() && n.State != "escalated" {
			due(n.ExpiresAt + 7*coordinationMessageDay)
		}
	}
	for _, row := range store.data.Messages {
		if cost != nil {
			cost.rows.Add(1)
		}
		switch row.Envelope["deliveryState"] {
		case "sending":
			due(now)
		case "pending":
			due(messageSecond(row.Envelope, "expiresAt", now))
			if row.Route != nil {
				due(max(row.Due, store.data.LastPush[row.Route.RouteID]+60))
			}
		}
		n := store.negotiation(text(row.Envelope, "negotiationId"))
		if n == nil || !n.unresolved() {
			due(messageSecond(row.Envelope, "createdAt", now) + 7*coordinationMessageDay)
		}
	}
	for _, at := range store.data.LastPush {
		due(at + coordinationMessageDay)
	}
	store.scannedDeadline, store.deadline = true, next
	return next
}

func (store *coordinationMessageStore) list(args object, actor, revision string, now int64, cost *runtimeCost) (object, error) {
	if deadline := store.nextBackgroundAt(now, cost); deadline != 0 && deadline <= now && store.maintain(now) {
		if err := store.save(cost); err != nil {
			return nil, err
		}
	}
	if mid, ok := args["recoveryMessageId"].(string); ok {
		row := store.message(mid)
		if row == nil || actor != "local-authority" && row.Envelope["toSourceId"] != actor {
			return nil, errors.New("MESSAGE_NOT_FOUND: read your addressed recovery messages")
		}
		raw := "0"
		if value, ok := args["recoveryCursor"].(string); ok {
			raw = value
		}
		offset, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return nil, errors.New("INVALID_ARGUMENT: use the recovery cursor returned by messages")
		}
		if offset > uint64(len(row.RecoveryRefs)) {
			return nil, errors.New("MESSAGES_CURSOR_EXPIRED: reread the recovery message after successor suppression")
		}
		end := min(int(offset)+20, len(row.RecoveryRefs))
		var cursor any
		if end < len(row.RecoveryRefs) {
			cursor = strconv.Itoa(end)
		}
		return object{"messageId": mid, "threadRefs": slices.Clone(row.RecoveryRefs[offset:end]), "nextRecoveryCursor": cursor, "automaticResume": false}, nil
	}
	direction := "inbox"
	if value, ok := args["direction"].(string); ok {
		direction = value
	}
	scope := hash([]byte(wire([]any{actor, revision, direction, args["sessionId"], args["negotiationId"]})))
	var after uint64
	if token, ok := args["cursor"].(string); ok {
		var value object
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || decodeObject(raw, &value) != nil {
			return nil, errors.New("MESSAGES_CURSOR_EXPIRED: restart messages pagination")
		}
		after, ok = uintValue(value["after"])
		if !ok {
			return nil, errors.New("MESSAGES_CURSOR_EXPIRED: invalid cursor")
		}
		if value["epoch"] != store.data.Epoch || value["scope"] != scope || after < store.data.Floor && uintOr(value["floor"], 0) != store.data.Floor || after >= store.data.Next {
			return nil, errors.New("MESSAGES_CURSOR_EXPIRED: restart pagination with current authority and filters")
		}
	}
	sourceKey, sessionKey := "toSourceId", "toSessionId"
	if direction == "outbox" {
		sourceKey, sessionKey = "fromSourceId", "fromSessionId"
	}
	messages := []object{}
	negotiations := []*coordinationNegotiation{}
	last, hasMore := store.data.Next-1, false
	for _, row := range store.data.Messages {
		if row.Sequence <= after || actor != "local-authority" && row.Envelope[sourceKey] != actor ||
			args["negotiationId"] != nil && args["negotiationId"] != row.Envelope["negotiationId"] ||
			args["sessionId"] != nil && args["sessionId"] != row.Envelope[sessionKey] {
			continue
		}
		if uint64(len(messages)) >= uintOr(args["limit"], 50) {
			hasMore = true
			break
		}
		messages = append(messages, row.Envelope)
		last = row.Sequence
	}
	for _, n := range store.data.Negotiations {
		if (actor == "local-authority" || slices.Contains(n.Participants, actor)) && (args["negotiationId"] == nil || args["negotiationId"] == n.ID) {
			negotiations = append(negotiations, n)
		}
	}
	cursor := base64.RawURLEncoding.EncodeToString([]byte(wire(object{"epoch": store.data.Epoch, "scope": scope, "after": last, "floor": store.data.Floor})))
	return clone(object{"messages": messages, "negotiations": negotiations, "nextCursor": cursor, "hasMore": hasMore, "dataOnly": true, "projectionPending": len(store.data.Pending) > 0}), nil
}

func (store *coordinationMessageStore) mediate(args object, now int64, cost *runtimeCost) (object, error) {
	n := store.negotiation(text(args, "negotiationId"))
	if n == nil {
		return nil, errors.New("NEGOTIATION_NOT_FOUND: inspect local messages")
	}
	reopen := args["action"] == "reopen"
	if n.unresolved() && reopen {
		return nil, errors.New("INVALID_ARGUMENT: cannot reopen a negotiation with unresolved participants; inspect the participant recovery backup")
	}
	if args["expectedLastMessageId"] != n.LastMessageID {
		return nil, errors.New("NEGOTIATION_CONFLICT: reread the local negotiation")
	}
	if len(n.Decisions) >= 64 {
		return nil, errors.New("COORDINATION_CAPACITY: local decision history is full")
	}
	n.Decisions = append(n.Decisions, object{"at": now, "actor": "local-authority", "action": args["action"], "reason": args["reason"]})
	n.State, n.EscalationID = "resolved", nil
	if reopen {
		n.State, n.AutomaticReplyCount, n.ExpiresAt = "open", 0, now+coordinationMessageDay
	}
	store.event(n.ID+"-mediated-"+id(), "negotiation.changed", n.Resources)
	return clone(object{"negotiation": n}), store.save(cost)
}

func (store *coordinationMessageStore) recovery(blocker, recipient object, now int64, cost *runtimeCost) error {
	mid := hash([]byte(wire([]any{"recovery", blocker["id"], blocker["revision"], recipient["sessionId"]})))
	if store.message(mid) != nil {
		return nil
	}
	store.maintain(now)
	envelope := selectFields(blocker, "resources", "causeCode", "summary", "clearedBy", "fixingCommit", "reason", "evidenceIds", "openedAt", "clearedAt")
	maps.Copy(envelope, object{"messageId": mid, "localOrigin": "arc", "fromSourceId": nil, "toSourceId": recipient["sourceId"], "toSessionId": recipient["sessionId"],
		"type": "recovery", "blockerId": blocker["id"], "clearRevision": blocker["revision"], "provenance": "source-reported", "clearance": "claim",
		"suggestedNextStep": "inspect", "reportedNextStep": blocker["suggestedNextStep"], "impact": "candidate-co-occurrence", "automatic": true, "dataOnly": true,
		"automaticResume": false, "createdAt": now, "expiresAt": now + coordinationMessageDay, "deliveryState": "pull-only"})
	var refs []object
	if err := unmarshalJSON([]byte(wire(recipient["threadRefs"])), &refs); err != nil {
		return err
	}
	row := &coordinationMessageRow{Envelope: envelope, Digest: mid, Due: now + 30, RecoveryRefs: refs}
	if err := row.recoveryPage(); err != nil {
		return err
	}
	store.add(row)
	store.event(mid+"-created", "message.created", coordinationResourceStrings(envelope["resources"]))
	return store.save(cost)
}

func (row *coordinationMessageRow) recoveryPage() error {
	count := min(len(row.RecoveryRefs), 20)
	for {
		row.Envelope["threadRefs"] = append([]object{}, row.RecoveryRefs[:count]...)
		row.Envelope["next"] = nil
		if count < len(row.RecoveryRefs) {
			row.Envelope["next"] = object{"via": "query", "op": "messages", "args": object{"recoveryMessageId": row.Envelope["messageId"], "recoveryCursor": strconv.Itoa(count)}}
		}
		if len(wire(row.Envelope)) <= 4096 {
			return nil
		}
		if count <= 1 {
			return errors.New("COORDINATION_CAPACITY: recovery metadata exceeds the 4 KiB message bound")
		}
		count--
	}
}
func (store *coordinationMessageStore) refreshRecovery(events []object, cost *runtimeCost) error {
	changed := false
	for _, row := range store.data.Messages {
		if row.Envelope["type"] != "recovery" || row.Envelope["deliveryState"] != "pending" && row.Envelope["deliveryState"] != "pull-only" {
			continue
		}
		before := len(row.RecoveryRefs)
		row.RecoveryRefs = slices.DeleteFunc(row.RecoveryRefs, func(reference object) bool {
			ref := coordinationThreadRef{text(reference, "threadId"), axOptional(reference["turnId"])}
			return obsoleteCoordinationRecovery(ref, messageSecond(reference, "interruptedAt", 0), events)
		})
		if len(row.RecoveryRefs) == before {
			continue
		}
		if err := row.recoveryPage(); err != nil {
			return err
		}
		if len(row.RecoveryRefs) == 0 {
			row.Envelope["deliveryState"] = "suppressed"
			store.event(text(row.Envelope, "messageId")+"-suppressed", "message.delivery", coordinationResourceStrings(row.Envelope["resources"]))
		}
		changed = true
	}
	if changed {
		return store.save(cost)
	}
	return nil
}

func (store *coordinationMessageStore) batches(now int64, cost *runtimeCost) ([][]coordinationMessageRow, error) {
	if store.maintain(now) {
		if err := store.save(cost); err != nil {
			return nil, err
		}
	}
	groups := map[string][]coordinationMessageRow{}
	for _, row := range store.data.Messages {
		if cost != nil {
			cost.rows.Add(1)
		}
		if row.Route != nil && row.Envelope["deliveryState"] == "pending" && row.Due <= now && now-store.data.LastPush[row.Route.RouteID] >= 60 {
			groups[row.Route.RouteID] = nil
		}
	}
	for _, row := range store.data.Messages {
		if row.Route == nil || row.Envelope["deliveryState"] != "pending" {
			continue
		}
		id := row.Route.RouteID
		if rows, ok := groups[id]; ok && len(rows) < 16 {
			groups[id] = append(rows, copyCoordinationMessageRow(row))
		}
	}
	keys := slices.Sorted(maps.Keys(groups))
	result := [][]coordinationMessageRow{}
	for _, key := range keys[:min(16, len(keys))] {
		result = append(result, groups[key])
	}
	return result, nil
}

func (store *coordinationMessageStore) mark(rows []coordinationMessageRow, state string, now int64, cost *runtimeCost) error {
	changed := false
	for _, previous := range rows {
		row := store.message(text(previous.Envelope, "messageId"))
		if row == nil || row.Sequence != previous.Sequence {
			continue
		}
		row.Envelope["deliveryState"] = state
		switch state {
		case "sending":
			row.Attempts++
			store.data.LastPush[row.Route.RouteID] = now
		case "pending":
			row.Due = now + 60
			if row.Attempts > 0 {
				row.Attempts--
			}
		}
		changed = true
	}
	if state != "sending" && state != "pending" && len(rows) > 0 {
		row := rows[0]
		store.event(text(row.Envelope, "messageId")+"-delivery-"+state, "message.delivery", coordinationResourceStrings(row.Envelope["resources"]))
		changed = true
	}
	if changed {
		return store.save(cost)
	}
	return nil
}
