package core

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
)

type srcConversationStore struct {
	Containers    map[string]object `json:"containers"`
	Conversations []object          `json:"conversations"`
	Bindings      map[string]object `json:"bindings"`
}

type srcObservation struct {
	current          object
	activeAt, seenAt int64
	open             bool
}

var srcState struct {
	sync.Mutex
	path    string
	store   srcConversationStore
	live    map[string]srcObservation
	savedAt int64
	dirty   bool
}
var srcMutations sync.Mutex

var srcVerifiedTargets func([]string) ([]string, error)
var srcVerifiedTarget func(source, target string) (bool, error)
var srcInheritedTarget func(source, task string) (string, error)

func (s srcConversationStore) wireValue() object {
	return object{"containers": s.Containers, "conversations": s.Conversations, "bindings": s.Bindings}
}

func srcErrorCode(message string) string {
	code, _, _ := strings.Cut(message, ":")
	if !strings.HasPrefix(code, "SRC_") {
		return ""
	}
	for _, character := range []byte(code) {
		if !(character >= 'A' && character <= 'Z' || character == '_') {
			return ""
		}
	}
	return code
}

func changeSRC[T any](edit func(*srcConversationStore, *map[string]srcObservation) (T, error), durable bool) (T, error) {
	srcState.Lock()
	defer srcState.Unlock()
	var empty T
	path := filepath.Join(root(), "src-conversations.json")
	if srcState.path != path {
		store := srcConversationStore{Containers: map[string]object{}, Conversations: []object{}, Bindings: map[string]object{}}
		data, err := load(path)
		if err == nil {
			store = srcConversationStore{}
			if err := unmarshalJSON([]byte(wire(data)), &store); err != nil || store.Containers == nil || store.Conversations == nil || store.Bindings == nil {
				return empty, errors.New("SRC_STORE_INVALID")
			}
			for _, row := range store.Containers {
				_, id := row["storeId"].(string)
				_, safari := row["safariUserAgent"].(bool)
				_, status := row["status"].(string)
				if !id || !safari || !status {
					return empty, errors.New("SRC_STORE_INVALID")
				}
				for _, key := range []string{"reason", "hint", "detectedAccountId"} {
					if row[key] == nil {
						row[key] = nil
					} else if _, ok := row[key].(string); !ok {
						return empty, errors.New("SRC_STORE_INVALID")
					}
				}
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return empty, err
		}
		srcState.path, srcState.store, srcState.live, srcState.savedAt, srcState.dirty = path, store, map[string]srcObservation{}, 0, false
	}
	previous := srcState.store
	var next srcConversationStore
	if err := unmarshalJSON([]byte(wire(previous.wireValue())), &next); err != nil {
		return empty, err
	}
	live := maps.Clone(srcState.live)
	result, err := edit(&next, &live)
	if err != nil {
		return empty, err
	}
	at := time.Now().Unix()
	transition := len(live) != len(srcState.live)
	for id, observation := range live {
		old, found := srcState.live[id]
		if !found || !reflect.DeepEqual(old.current, observation.current) {
			transition = true
			break
		}
	}
	changed := !reflect.DeepEqual(previous, next)
	identityChange := !reflect.DeepEqual(next.Containers, previous.Containers) ||
		!reflect.DeepEqual(next.Bindings, previous.Bindings) || len(next.Conversations) != len(previous.Conversations)
	if (changed || srcState.dirty) && (durable || identityChange || transition || at-srcState.savedAt >= 30) {
		if err := save(path, next.wireValue()); err != nil {
			return empty, err
		}
		srcState.savedAt, srcState.dirty = at, false
	} else {
		srcState.dirty = srcState.dirty || changed
	}
	srcState.store, srcState.live = next, live
	return result, nil
}

func readSRCAccount(reference string) (object, error) {
	account, err := resolveAccount(reference)
	if err != nil {
		return nil, err
	}
	if account["removedAt"] != nil {
		return nil, errors.New("SRC_ACCOUNT_REMOVED: Select an active source account")
	}
	if len(arr(account["sources"])) == 0 {
		return nil, errors.New("SRC_ACCOUNT_REQUIRED: Select a source account")
	}
	return account, nil
}

func srcCallingAccount(ctx context.Context) (string, error) {
	origin := currentOrigin(ctx)
	if origin == nil || origin["authType"] == "local" {
		return "", nil
	}
	account, err := resolveAccount(text(origin, "accountId"))
	return text(account, "id"), err
}

func scopedSRCAccount(ctx context.Context, reference string) (object, error) {
	account, err := readSRCAccount(reference)
	if err != nil {
		return nil, err
	}
	caller, err := srcCallingAccount(ctx)
	if err != nil {
		return nil, err
	}
	if caller != "" && account["id"] != caller {
		return nil, errors.New("SRC_ACCOUNT_SCOPE: Use the calling source account")
	}
	return account, nil
}

func srcPlatformSupportsAccount(account object) bool {
	return srcPlatformSupported() && account["provider"] == "anthropic"
}

func ensureSRCContainer(store *srcConversationStore, account string) object {
	container := store.Containers[account]
	if container == nil {
		container = object{"storeId": id(), "safariUserAgent": false, "status": "not-imported", "reason": nil, "hint": nil, "detectedAccountId": nil}
		store.Containers[account] = container
	}
	return container
}

func upsertSRCReference(store *srcConversationStore, account string, reference object, basis, at string, active bool) {
	if canonical := resolveSRCReference(store.Conversations, account, text(reference, "id")); canonical != nil {
		reference = canonical
	}
	for _, row := range store.Conversations {
		if row["accountId"] == account && row["kind"] == reference["kind"] && row["id"] == reference["id"] {
			row["lastSeenAt"] = at
			if active {
				row["lastActiveAt"] = at
			}
			return
		}
	}
	row := maps.Clone(reference)
	row["accountId"], row["firstSeenAt"], row["lastSeenAt"] = account, at, at
	row["lastActiveAt"], row["basis"], row["aliases"] = nil, basis, []any{}
	if active {
		row["lastActiveAt"] = at
	}
	store.Conversations = append(store.Conversations, row)
}

func applySRCStatus(container, row object) {
	status := text(row, "status")
	state := srcImportState{status: status}
	switch status {
	case "unsupported", "not-imported", "signed-in", "expired", "signed-in-pending":
	case "importing":
		state = srcImporting()
	case "import-mismatch":
		state = srcImportMismatch(text(row, "detectedAccountId"))
	case "import-unverified":
		state = srcImportUnverified()
	case "import-blocked":
		state = srcImportBlocked(text(row, "reason"))
	default:
		return
	}
	maps.Copy(container, state.fields())
}

func observeSRCContainers(body object) (object, error) {
	return changeSRC(func(store *srcConversationStore, live *map[string]srcObservation) (object, error) {
		at, observed := now(), time.Now().Unix()
		next := map[string]srcObservation{}
		entries := decodedTaskList(body["containers"])
		for _, value := range entries {
			row := obj(value)
			account := text(row, "accountId")
			container := store.Containers[account]
			if container == nil || row["storeId"] != container["storeId"] {
				continue
			}
			applySRCStatus(container, row)
			if row["open"] == false {
				continue
			}
			current := srcURLReference(text(row, "url"))
			active := int64(0)
			focused := row["active"] == true
			if focused {
				active = observed
			} else if prior := (*live)[account]; reflect.DeepEqual(prior.current, current) {
				active = prior.activeAt
			}
			if current != nil {
				upsertSRCReference(store, account, current, "observed", at, focused)
			}
			next[account] = srcObservation{current: current, activeAt: active, seenAt: observed, open: true}
		}
		for account, container := range store.Containers {
			if container["status"] == "importing" || container["status"] == "signed-in-pending" {
				if !slices.ContainsFunc(entries, func(row any) bool {
					return field(row, "accountId") == account && field(row, "storeId") == container["storeId"]
				}) {
					applySRCStatus(container, srcImportBlocked("import-interrupted").fields())
				}
			}
		}
		*live = next
		return object{"accepted": true}, nil
	}, body["flush"] == true)
}

func taskSRCReference(agent, task string) (object, error) {
	return changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (object, error) {
		return maps.Clone(store.Bindings[agent+":"+task]), nil
	}, false)
}

