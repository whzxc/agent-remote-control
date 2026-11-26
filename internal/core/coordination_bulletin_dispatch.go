package core

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func coordinationAssociateDispatch(baseline, registry any) object {
	projects := arr(field(registry, "projects"))
	complete := projects != nil && len(projects) <= 32
	matches := []string{}
	for _, project := range projects[:min(32, len(projects))] {
		roots := arr(field(project, "roots"))
		complete = complete && roots != nil && len(roots) <= 8
		id := text(project, "id")
		if !coordinationIdentifier(id) {
			continue
		}
		for _, root := range roots[:min(8, len(roots))] {
			path, hasPath := field(baseline, "root").(string)
			common, hasCommon := field(baseline, "commonDir").(string)
			if hasPath && field(root, "path") == path || hasCommon && field(root, "commonDir") == common {
				matches = append(matches, id)
			}
		}
	}
	matches = axSet(matches)
	project, lane := "unattributed", "unattributed"
	resources := []string{}
	switch {
	case !complete:
		project = "registry-unavailable"
	case len(matches) > 1:
		project = "ambiguous"
	case len(matches) == 1:
		project = "registered-root"
		if name, ok := strings.CutPrefix(text(baseline, "ref"), "refs/heads/wt/"); ok {
			if key, err := coordinationResource("lane:" + matches[0] + "/" + name); err == nil {
				resources = append(resources, key)
				lane = "git-baseline"
			}
		} else if p, ok := field(baseline, "root").(string); ok && filepath.Join(p, ".git") == filepath.Clean(text(baseline, "commonDir")) {
			resources = append(resources, "project:"+matches[0]+"/main")
			lane = "not-a-lane"
		}
	}
	return object{"resources": resources, "project": project, "lane": lane, "registryObservedAt": field(registry, "observedAt")}
}

func coordinationDispatchAdvisory(ctx context.Context, origin object, baseline any) object {
	registry, _ := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
	association := coordinationAssociateDispatch(baseline, registry)
	association["source"], association["session"] = "unattributed", "unattributed"
	if owner, err := coordinationPrincipalFromOrigin(origin); err == nil && owner != nil {
		association["source"] = "observed"
	}
	resources := coordinationResourceStrings(association["resources"])
	advisory := bulletinWarnings(ctx, resources, "")
	if len(resources) == 0 && advisory["conflictCoverage"] != "unknown" {
		advisory["conflictCoverage"] = "unattributed"
	}
	advisory["association"], advisory["admissionBoardRevision"], advisory["freshness"] = association, advisory["boardRevision"], "admission"
	return advisory
}

func refreshCoordinationDispatchAdvisory(ctx context.Context, receipt object) {
	history := obj(receipt["coordination"])
	if history == nil {
		return
	}
	association := history["association"]
	resources := coordinationResourceStrings(field(association, "resources"))
	advisory := bulletinWarnings(ctx, resources, "")
	own := "dispatch-" + hash([]byte(text(receipt, "requestId")))
	if conflicts, ok := advisory["conflicts"].([]object); ok {
		advisory["conflicts"] = slices.DeleteFunc(conflicts, func(row object) bool { return row["noticeId"] == own })
	}
	if field(association, "resources") != nil && len(resources) == 0 && advisory["conflictCoverage"] != "unknown" {
		advisory["conflictCoverage"] = "unattributed"
	}
	advisory["association"], advisory["admissionBoardRevision"], advisory["freshness"] = association, history["admissionBoardRevision"], "refreshed"
	receipt["coordination"] = advisory
}

func bulletinFromDispatch(input coordinationEventInput) error {
	if input.Kind != "dispatch.accepted" || input.Observation == nil || input.Observation.DispatchAssociation == nil {
		return nil
	}
	_, err := withBulletinStore(func(store *bulletinStore) (struct{}, error) {
		return struct{}{}, store.dispatchNotice(input, currentBulletinClock())
	})
	return err
}

