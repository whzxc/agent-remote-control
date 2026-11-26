package core

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The source owner resolves current credential evidence before the journal lock.
var readCoordinationSource func(context.Context, object) (object, error)
var coordinationEventProjections []func(coordinationEventInput) error
var coordinationObserverCoverage func() any

var coordinationJournalResident struct {
	sync.Mutex
	path    string
	stamp   *fileStamp
	journal *coordinationJournal
}

func withCoordinationJournal[T any](work func(*coordinationJournal) (T, error)) (T, error) {
	var zero T
	resident := &coordinationJournalResident
	resident.Lock()
	defer resident.Unlock()
	dir := filepath.Join(root(), "coordination/events")
	path := filepath.Join(dir, "manifest.json")
	stamp, err := readStamp(path)
	if err != nil {
		return zero, err
	}
	if resident.journal == nil || resident.path != path || !stampSame(resident.stamp, stamp) {
		resident.journal = nil
		journal, err := openCoordinationJournal(dir, time.Now().UnixMilli())
		if err != nil {
			return zero, err
		}
		resident.path, resident.journal = path, journal
	}
	result, err := work(resident.journal)
	if err == nil {
		resident.stamp, err = readStamp(path)
	}
	if err != nil && (strings.HasPrefix(err.Error(), "COORDINATION_STORAGE") || strings.HasPrefix(err.Error(), "COORDINATION_CORRUPT")) {
		resident.journal = nil
	}
	return result, err
}