func publishSRCVerifiedTarget(account, target string, confirmedAt *string, tasks [][2]string) error {
	reference := srcNotifyReference(target)
	if reference == nil {
		return nil
	}
	_, err := changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (bool, error) {
		if confirmedAt != nil {
			store.Conversations = verifiedSRCReference(store.Conversations, store.Bindings, account, reference, *confirmedAt)
		}
		upsertSRCReference(store, account, reference, "notify-target", now(), false)
		for _, identifiers := range tasks {
			agent, task := identifiers[0], identifiers[1]
			if store.Bindings[agent+":"+task]["basis"] != "manual" {
				bindSRCReference(store, account, agent, task, reference, "notify-target")
			}
		}
		return true, nil
	}, true)
	return err
}

func correlatedSRC(current object, open bool, seenAt, activeAt, at int64) object {
	seenAge, activeAge := at-seenAt, at-activeAt
	if current["kind"] == "chat" && open && seenAge >= 0 && seenAge <= 2 && activeAge >= 0 && activeAge <= srcCorrelationSeconds {
		return maps.Clone(current)
	}
	return nil
}

func bindSRCReference(store *srcConversationStore, account, agent, task string, reference object, basis string) object {
	key := agent + ":" + task
	delete(store.Bindings, key)
	if reference == nil {
		return nil
	}
	if canonical := resolveSRCReference(store.Conversations, account, text(reference, "id")); canonical != nil {
		reference = canonical
	}
	row := object{"kind": reference["kind"], "id": reference["id"], "url": reference["url"], "accountId": account, "basis": basis}
	store.Bindings[key] = row
	return row
}

