package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var axResident struct {
	sync.Mutex
	path  string
	stamp *fileStamp
	store *axStore
}

var coordinationTaskOrigin func(thread string) object

func withAXStore[T any](work func(*axStore) (T, error)) (T, error) {
	var zero T
	axResident.Lock()
	defer axResident.Unlock()
	dir := filepath.Join(root(), "coordination/ax")
	path := filepath.Join(dir, "state.json")
	stamp, err := readStamp(path)
	if err != nil {
		return zero, err
	}
	if axResident.store == nil || axResident.path != path || !stampSame(stamp, axResident.stamp) {
		axResident.store = nil
		store, err := openAXStore(dir)
		if err != nil {
			return zero, err
		}
		axResident.path, axResident.store = path, store
	}
	result, err := work(axResident.store)
	if err == nil {
		axResident.stamp, err = readStamp(path)
	}
	if err != nil {
		// Reload the last durable snapshot after a rejected or failed mutation.
		axResident.store = nil
	}
	return result, err
}

func axActorIdentity(actor object) object {
	if actor["type"] == "source" {
		return selectFields(actor, "type", "sourceId")
	}
	return actor
}

func axActor(reader coordinationReader) object {
	actor := object{"type": reader.principal.Type}
	if reader.principal.SourceID != "" {
		actor["sourceId"] = reader.principal.SourceID
	}
	if reader.principal.AccountID != nil {
		actor["accountId"] = *reader.principal.AccountID
	}
	return actor
}

func axRequestDigest(op string, args, actor object) string {
	values := maps.Clone(args)
	if op == "ax_report" && values["kind"] == nil {
		values["kind"] = "friction"
	}
	for _, key := range []string{"resources", "receiptIds", "requestIds", "threadIds", "evidenceIds"} {
		if list := arr(values[key]); list != nil {
			list = slices.Clone(list)
			slices.SortFunc(list, func(a, b any) int { return strings.Compare(wire(a), wire(b)) })
			values[key] = list
		}
	}
	return hash([]byte(wire([]any{op, values, axActorIdentity(actor)})))
}

func axValidate(op string, args object) error {
	if invalid := checkSchema("op", op, op, operation(op)["inputSchema"], args); invalid != nil {
		return errors.New(wire(invalid))
	}
	if _, ok := args["severity"].(string); op == "ax_report" && args["kind"] != "idea" && !ok {
		return errors.New("INVALID_ARGUMENT: friction requires severity")
	}
	if op == "ax_issue_draft" {
		return nil
	}
	for _, key := range []string{"receiptIds", "requestIds", "threadIds", "evidenceIds"} {
		for _, ref := range axStrings(args[key]) {
			if !coordinationIdentifier(ref) {
				return invalidCoordinationIdentifier()
			}
		}
	}
	for _, key := range axStrings(args["resources"]) {
		if _, err := coordinationResource(key); err != nil {
			return err
		}
		if coordinationLaneShorthand(key) != "" {
			return errors.New("INVALID_ARGUMENT: qualify lane resources with their registered project ID")
		}
	}
	return nil
}

