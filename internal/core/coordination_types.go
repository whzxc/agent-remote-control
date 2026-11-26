package core

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

var coordinationIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

func coordinationIdentifier(value string) bool {
	return value != "." && value != ".." && coordinationIDPattern.MatchString(value)
}

func invalidCoordinationIdentifier() error {
	return errors.New("INVALID_ARGUMENT: expected an opaque coordination identifier")
}

type coordinationPrincipal struct {
	Type      string  `json:"type"`
	SourceID  string  `json:"sourceId,omitempty"`
	AccountID *string `json:"accountId,omitempty"`
}

func coordinationPrincipalFromOrigin(origin object) (*coordinationPrincipal, error) {
	if origin == nil {
		return nil, nil
	}
	if origin["authType"] == "local" && (origin["ingressId"] == "local-cli" || origin["ingressId"] == "local-ui") {
		return &coordinationPrincipal{Type: "local-authority"}, nil
	}
	source := text(origin, "sourceId")
	account, hasAccount := origin["accountId"].(string)
	if !coordinationIdentifier(source) || hasAccount && !coordinationIdentifier(account) {
		return nil, invalidCoordinationIdentifier()
	}
	result := &coordinationPrincipal{Type: "source", SourceID: source}
	if hasAccount {
		result.AccountID = &account
	}
	return result, nil
}

func coordinationResource(value string) (string, error) {
	kind, rest, _ := strings.Cut(value, ":")
	valid := false
	switch kind {
	case "app":
		valid = rest == "installed"
	case "project":
		project, ok := strings.CutSuffix(rest, "/main")
		valid = ok && coordinationIdentifier(project)
	case "lane":
		project, lane, qualified := strings.Cut(rest, "/")
		valid = coordinationIdentifier(project) && (!qualified || coordinationIdentifier(lane))
	case "host", "isolated":
		valid = coordinationIdentifier(rest)
	}
	if valid {
		return value, nil
	}
	message := "INVALID_ARGUMENT: use app:installed (example app:installed), project:<id>/main (example project:00000000-0000-4000-8000-000000000001/main), lane:<project>/<name> (example lane:00000000-0000-4000-8000-000000000001/worker), host:<id> (example host:server), or isolated:<id> (example isolated:preview). <id> in project keys and <project> in lane keys MUST be the registered project ID from query projects. Keys MUST match ARC-observed transition resources exactly for conflict detection. Event reads may use a unique retained lane:<name> shorthand (example lane:worker)."
	if slices.Contains([]string{"node", "service", "deployment", "host"}, kind) {
		host, _, _ := strings.Cut(rest, "/")
		if coordinationIdentifier(host) {
			message += fmt.Sprintf(" For a host or service deployment, use host:%s.", host)
		}
	}
	return "", errors.New(message)
}

func coordinationLaneShorthand(key string) string {
	lane, ok := strings.CutPrefix(key, "lane:")
	if ok && !strings.Contains(lane, "/") {
		return lane
	}
	return ""
}

func resolveCoordinationResource(resource string, retained []string) (string, error) {
	key, err := coordinationResource(resource)
	if err != nil {
		return "", err
	}
	lane := coordinationLaneShorthand(key)
	if lane == "" {
		return key, nil
	}
	choices := []string{}
	for _, candidate := range retained {
		if strings.HasPrefix(candidate, "lane:") && strings.HasSuffix(candidate, "/"+lane) {
			choices = append(choices, candidate)
		}
	}
	slices.Sort(choices)
	choices = slices.Compact(choices)
	switch len(choices) {
	case 0:
		return "", errors.New("RESOURCE_UNKNOWN: use a qualified lane:<project>/<name> key")
	case 1:
		return choices[0], nil
	default:
		return "", fmt.Errorf("RESOURCE_AMBIGUOUS: use one of %s", strings.Join(choices[:min(16, len(choices))], ", "))
	}
}

func canonicalCoordinationResource(value string, registry any) (string, error) {
	kind, tail, _ := strings.Cut(value, ":")
	selector, suffix, qualified := strings.Cut(tail, "/")
	if !qualified || (kind != "project" && kind != "lane") || (kind == "project" && suffix != "main") {
		return coordinationResource(value)
	}
	projects := arr(field(registry, "projects"))
	if project := find(projects, "id", selector); project != nil {
		return coordinationResource(kind + ":" + text(project, "id") + "/" + suffix)
	}
	var match any
	for _, project := range projects {
		if field(project, "name") != selector {
			continue
		}
		if match != nil {
			return "", errors.New("RESOURCE_AMBIGUOUS: use the registered project ID from query projects")
		}
		match = project
	}
	if match == nil {
		return "", errors.New("RESOURCE_UNKNOWN: project is not registered; query projects for its ID")
	}
	return coordinationResource(kind + ":" + text(match, "id") + "/" + suffix)
}