func captureSRCReference(ctx context.Context, s *service, args object) (object, error) {
	origin := currentOrigin(ctx)
	if origin["accountId"] == nil {
		return nil, nil
	}
	account, err := scopedSRCAccount(ctx, text(origin, "accountId"))
	if err != nil || account["provider"] != "anthropic" {
		return nil, err
	}
	accountID, source := text(account, "id"), text(origin, "sourceId")
	var inherited string
	if _, supplied := args["notify"]; !supplied && text(args, "threadId") != "" && srcInheritedTarget != nil {
		inherited, err = srcInheritedTarget(source, text(args, "threadId"))
		if err != nil {
			return nil, err
		}
	}
	target, supplied := field(args["notify"], "target").(string)
	if !supplied && inherited != "" {
		target, supplied = inherited, true
	}
	var deterministic object
	if supplied && srcVerifiedTarget != nil {
		if verified, _ := srcVerifiedTarget(source, target); verified {
			deterministic = srcNotifyReference(target)
		}
	}
	if deterministic == nil && !supplied {
		wait, cancel := context.WithTimeout(ctx, time.Second)
		snapshot, err := s.managementRequest(wait, "src-containers/status", http.MethodGet, object{})
		cancel()
		if err != nil {
			return nil, nil
		}
		if _, err := observeSRCContainers(obj(snapshot)); err != nil {
			return nil, err
		}
	}
	return changeSRC(func(store *srcConversationStore, live *map[string]srcObservation) (object, error) {
		reference, basis := deterministic, "notify-target"
		if reference == nil {
			if supplied {
				return nil, nil
			}
			obs := (*live)[accountID]
			reference, basis = correlatedSRC(obs.current, obs.open, obs.seenAt, obs.activeAt, time.Now().Unix()), "correlated"
		}
		if reference == nil {
			return nil, nil
		}
		upsertSRCReference(store, accountID, reference, basis, now(), false)
		canonical := resolveSRCReference(store.Conversations, accountID, text(reference, "id"))
		if canonical != nil {
			reference = canonical
		}
		ref := selectFields(reference, "kind", "id", "url")
		ref["accountId"], ref["basis"] = accountID, basis
		return ref, nil
	}, true)
}

func recordSRCReference(receipt object) error {
	ref, present := receipt["srcConversation"]
	account := field(receipt["origin"], "accountId")
	if !present || account == nil {
		return nil
	}
	resolved, err := resolveAccount(str(account))
	if err != nil {
		return err
	}
	agent, supplied := receipt["agent"].(string)
	if !supplied {
		agent = "codex"
	}
	task, supplied := receipt["taskId"].(string)
	if !supplied {
		task = text(receipt, "threadId")
	}
	_, err = changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (bool, error) {
		bindSRCReference(store, text(resolved, "id"), agent, task, obj(ref), text(ref, "basis"))
		return true, nil
	}, true)
	return err
}

func snapshotSRCAccount(account object, store *srcConversationStore, live map[string]srcObservation, caller string) object {
	id := text(account, "id")
	container := store.Containers[id]
	obs := live[id]
	if time.Now().Unix()-obs.seenAt > 2 {
		obs = srcObservation{}
	}
	conversations := []object{}
	for _, row := range store.Conversations {
		if row["accountId"] != id {
			continue
		}
		visible := clone(row)
		if arr(visible["aliases"]) == nil {
			visible["aliases"] = []any{}
		}
		refs := []object{}
		for _, key := range slices.Sorted(maps.Keys(store.Bindings)) {
			binding := store.Bindings[key]
			if binding["accountId"] == id && binding["kind"] == row["kind"] && binding["id"] == row["id"] {
				if agent, task, found := strings.Cut(key, ":"); found {
					refs = append(refs, object{"agent": agent, "id": task, "basis": binding["basis"]})
				}
			}
		}
		visible["taskRefs"] = refs
		conversations = append(conversations, visible)
	}
	status := "unsupported"
	if srcPlatformSupportsAccount(account) {
		status = "not-imported"
		if container != nil {
			status = text(container, "status")
		}
	}
	result := object{"accountId": id, "storeId": container["storeId"], "status": status, "reason": container["reason"],
		"hint": container["hint"], "detectedAccountId": container["detectedAccountId"], "safariUserAgent": container["safariUserAgent"] == true,
		"open": obs.open, "currentConversation": obs.current, "conversations": conversations}
	srcImportForCaller(result, caller)
	return result
}