func axFailure(err error, op string, args object) object {
	message := err.Error()
	var invalid object
	if decodeObject([]byte(message), &invalid) == nil && invalid["code"] == "INVALID_ARGUMENTS" {
		return object{"error": invalid}
	}
	code, _, _ := strings.Cut(message, ":")
	next := object{"op": nil, "hint": "Use local AX management to resolve authority or storage capacity. Export closed records with cli ax export --to <path>; preserve readable state and retry the original requestId."}
	switch code {
	case "AX_REVISION_CONFLICT", "AX_NOT_FOUND", "AX_MERGED", "AX_STATE_CONFLICT":
		next = object{"via": "query", "op": "ax_list", "args": object{"id": args["id"]}, "hint": "Read the entry and use its current revision"}
	case "AX_FORBIDDEN":
		local := maps.Clone(args)
		delete(local, "requestId")
		next = object{"via": "cli", "op": nil, "command": "arc cli control " + op + " --stdin", "stdin": local,
			"hint": fmt.Sprintf("Imported entries require local authority. Read the current revision with arc cli control ax_list --stdin locally, then run arc cli control %s --stdin with id, expectedRevision, action and reason. Omit the source requestId; local authority must reserve its own request.", op)}
	case "AX_CURSOR_EXPIRED":
		reset := maps.Clone(args)
		delete(reset, "cursor")
		next = object{"via": "query", "op": "ax_list", "args": reset, "hint": "Restart pagination; the AX snapshot or authority changed"}
	case "MAINTAINER_MODE_REQUIRED":
		next = object{"op": nil, "hint": `Ask the user to enable Maintainer mode under Settings > Experimental, or locally run cli config set --stdin with {"maintainerMode":true}. Authenticated local authority may also triage/import without enabling the mode.`}
	case "INVALID_ARGUMENT":
		next = object{"via": "query", "op": "guide", "args": object{"op": op}, "hint": "Use the current AX schema; include metadata only"}
	case "COORDINATION_RATE_LIMIT":
		next = object{"via": "act", "op": op, "args": args, "hint": "Wait one minute; retry with the same requestId"}
	}
	result := object{"state": "failed", "error": object{"code": code, "message": message}, "next": next}
	if code == "AX_REVISION_CONFLICT" {
		_, rest, _ := strings.Cut(message, "current revision ")
		number, _, _ := strings.Cut(rest, ";")
		result["currentRevision"] = nil
		if revision, err := strconv.ParseUint(number, 10, 64); err == nil {
			result["currentRevision"] = revision
		}
	}
	return result
}

func axReconcile() error {
	pending, err := withAXStore(func(store *axStore) ([]coordinationEventInput, error) {
		pending := []coordinationEventInput{}
		for _, key := range slices.Sorted(maps.Keys(store.data.Entries)) {
			current := store.data.Entries[key].Pending
			pending = append(pending, current[:min(64-len(pending), len(current))]...)
			if len(pending) == 64 {
				break
			}
		}
		return pending, nil
	})
	if err != nil {
		return err
	}
	for _, input := range pending {
		if _, err := emitCoordinationEvent(input); err != nil {
			return err
		}
		_, err := withAXStore(func(store *axStore) (struct{}, error) {
			for _, entry := range store.data.Entries {
				entry.Pending = slices.DeleteFunc(entry.Pending, func(p coordinationEventInput) bool { return p.TransitionID == input.TransitionID })
			}
			return struct{}{}, store.save()
		})
		if err != nil {
			return err
		}
	}
	_, err = withAXStore(func(store *axStore) (struct{}, error) {
		for _, entry := range store.data.Entries {
			if len(entry.Pending) > 0 {
				return struct{}{}, errors.New("COORDINATION_PROJECTION_PENDING: read ax_list to continue bounded reconciliation")
			}
		}
		return struct{}{}, nil
	})
	return err
}

func axEvidence(args, actor object) []object {
	refs := []object{}
	for _, key := range []string{"receiptIds", "requestIds", "threadIds", "evidenceIds"} {
		for _, reference := range axStrings(args[key]) {
			local := actor["type"] == "local-authority"
			fact := object{"kind": "receipt", "id": reference, "availability": "unavailable", "observedAt": now()}
			if key == "threadIds" {
				fact["kind"] = "thread"
				if coordinationTaskOrigin != nil {
					if origin := coordinationTaskOrigin(reference); origin != nil && (local || origin["sourceId"] == actor["sourceId"]) {
						fact["availability"] = "available"
					}
				}
			} else if path, err := coreReceiptStore().path(reference); err == nil {
				if info, err := os.Stat(path); err == nil && info.Size() <= 1024*1024 {
					if receipt, err := load(path); err == nil && (local || field(field(receipt, "origin"), "sourceId") == actor["sourceId"]) {
						fact["availability"] = "available"
						fact["state"] = field(receipt, "state")
						if op := text(receipt, "operation"); len(op) <= 64 {
							fact["operation"] = op
						}
					}
				}
			}
			refs = append(refs, fact)
		}
	}
	var build any
	if value, err := processBuildID(); err == nil {
		build = value
	}
	return append(refs, object{"kind": "observation", "observedAt": now(), "coreBuild": build, "desktopBuild": nil})
}