type coordinationThreadRef struct {
	ThreadID string  `json:"threadId"`
	TurnID   *string `json:"turnId"`
}
type coordinationEvidenceRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type coordinationAttribution struct {
	Confidence string   `json:"confidence"`
	ThreadIDs  []string `json:"threadIds"`
}
type coordinationDispatchAssociation struct {
	Resources          []string `json:"resources"`
	Project            string   `json:"project"`
	Lane               string   `json:"lane"`
	Source             string   `json:"source"`
	Session            string   `json:"session"`
	RegistryObservedAt *string  `json:"registryObservedAt"`
}
type coordinationObservation struct {
	DispatchAssociation *coordinationDispatchAssociation `json:"dispatchAssociation,omitempty"`
	Model               *string                          `json:"model,omitempty"`
	SessionID           *string                          `json:"sessionId,omitempty"`
	SessionBindingID    *string                          `json:"sessionBindingId,omitempty"`
	Effort              *string                          `json:"effort,omitempty"`
	InterruptedTurns    *uint64                          `json:"interruptedTurns,omitempty"`
	ResumeSubmissions   *uint64                          `json:"resumeSubmissions,omitempty"`
	AttentionTurns      *uint64                          `json:"attentionTurns,omitempty"`
	OldOID              *string                          `json:"oldOid,omitempty"`
	NewOID              *string                          `json:"newOid,omitempty"`
	Movement            *string                          `json:"movement,omitempty"`
}

type coordinationEventInput struct {
	TransitionID string                    `json:"transitionId"`
	Kind         string                    `json:"kind"`
	Resources    []string                  `json:"resources"`
	Origin       *coordinationPrincipal    `json:"origin"`
	OccurredAt   *string                   `json:"occurredAt"`
	Status       *string                   `json:"status"`
	ThreadRefs   []coordinationThreadRef   `json:"threadRefs"`
	EvidenceRefs []coordinationEvidenceRef `json:"evidenceRefs"`
	Attribution  *coordinationAttribution  `json:"attribution"`
	Observation  *coordinationObservation  `json:"observation,omitempty"`
}

func newCoordinationEvent(id, kind string, resources []string) coordinationEventInput {
	return coordinationEventInput{TransitionID: id, Kind: kind, Resources: resources, ThreadRefs: []coordinationThreadRef{}, EvidenceRefs: []coordinationEvidenceRef{}}
}

var coordinationEventKinds = [...]string{
	"message.created", "message.delivery", "negotiation.changed", "dispatch.accepted", "receipt.unconfirmed",
	"lane.created", "lane.landed", "lane.removed", "isolated.started", "isolated.exited",
	"turn.terminal", "turn.successor", "app.replace", "app.restarted", "git.ref-moved",
	"notification.delivery-failed", "receipt.stalled", "ax.created", "ax.changed", "notice.changed", "blocker.changed",
}

var coordinationEventSummaries = [...]string{
	"Coordination message created", "Coordination message delivery changed", "Coordination negotiation state changed",
	"Dispatch accepted", "Receipt ended unconfirmed", "Lane created", "Lane landed", "Lane removed",
	"Isolated supervisor started", "Isolated supervisor exited", "Turn reached a terminal state", "Successor turn observed",
	"Application replacement state changed", "ARC instance restarted", "Registered Git ref changed",
	"Notification delivery attempt failed", "Receipt progress stalled", "AX entry created", "AX entry changed",
	"Notice state changed", "Blocker state changed",
}