func emitCoordinationEvent(input coordinationEventInput) (object, error) {
	result, err := withCoordinationJournal(func(journal *coordinationJournal) (object, error) {
		return journal.emit(input, time.Now().UnixMilli())
	})
	if err != nil {
		return nil, err
	}
	for _, project := range coordinationEventProjections {
		if err := project(input); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func coordinationReadAuthority(ctx context.Context, local bool) (coordinationReader, error) {
	origin := currentOrigin(ctx)
	if local && readCoordinationSource == nil && (origin["ingressId"] == "local-cli" || origin["sourceId"] == "local-cli") {
		return coordinationReader{coordinationPrincipal{Type: "local-authority"}, hash([]byte(wire([]any{1, "local-cli", "local-cli", nil})))}, nil
	}
	source, err := readCoordinationSource(ctx, origin)
	if err != nil {
		return coordinationReader{}, err
	}
	if source["state"] == "revoked" || source["connectionRemoved"] == true || source["id"] != origin["sourceId"] {
		return coordinationReader{}, errors.New("SOURCE_REVOKED: restore this control source in local ARC management")
	}
	principal, err := coordinationPrincipalFromOrigin(origin)
	if err != nil {
		return coordinationReader{}, err
	}
	if principal == nil {
		return coordinationReader{}, errors.New("SOURCE_REQUIRED: events requires authenticated source or local authority")
	}
	if principal.Type == "local-authority" && (source["ingressId"] != "local-cli" || field(source["credential"], "type") != "local") {
		return coordinationReader{}, errors.New("SOURCE_REQUIRED: local authority evidence missing")
	}
	if principal.Type != "local-authority" && source["ingressId"] != origin["ingressId"] {
		return coordinationReader{}, errors.New("SOURCE_REVOKED: connection changed; reconnect this control source")
	}
	return coordinationReader{*principal, hash([]byte(wire([]any{1, source["id"], source["ingressId"], source["credential"]})))}, nil
}

func coordinationEventQuery(ctx context.Context, request operationRequest) (any, error) {
	reader, err := coordinationReadAuthority(ctx, request.source.local)
	var result object
	if err == nil {
		args := clone(request.args)
		delete(args, "view")
		var query coordinationQuery
		if decodeCoordinationRecord([]byte(wire(args)), &query) != nil {
			err = errors.New("INVALID_ARGUMENT: read guide for events")
		} else {
			result, err = withCoordinationJournal(func(journal *coordinationJournal) (object, error) {
				return journal.query(reader, query, time.Now().UnixMilli())
			})
		}
	}
	if err == nil {
		if coordinationObserverCoverage != nil {
			obj(result["coverage"])["observers"] = coordinationObserverCoverage()
		} else {
			obj(result["coverage"])["observers"] = []any{}
		}
		return result, nil
	}
	code, _, _ := strings.Cut(err.Error(), ":")
	next := object{"op": nil, "hint": "Use local ARC management to restore source authorization or journal disk capacity; preserve coordination/events for recovery"}
	switch code {
	case "COORDINATION_RATE_LIMIT":
		next = object{"via": "query", "op": "events", "args": request.args, "hint": "Wait one second, then retry with your saved cursor and filters"}
	case "INVALID_ARGUMENT", "RESOURCE_UNKNOWN", "RESOURCE_AMBIGUOUS":
		next = object{"via": "query", "op": "guide", "args": object{"op": "events"}, "hint": "Use the current events schema and a canonical resource key"}
	}
	return object{"state": "failed", "error": object{"code": code, "message": err.Error()}, "next": next}, nil
}

func coordinationDesktopRequest(op string, handler operationHandler) managementHandler {
	return func(ctx context.Context, service *service, body object, _ []string) (any, error) {
		if _, _, _, err := managementResolve("coordination."+op, object{"body": body}); err != nil {
			return nil, err
		}
		source := requestSource{local: true, origin: object{"authType": "local", "ingressId": "local-cli", "sourceId": "local-cli"}, policy: "all"}
		if localSourceOrigin != nil {
			resolved, err := localSourceOrigin(ctx)
			if err != nil {
				return nil, err
			}
			source = resolved
		}
		ctx = withOrigin(ctx, source.origin)
		value, err := handler(ctx, operationRequest{name: op, args: body, source: source, service: service})
		if result := obj(value); result != nil {
			value = clone(result)
		}
		return value, err
	}
}

func coordinationDesktopResources(context.Context, *service, object, []string) (any, error) {
	resources := []object{{"key": "app:installed", "label": "ARC"}}
	cached, err := cachedLoad(filepath.Join(root(), "coordination/projects.json"))
	if err != nil {
		return object{"resources": resources, "observedAt": nil, "coverage": "unavailable"}, nil
	}
	projects := arr(field(cached, "projects"))
	for _, project := range projects[:min(32, len(projects))] {
		projectID := text(project, "id")
		if key, err := coordinationResource("project:" + projectID + "/main"); err == nil {
			resources = append(resources, object{"key": key, "label": projectID})
		}
	}
	return object{"resources": resources, "observedAt": field(cached, "observedAt"), "coverage": "cached"}, nil
}

func init() {
	onAuthenticatedControl = append(onAuthenticatedControl, observeAuthenticatedCoordination)
	registerOwnedErrorClassifier(coordinationErrorCode, func(code, message string, parsed object) object {
		if parsed != nil {
			return parsed
		}
		return object{"code": code, "message": message}
	})
	readCoordinationSource = func(_ context.Context, origin object) (object, error) {
		return readSourceAuthority(text(origin, "sourceId"))
	}
	coordinationRevokedSources = revokedCoordinationSources
	coordinationTaskOrigin = func(thread string) object { return obj(taskSourceOrigin(thread, nil)) }
	taskTrackingDecorateSource = func(origin object) {
		if sources, err := coordinationSourceAuthorities(); err == nil {
			decorateSourceLabels(origin, sources)
		}
	}
	registerOperation("events", coordinationEventQuery, nil)
	registerRoute("POST", "coordination/events", coordinationDesktopRequest("events", coordinationEventQuery))
	registerRoute("GET", "coordination/resources", coordinationDesktopResources)
	registerManagementCatalog(func(result object) {
		ops := arr(result["operations"])
		for _, op := range []string{"events", "board", "notice_post", "notice_update", "notice_close", "blocker_open", "blocker_clear", "ax_list"} {
			spec := operation(op)
			ops = append(ops, object{"name": "coordination." + op, "method": "POST", "route": "coordination/" + op, "localOnly": true, "description": spec["description"],
				"inputSchema": object{"type": "object", "required": []any{"body"}, "properties": object{"body": spec["inputSchema"]}, "additionalProperties": false}})
		}
		ops = append(ops, object{"name": "coordination.resources", "method": "GET", "route": "coordination/resources", "localOnly": true,
			"description": "Read cached registered project identities without discovery or upstream requests.",
			"inputSchema": object{"type": "object", "properties": object{}, "additionalProperties": false}})
		result["operations"] = ops
	})
}

func observeAuthenticatedCoordination(ctx context.Context, source requestSource) {
	reader, err := coordinationReadAuthority(ctx, source.local)
	if err == nil {
		err = bulletinAuthenticatedActivity(ctx, reader)
	}
	if err != nil {
		coordinationGap("bulletin-activity", "activity-unavailable")
	}
}

func coordinationErrorCode(message string) string {
	code, _, _ := strings.Cut(message, ":")
	switch {
	case strings.HasPrefix(code, "COORDINATION_"), strings.HasPrefix(code, "AX_"), strings.HasPrefix(code, "MESSAGES_"),
		strings.HasPrefix(code, "MESSAGE_"), strings.HasPrefix(code, "NEGOTIATION_"), code == "COVERAGE_GAP",
		code == "RESOURCE_UNKNOWN", code == "RESOURCE_AMBIGUOUS", code == "MAINTAINER_MODE_REQUIRED", code == "SOURCE_REQUIRED", code == "SESSION_NOT_FOUND":
		return code
	}
	return ""
}