func listSRCConversations(ctx context.Context, args object) (any, error) {
	caller, _ := srcCallingAccount(ctx)
	var accounts []any
	if id, supplied := args["accountId"].(string); supplied {
		account, err := readSRCAccount(id)
		if err != nil {
			return nil, err
		}
		accounts = []any{account}
	} else {
		var err error
		accounts, err = liveSourceAccounts()
		if err != nil {
			return nil, err
		}
	}
	type srcTarget struct {
		account   string
		reference object
	}
	targets := []srcTarget{}
	if srcVerifiedTargets != nil {
		for _, account := range accounts {
			sources := []string{}
			for _, source := range arr(field(account, "sources")) {
				if id, ok := source.(string); ok {
					sources = append(sources, id)
				}
			}
			rows, err := srcVerifiedTargets(sources)
			if err != nil {
				return nil, err
			}
			for _, target := range rows {
				if reference := srcNotifyReference(target); reference != nil {
					targets = append(targets, srcTarget{text(account, "id"), reference})
				}
			}
		}
	}
	return changeSRC(func(store *srcConversationStore, live *map[string]srcObservation) (object, error) {
		for _, target := range targets {
			upsertSRCReference(store, target.account, target.reference, "notify-target", now(), false)
		}
		result := make([]object, 0, len(accounts))
		for _, account := range accounts {
			result = append(result, snapshotSRCAccount(obj(account), store, *live, caller))
		}
		return object{"accounts": result, "correlationSeconds": srcCorrelationSeconds}, nil
	}, true)
}

func bindSRCTask(args, account object) (object, error) {
	task, agent, id := text(args, "taskId"), text(args, "agent"), text(account, "id")
	if readNativeDispatchHistory == nil {
		return nil, errors.New(PortPending)
	}
	records, err := readNativeDispatchHistory(task)
	if err != nil {
		return nil, err
	}
	var owner object
	for _, record := range slices.Backward(records) {
		if record["agent"] == agent {
			owner = record
			break
		}
	}
	if owner == nil {
		return nil, errors.New("SRC_TASK_NOT_FOUND: Use a task dispatched by this source account")
	}
	ownerAccount, err := resolveAccount(text(owner["origin"], "accountId"))
	if err != nil {
		return nil, err
	}
	if ownerAccount["id"] != id {
		return nil, errors.New("SRC_TASK_SCOPE: Task belongs to another source account")
	}
	return changeSRC(func(s *srcConversationStore, _ *map[string]srcObservation) (object, error) {
		var reference object
		if args["conversationId"] != nil {
			reference = resolveSRCReference(s.Conversations, id, text(args, "conversationId"))
			if reference == nil {
				return nil, errors.New("SRC_CONVERSATION_NOT_FOUND")
			}
		}
		return object{"conversation": bindSRCReference(s, id, agent, task, reference, "manual")}, nil
	}, true)
}

func clearSRCLogin(ctx context.Context, s *service, id string) (any, error) {
	container, err := changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (object, error) {
		return maps.Clone(store.Containers[id]), nil
	}, false)
	if err != nil {
		return nil, err
	}
	if container != nil {
		if _, err := s.managementRequest(ctx, "src-containers/clear", http.MethodPost, object{"accountId": id, "storeId": container["storeId"]}); err != nil {
			return nil, err
		}
		if _, err := changeSRC(func(store *srcConversationStore, live *map[string]srcObservation) (bool, error) {
			delete(store.Containers, id)
			delete(*live, id)
			return true, nil
		}, true); err != nil {
			return nil, err
		}
	}
	return object{"accountId": id, "status": "not-imported"}, nil
}