func (store *bulletinStore) dispatchNotice(input coordinationEventInput, clock bulletinClock) error {
	if input.Observation == nil || input.Observation.DispatchAssociation == nil {
		return nil
	}
	dispatch := ""
	for _, ref := range input.EvidenceRefs {
		if ref.Kind == "request" {
			dispatch = ref.ID
			break
		}
	}
	if dispatch == "" {
		return nil
	}
	if store.dispatchNotices[dispatch] {
		return nil
	}
	store.prune(clock)
	if len(store.state.Notices) >= 256 {
		return errors.New("COORDINATION_CAPACITY: retain dispatch projection until bulletin capacity is available")
	}
	association := input.Observation.DispatchAssociation
	owner := coordinationPrincipal{Type: "arc"}
	if input.Origin != nil {
		owner = *input.Origin
	}
	links := []bulletinLink{}
	for _, ref := range input.ThreadRefs {
		if ref.TurnID != nil {
			links = append(links, bulletinLink{ThreadID: ref.ThreadID, ObservedTurnID: ref.TurnID, ScopeState: "unknown", Terminals: map[string]any{}})
		}
	}
	at := clock.utc
	if input.OccurredAt != nil {
		if phase, err := time.Parse(time.RFC3339Nano, *input.OccurredAt); err == nil {
			at = phase.UnixMilli()
		}
	}
	row := &bulletinRecord{ID: "dispatch-" + hash([]byte(dispatch)), DispatchID: &dispatch, Association: association, Revision: 1, Owner: owner,
		Resources: association.Resources, Intent: new("ARC dispatch"), ThreadLinks: links, EvidenceIDs: []string{}, CreatedAt: at, LastActiveAt: at, State: "active"}
	if err := store.event(row, false); err != nil {
		return err
	}
	store.state.Notices = append(store.state.Notices, row)
	return store.save(clock)
}

func init() {
	coordinationEventProjections = append(coordinationEventProjections, bulletinFromDispatch)
	registerOperationPreparation("command", prepareCommandAdvisory)
	for _, op := range []string{"receipt", "codex_create", "codex_send", "agent_create", "agent_send", "resume", "codex_resume", "agent_resume"} {
		registerOperationProjection(op, func(ctx context.Context, request operationRequest, value object) error {
			action := text(request.args, "action")
			if request.name == "receipt" && (action == "" || action == "read") || value["replayed"] == true {
				refreshCoordinationDispatchAdvisory(ctx, value)
			}
			return nil
		})
	}
}

func prepareCommandAdvisory(ctx context.Context, request operationRequest) operationProjection {
	args := request.args
	var words []string
	if command, ok := args["cmd"].(string); ok {
		if strings.ContainsAny(command, ";&|`$<>\\\n\"'") {
			return nil
		}
		words = strings.Fields(command)
	} else {
		raw := arr(field(args["params"], "command"))
		words = axStrings(raw)
		if len(raw) != len(words) {
			return nil
		}
	}
	if len(words) < 2 {
		return nil
	}
	name := filepath.Base(words[0])
	if strings.TrimSuffix(name, filepath.Ext(name)) != "git" {
		return nil
	}
	index := 1
	cwd := firstTaskText(args["cwd"], field(args["params"], "cwd"))
	if words[index] == "-C" {
		if len(words) < 4 {
			return nil
		}
		cwd, index = words[2], 3
	}
	if words[index] != "push" {
		return nil
	}
	warnings := object{"conflicts": []object{}, "conflictCoverage": "unknown"}
	if resources, err := coordinationRepositoryResources(cwd); err == nil {
		warnings = bulletinWarnings(ctx, resources, "")
	}
	return func(_ context.Context, _ operationRequest, value object) error {
		value["conflicts"], value["conflictCoverage"] = warnings["conflicts"], warnings["conflictCoverage"]
		return nil
	}
}