func axRequireMaintainer(op string, actor object) error {
	if (op == "ax_triage" || op == "import") && actor["type"] != "local-authority" && readPreferences()["maintainer-mode"] != "on" {
		return errors.New("MAINTAINER_MODE_REQUIRED: AX triage/import requires Maintainer mode or authenticated local authority")
	}
	return nil
}

func axCall(ctx context.Context, request operationRequest) (any, error) {
	request.args = clone(request.args)
	result, err := axExecute(ctx, request)
	if err == nil {
		return result, err
	}
	return axFailure(err, request.name, request.args), nil
}

func axExecute(ctx context.Context, request operationRequest) (object, error) {
	op, args := request.name, request.args
	if err := axValidate(op, args); err != nil {
		return nil, err
	}
	reader, err := coordinationReadAuthority(ctx, request.source.local)
	if err != nil {
		return nil, err
	}
	actor := axActor(reader)
	if err := axRequireMaintainer(op, actor); err != nil {
		return nil, err
	}
	if op == "ax_issue_draft" {
		return axIssueDraft(args), nil
	}
	projection := axReconcile()
	if op == "ax_list" {
		result, err := withAXStore(func(store *axStore) (object, error) {
			return store.list(args, actor, reader.revision, time.Now().UnixMilli())
		})
		if err == nil {
			result["projectionPending"] = projection != nil
		}
		return result, err
	}
	if args["requestId"] == nil {
		args["requestId"] = id()
	}
	requestID := text(args, "requestId")
	unlock := lockReceipt(requestID)
	defer unlock()
	digest := axRequestDigest(op, args, actor)
	session := text(request.service.metadata, "instance")
	store := coreReceiptStore()
	receipt, err := store.replay(ctx, requestID, digest, session)
	if err != nil {
		return nil, err
	}
	if receipt != nil {
		switch readReceiptState(text(receipt, "state"), true) {
		case receiptCompleted, receiptFailed:
			result := clone(obj(receipt["result"]))
			if result == nil {
				result = object{}
			}
			result["receipt"] = receipt
			return result, nil
		default:
			return publicReceipt(receipt), nil
		}
	}
	receipt = object{"requestId": requestID, "origin": currentOrigin(ctx), "backendSession": session, "digest": digest, "operation": op, "state": "reserved", "createdAt": now()}
	if err := store.reserve(ctx, receipt); err != nil {
		return nil, err
	}
	owner, err := store.begin(ctx, receipt)
	if err != nil {
		return nil, err
	}
	defer owner.close()
	facts := axEvidence(args, actor)
	result, err := withAXStore(func(store *axStore) (object, error) {
		return store.mutate(op, args, actor, facts, time.Now().UnixMilli())
	})
	if err == nil {
		result["projectionPending"] = axReconcile() != nil
		receipt["state"] = "completed"
	} else {
		if strings.HasPrefix(err.Error(), "COORDINATION_") {
			return nil, err
		}
		receipt["state"] = "failed"
		result = axFailure(err, op, args)
	}
	saved := maps.Clone(result)
	if entry := maps.Clone(obj(saved["entry"])); entry != nil {
		for _, key := range []string{"reproductionHints", "evidence", "history"} {
			delete(entry, key)
		}
		saved["entry"] = entry
	}
	receipt["result"] = saved
	if err := store.checkpoint(ctx, receipt); err != nil {
		return nil, err
	}
	result["receipt"] = receipt
	return result, nil
}

func coordinationAXAttention(reader coordinationReader) ([]object, error) {
	actor := axActor(reader)
	triage := reader.principal.Type == "local-authority" || readPreferences()["maintainer-mode"] == "on"
	return withAXStore(func(store *axStore) ([]object, error) { return store.attention(actor, triage), nil })
}

