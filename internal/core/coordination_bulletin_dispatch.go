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
		} else if p, ok := field(baseline, "root").(string); ok && filepath.Join(p, ".git") == text(baseline, "commonDir") {
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
	clock := currentBulletinClock()
	_, err := withBulletinStore(func(store *bulletinStore) (struct{}, error) {
		for _, row := range store.state.Notices {
			if strPtr(row.DispatchID) == dispatch {
				return struct{}{}, nil
			}
		}
		store.prune(clock)
		if len(store.state.Notices) >= 256 {
			return struct{}{}, errors.New("COORDINATION_CAPACITY: retain dispatch projection until bulletin capacity is available")
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
			return struct{}{}, err
		}
		store.state.Notices = append(store.state.Notices, row)
		return struct{}{}, store.save(clock)
	})
	return err
}

func init() {
	coordinationEventProjections = append(coordinationEventProjections, bulletinFromDispatch)
	registerOperationProjection("receipt", func(ctx context.Context, _ operationRequest, receipt object) error {
		refreshCoordinationDispatchAdvisory(ctx, receipt)
		return nil
	})
}