func openSRCLogin(ctx context.Context, s *service, name string, args, account object) (any, error) {
	id := text(account, "id")
	target := "https://claude.ai/new"
	if raw, supplied := args["url"].(string); supplied {
		target = srcOpenURL(raw)
		if target == "" {
			return nil, errors.New("SRC_URL_INVALID: Use https://claude.ai/new or a conversation URL without query or fragment")
		}
	} else if cid, supplied := args["conversationId"].(string); supplied {
		var err error
		target, err = changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (string, error) {
			ref := resolveSRCReference(store.Conversations, id, cid)
			if ref == nil {
				return "", errors.New("SRC_CONVERSATION_NOT_FOUND")
			}
			return text(ref, "url"), nil
		}, false)
		if err != nil {
			return nil, err
		}
	}
	container, err := changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (object, error) {
		container := ensureSRCContainer(store, id)
		if enabled, supplied := args["safariUserAgent"].(bool); supplied {
			container["safariUserAgent"] = enabled
		}
		return maps.Clone(container), nil
	}, true)
	if err != nil {
		return nil, err
	}
	known := []srcOrgAccount{}
	route := "src-containers/open"
	if name == "src_login_import" {
		route = "src-containers/import"
		accounts, err := liveSourceAccounts()
		if err != nil {
			return nil, err
		}
		profiles, err := claudeAccountObservations()
		if err != nil {
			return nil, err
		}
		known = srcOrgAccounts(accounts, profiles)
	}
	body := object{"accountId": id, "storeId": container["storeId"], "safariUserAgent": container["safariUserAgent"],
		"title": "Claude · " + text(account, "alias"), "url": target, "profile": args["profile"],
		"allowUnverified": args["allowUnverified"] == true, "knownAccounts": known}
	result, err := s.managementRequest(ctx, route, http.MethodPost, body)
	if err != nil || name != "src_login_import" {
		return result, err
	}
	if _, err := changeSRC(func(store *srcConversationStore, _ *map[string]srcObservation) (bool, error) {
		if container := store.Containers[id]; container != nil {
			applySRCStatus(container, obj(result))
		}
		return true, nil
	}, true); err != nil {
		return nil, err
	}
	caller, err := srcCallingAccount(ctx)
	if err != nil {
		return nil, err
	}
	reply := maps.Clone(obj(result))
	srcImportForCaller(reply, caller)
	return reply, nil
}

func srcConversationOperation(ctx context.Context, s *service, name string, args object) (any, error) {
	args = maps.Clone(args)
	delete(args, "requestId")
	spec := operation(name)
	if invalid := checkSchema("op", name, name, spec["inputSchema"], args); invalid != nil {
		return nil, errors.New(wire(invalid))
	}
	switch name {
	case "src_chrome_profiles":
		if !srcPlatformSupported() {
			return object{"status": "unsupported", "profiles": []any{}}, nil
		}
		return s.managementRequest(ctx, "src-containers/profiles", http.MethodGet, object{})
	case "src_conversations":
		return listSRCConversations(ctx, args)
	}
	srcMutations.Lock()
	defer srcMutations.Unlock()
	account, err := scopedSRCAccount(ctx, text(args, "accountId"))
	if err != nil {
		return nil, err
	}
	if name == "src_conversation_bind" {
		return bindSRCTask(args, account)
	}
	id := text(account, "id")
	if !srcPlatformSupportsAccount(account) {
		return object{"accountId": id, "status": "unsupported"}, nil
	}
	if name == "src_login_clear" {
		return clearSRCLogin(ctx, s, id)
	}
	return openSRCLogin(ctx, s, name, args, account)
}

func init() {
	registerOwnedErrorClassifier(srcErrorCode, func(code, message string, _ object) object {
		return object{"code": code, "message": message, "retryable": false}
	})
	taskListSourceReference = func(agent, thread string) any {
		result, _ := taskSRCReference(agent, thread)
		return result
	}
	registerRoute(http.MethodPost, "src-conversations/observe", func(_ context.Context, _ *service, body object, _ []string) (any, error) {
		return observeSRCContainers(body)
	})
	for _, route := range []struct {
		method, name, operation string
	}{
		{http.MethodPost, "query", "src_conversations"},
		{http.MethodGet, "profiles", "src_chrome_profiles"},
		{http.MethodPost, "open", "src_conversation_open"},
		{http.MethodPost, "import", "src_login_import"},
		{http.MethodPost, "clear", "src_login_clear"},
		{http.MethodPost, "bind", "src_conversation_bind"},
	} {
		registerOperation(route.operation, func(ctx context.Context, request operationRequest) (any, error) {
			return srcConversationOperation(ctx, request.service, route.operation, request.args)
		}, nil)
		registerRoute(route.method, "src-conversations/"+route.name, func(ctx context.Context, s *service, args object, _ []string) (any, error) {
			return srcConversationOperation(ctx, s, route.operation, args)
		})
	}
}