func axLocal(action string, body object) (any, error) {
	var result object
	var err error
	switch action {
	case "import":
		path := text(body, "from")
		if !filepath.IsAbs(path) {
			return nil, errors.New("INVALID_ARGUMENT: import requires an absolute local path")
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Size() > 256*1024 {
			return nil, errors.New("COORDINATION_CAPACITY: import is limited to 256 KiB")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		result, err = withAXStore(func(store *axStore) (object, error) { return store.importQueue(string(data), time.Now().UnixMilli()) })
		if err != nil {
			return nil, err
		}
	case "export":
		path := text(body, "to")
		if !filepath.IsAbs(path) || belowPath(path, root()) {
			return nil, errors.New("INVALID_ARGUMENT: export to a new absolute path outside ARC state")
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil {
			return nil, errors.New("INVALID_ARGUMENT: export parent directory must exist")
		}
		state, err := filepath.EvalSymlinks(root())
		if err != nil {
			return nil, errors.New("COORDINATION_STORAGE: cannot resolve ARC state directory")
		}
		if belowPath(parent, state) {
			return nil, errors.New("INVALID_ARGUMENT: export outside ARC state")
		}
		result, err = withAXStore(func(store *axStore) (object, error) { return store.export(filepath.Join(parent, filepath.Base(path))) })
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("INVALID_ARGUMENT: use cli ax import or export")
	}
	result["projectionPending"] = axReconcile() != nil
	return result, err
}

func init() {
	coordinationEventProjections = append(coordinationEventProjections, axFromCoordinationEvent)
	registerOperationObserver(observeAXControlResult)
	for _, op := range []string{"ax_report", "ax_candidate", "ax_triage", "ax_list", "ax_issue_draft"} {
		registerOperation(op, axCall, nil)
	}
	registerRoute("POST", "coordination/ax_list", coordinationDesktopRequest("ax_list", axCall))
	for _, action := range []string{"import", "export"} {
		registerRoute("POST", "ax/"+action, func(_ context.Context, _ *service, body object, _ []string) (any, error) {
			return axLocal(action, body)
		})
	}
}

func observeAXFriction(kind, observation string, source *coordinationPrincipal, refs []coordinationEvidenceRef) (object, error) {
	if !coordinationIdentifier(observation) {
		return nil, invalidCoordinationIdentifier()
	}
	if len(refs) > 16 {
		return nil, errors.New("COORDINATION_CAPACITY: at most 16 candidate references")
	}
	for _, ref := range refs {
		if !coordinationIdentifier(ref.ID) {
			return nil, invalidCoordinationIdentifier()
		}
	}
	build, err := processBuildID()
	if err != nil {
		return nil, err
	}
	result, err := withAXStore(func(store *axStore) (object, error) {
		return store.candidate(kind, observation, source, refs, build, time.Now().UnixMilli())
	})
	if err == nil {
		_ = axReconcile()
	}
	return result, err
}
func axFromCoordinationEvent(input coordinationEventInput) error {
	var friction string
	switch input.Kind {
	case "receipt.stalled":
		friction = "receipt-stalled"
	case "notification.delivery-failed":
		friction = "delivery-failed"
	default:
		return nil
	}
	_, err := observeAXFriction(friction, input.TransitionID, input.Origin, input.EvidenceRefs)
	return err
}

func observeAXControlResult(ctx context.Context, request operationRequest, value any, err error) {
	if !slices.Contains([]string{"codex_read", "codex_resume", "codex_owner", "codex_send", "receipt"}, request.name) {
		return
	}
	const timeout = "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery"
	failed := err != nil && err.Error() == timeout
	for _, row := range []any{value, field(value, "result"), field(value, "lastResult")} {
		failed = failed || field(row, "error") == timeout || field(field(row, "error"), "message") == timeout
	}
	if !failed {
		return
	}
	origin := currentOrigin(ctx)
	if text(value, "operation") != "" && text(value, "requestId") != "" {
		if own, exists := obj(value)["origin"]; exists {
			origin = obj(own)
		}
	}
	source, _ := coordinationPrincipalFromOrigin(origin)
	observation := text(value, "requestId")
	if observation == "" {
		observation = text(request.args, "requestId")
	}
	var thread *string
	if value := text(request.args, "threadId"); value != "" {
		if _, err := uuid.Parse(value); err == nil {
			thread = &value
		}
	}
	refs := []coordinationEvidenceRef{}
	if observation != "" {
		refs = append(refs, coordinationEvidenceRef{"receipt", observation})
	} else {
		observation = hash([]byte(wire([]any{request.name, thread, source, time.Now().Unix() / 600})))
	}
	if thread != nil {
		refs = append(refs, coordinationEvidenceRef{"thread", *thread})
	}
	_, _ = observeAXFriction("owner-discovery-timeout", observation, source, refs)
}