var coordinationModelPattern = regexp.MustCompile(`^[a-zA-Z0-9_.:/-]{0,128}$`)
var coordinationOIDPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$`)

func coordinationTimestamp(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func (input coordinationEventInput) project(epoch string, sequence uint64, ms int64) (object, error) {
	if !coordinationIdentifier(input.TransitionID) {
		return nil, invalidCoordinationIdentifier()
	}
	if year := time.UnixMilli(ms).UTC().Year(); year < -262143 || year > 262142 {
		return nil, errors.New("INVALID_ARGUMENT: observed time is out of range")
	}
	kind := slices.Index(coordinationEventKinds[:], input.Kind)
	if kind < 0 {
		return nil, errors.New("INVALID_ARGUMENT: invalid coordination event kind")
	}
	if len(input.Resources) == 0 || len(input.Resources) > 16 || len(input.ThreadRefs) > 16 || len(input.EvidenceRefs) > 16 {
		return nil, errors.New("COORDINATION_CAPACITY: metadata arrays exceed their bounds")
	}
	for _, key := range input.Resources {
		if key == "unattributed:dispatch" {
			continue
		}
		if _, err := coordinationResource(key); err != nil {
			return nil, err
		}
		if coordinationLaneShorthand(key) != "" {
			return nil, errors.New("INVALID_ARGUMENT: producers must qualify lanes with their registered parent")
		}
	}
	if p := input.Origin; p != nil {
		switch p.Type {
		case "source":
			if !coordinationIdentifier(p.SourceID) || (p.AccountID != nil && !coordinationIdentifier(*p.AccountID)) {
				return nil, invalidCoordinationIdentifier()
			}
		case "local-authority", "arc":
			if p.SourceID != "" || p.AccountID != nil {
				return nil, invalidCoordinationIdentifier()
			}
		default:
			return nil, invalidCoordinationIdentifier()
		}
	}
	for _, thread := range input.ThreadRefs {
		if !coordinationIdentifier(thread.ThreadID) || (thread.TurnID != nil && !coordinationIdentifier(*thread.TurnID)) {
			return nil, invalidCoordinationIdentifier()
		}
	}
	for _, evidence := range input.EvidenceRefs {
		if !coordinationIdentifier(evidence.ID) {
			return nil, invalidCoordinationIdentifier()
		}
		if !slices.Contains([]string{"notice", "blocker", "receipt", "request", "thread", "turn", "dispatch", "replacement", "ax", "git-object", "git-ref", "core-instance"}, evidence.Kind) {
			return nil, errors.New("INVALID_ARGUMENT: invalid coordination evidence kind")
		}
	}
	var attribution any
	if a := input.Attribution; a != nil {
		if len(a.ThreadIDs) > 16 {
			return nil, errors.New("COORDINATION_CAPACITY: attribution exceeds 16 threads")
		}
		for _, thread := range a.ThreadIDs {
			if !coordinationIdentifier(thread) {
				return nil, invalidCoordinationIdentifier()
			}
		}
		if !slices.Contains([]string{"correlated", "ambiguous", "unknown"}, a.Confidence) {
			return nil, errors.New("INVALID_ARGUMENT: invalid coordination attribution confidence")
		}
		attribution = object{"basis": "turn-baseline", "confidence": a.Confidence, "threadIds": a.ThreadIDs}
	}
	basis := "observed"
	if input.OccurredAt != nil {
		if _, err := time.Parse(time.RFC3339Nano, *input.OccurredAt); err != nil {
			return nil, errors.New("INVALID_ARGUMENT: occurredAt must be RFC3339")
		}
		basis = "upstream"
	}
	if input.Status != nil && !slices.Contains([]string{"active", "uncertain", "stale", "cleared", "withdrawn", "accepted", "cancelled", "settling", "recovery-summary", "unconfirmed", "submitted", "running", "completed", "failed", "interrupted", "rolled-back", "succeeded", "unknown", "candidate", "open", "triaged", "closed", "merged", "rejected"}, *input.Status) {
		return nil, errors.New("INVALID_ARGUMENT: invalid coordination event status")
	}
	if detail := input.Observation; detail != nil {
		for _, session := range []*string{detail.SessionID, detail.SessionBindingID} {
			if session != nil && !coordinationIdentifier(*session) {
				return nil, invalidCoordinationIdentifier()
			}
		}
		for _, value := range []*string{detail.Model, detail.Effort} {
			if value != nil && !coordinationModelPattern.MatchString(*value) {
				return nil, errors.New("INVALID_ARGUMENT: invalid model or effort metadata")
			}
		}
		for _, oid := range []*string{detail.OldOID, detail.NewOID} {
			if oid != nil && !coordinationOIDPattern.MatchString(*oid) {
				return nil, errors.New("INVALID_ARGUMENT: invalid Git object ID")
			}
		}
		if detail.Movement != nil && !slices.Contains([]string{"created", "moved", "deleted", "non-fast-forward", "unknown"}, *detail.Movement) {
			return nil, errors.New("INVALID_ARGUMENT: invalid Git ref movement")
		}
	}
	if input.ThreadRefs == nil {
		input.ThreadRefs = []coordinationThreadRef{}
	}
	if input.EvidenceRefs == nil {
		input.EvidenceRefs = []coordinationEvidenceRef{}
	}
	return object{
		"eventId": hash([]byte(epoch + ":" + input.TransitionID)), "sequence": sequence, "kind": input.Kind,
		"provenance": "arc-observed", "resources": input.Resources, "observedAt": coordinationTimestamp(ms),
		"occurredAt": input.OccurredAt, "timeBasis": basis, "origin": input.Origin, "threadRefs": input.ThreadRefs,
		"summary": coordinationEventSummaries[kind], "evidenceRefs": input.EvidenceRefs, "status": input.Status,
		"observation": input.Observation, "attribution": attribution,
	}, nil
}
