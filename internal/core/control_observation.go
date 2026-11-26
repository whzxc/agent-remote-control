package core

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"time"
)

func notificationNativeTransition(key turnKey, observation object, revision uint64) turnTransition {
	current := turnTransition{key: key}
	for _, id := range []struct {
		value any
		want  string
	}{
		{dispatchFirstString(observation["threadId"], observation["taskId"]), key.session},
		{observation["turnId"], key.turn},
		{observation["agent"], key.agent},
	} {
		if actual, ok := id.value.(string); ok && actual != id.want {
			return current
		}
	}
	if native, ok := restoreTurnTransition(observation["_turnLifecycle"]); ok {
		if native.key != key {
			return current
		}
		current = native
	} else {
		sequence, sequenced := uintValue(observation["nativeSequence"])
		current = current.advance(codexTerminalEvidence(key, text(observation, "recordedStatus"), sequence, sequenced))
	}
	state := turnUnavailable
	switch observation["state"] {
	case "running":
		state = turnActive
	case "interaction-required":
		state = turnAwaitingInteraction
	}
	return current.advance(turnEvidence{key: key, owner: turnOwner{revision, state}})
}

func nativeNotificationLifecycle(agent, thread, turn string, previous any, observation object) (any, string, string, any) {
	key := turnKey{agent, thread, turn}
	prior, ok := restoreTurnTransition(previous)
	if !ok || prior.key != key {
		prior = turnTransition{key: key}
	}
	revision := prior.owner.revision
	if revision != math.MaxUint64 {
		revision++
	}
	next := prior
	for _, evidence := range notificationNativeTransition(key, observation, revision).evidence() {
		next = next.advance(evidence)
	}
	if next.owner.state == prior.owner.state && next.lastLive.state == prior.lastLive.state && reflect.DeepEqual(next.terminals, prior.terminals) {
		next = prior
	}
	state, reason := next.wait()
	var conflict any
	if records := nativeTurnConflict(next); records != nil {
		conflict = records
	}
	return next.checkpoint(), string(state), reason, conflict
}

func nativeTurnConflict(turn turnTransition) object {
	if len(turn.terminals) == 0 {
		return nil
	}
	if _, confirmed := turn.terminal(); confirmed {
		return nil
	}
	return object{"threadId": turn.key.session, "turnId": turn.key.turn, "records": turn.checkpoint()["terminals"]}
}

func dispatchRecordTransition(row object) turnTransition {
	agent := nonemptyTaskText(text(row, "agent"), "codex")
	key := turnKey{agent, str(dispatchFirstString(row["threadId"], row["taskId"])), text(row, "turnId")}
	prior, ok := restoreTurnTransition(row["_turnLifecycle"])
	if !ok || prior.key != key {
		prior = turnTransition{key: key}.advance(codexTerminalEvidence(key, text(row["terminal"], "state"), 0, false))
	}
	return prior
}

func nativeDispatchLifecycle(row object, incoming any) (string, any) {
	prior := dispatchRecordTransition(row)
	if observed, ok := restoreTurnTransition(incoming); ok && observed.key == prior.key {
		prior = prior.observe(observed)
	}
	state, _ := prior.wait()
	return string(state), prior.checkpoint()
}

// The observation path reads native state without resuming a thread or acquiring
// its writer. Historical reconciliation can use an unattached turn snapshot.
func readCodexObservation(ctx context.Context, s *service, thread string, selected *string, historical bool, issueTokens bool) (object, error) {
	request := func(method string, params object) (any, error) {
		if historical {
			utility, err := s.codexUtility(ctx)
			if err != nil {
				return nil, err
			}
			return utility.call(ctx, method, params, 10*time.Second)
		}
		return requestCodexNative(ctx, s, method, params, 10*time.Second)
	}
	role := ""
	if historical {
		role = string(rpcConnector)
	}
	return readCodexObservationPages(ctx, s, thread, selected, issueTokens, role, request)
}

func readCodexObservationPages(ctx context.Context, s *service, thread string, selected *string, issueTokens bool, role string, request func(string, object) (any, error)) (object, error) {
	value, err := request("thread/read", object{"threadId": thread, "includeTurns": false})
	if err != nil {
		return nil, err
	}
	native := obj(field(value, "thread"))
	if native["id"] != thread {
		return nil, errors.New("native-thread-id-mismatch")
	}
	turns := []any{}
	var cursor any
	seen := map[string]bool{}
	for {
		page, err := request("thread/turns/list", object{"threadId": thread, "cursor": cursor, "limit": 100, "sortDirection": "desc", "itemsView": "full"})
		if err != nil {
			return nil, err
		}
		pageTurns := arr(field(page, "data"))
		if pageTurns == nil {
			return nil, errors.New("native-turns-missing")
		}
		turns = append(turns, pageTurns...)
		next := field(page, "nextCursor")
		if next == nil || selected == nil || slices.ContainsFunc(pageTurns, func(turn any) bool { return field(turn, "id") == *selected }) {
			break
		}
		key := wire(next)
		if seen[key] {
			return nil, errors.New("native-turn-cursor-repeated")
		}
		seen[key], cursor = true, next
	}
	slices.Reverse(turns)
	native["turns"] = turns
	if role != "" {
		native["runtimeSource"] = role
	}
	return hydrateCodexObservation(ctx, s, native, thread, selected, issueTokens)
}

func hydrateCodexObservation(ctx context.Context, s *service, native object, thread string, selected *string, issueTokens bool) (object, error) {
	if native["id"] != thread {
		return nil, errors.New("native-thread-id-mismatch")
	}
	turns := arr(native["turns"])
	if path := text(native, "path"); path != "" {
		s.codex.mu.Lock()
		if s.codex.historyPaths == nil {
			s.codex.historyPaths = map[string]string{}
		}
		if len(s.codex.historyPaths) >= 4096 {
			for key := range s.codex.historyPaths {
				delete(s.codex.historyPaths, key)
				break
			}
		}
		s.codex.historyPaths[thread] = path
		s.codex.mu.Unlock()
	}
	target := selected
	if target == nil && len(turns) > 0 {
		target = optionalProjectString(field(turns[len(turns)-1], "id"))
	}
	var history string
	if target != nil && slices.ContainsFunc(turns, func(turn any) bool {
		return field(turn, "id") == *target && slices.Contains([]string{"completed", "interrupted", "cancelled"}, text(turn, "status"))
	}) {
		_, home, err := codexInputs()
		if err == nil {
			history, _ = readNativeHistory(home, native)
		}
		reconcileNativeInterruption(native, target, history)
	}

	s.events.Lock()
	for _, turn := range turns {
		for _, item := range arr(field(turn, "items")) {
			part := obj(item)
			if part["type"] != "agentMessage" || part["status"] != nil {
				continue
			}
			for _, event := range slices.Backward(s.events.rows) {
				p := event.row["params"]
				completed := field(p, "item")
				if event.row["method"] == "item/completed" && field(p, "threadId") == thread && field(p, "turnId") == field(turn, "id") &&
					field(completed, "id") == part["id"] && field(completed, "text") == part["text"] {
					part["status"] = "completed"
					break
				}
			}
		}
	}
	s.events.Unlock()
	pending := s.events.pendingInteractions()
	pending = slices.DeleteFunc(pending, func(row object) bool { return field(row["params"], "threadId") != thread })
	for _, row := range pending {
		if err := notificationRoutingObserve("codex", thread, row); err != nil {
			return nil, err
		}
		if issueTokens {
			if err := issueRespondToken(text(currentOrigin(ctx), "ingressId"), row); err != nil {
				return nil, err
			}
		}
	}
	if err := observeExternalInputs(thread, turns, pending); err != nil {
		return nil, err
	}
	inputs, err := externalUserInputs(thread, nil)
	if err != nil {
		return nil, err
	}
	return object{"thread": native, "pending": pending, "externalUserInputs": inputs, "rollout": history}, nil
}

func projectCodexObservation(observation object, selected **string) (object, turnTransition) {
	value, lifecycle := classifyCodexObservation(observation, selected)
	items := arr(field(observation["thread"], "turns"))
	state, _ := lifecycle.wait()
	if state.terminal() {
		for i, row := range items {
			if field(row, "id") != value["turnId"] {
				continue
			}
			value["nextTurnId"], value["nativeContinuation"] = nil, nil
			if i+1 < len(items) {
				next := obj(items[i+1])
				value["nextTurnId"] = next["id"]
				if history := text(observation, "rollout"); history != "" {
					value["nativeContinuation"], _ = notificationContinuationEvidence(obj(observation["thread"]), text(value, "turnId"), next, history)
				}
			}
			break
		}
	}
	return value, lifecycle
}

func nativeNotificationObserve(ctx context.Context, s *service, b object) (object, error) {
	if notificationAgent(b) != "codex" {
		return observeNativeAgentNotification(ctx, s, b)
	}
	thread := text(b, "threadId")
	selected := optionalProjectString(b["turnId"])
	historical := text(b["observation"], "state") != "running" && text(b["observation"], "state") != "interaction-required"
	observed, err := readCodexObservation(ctx, s, thread, selected, historical, false)
	if err != nil {
		return nil, err
	}
	value, lifecycle := projectCodexObservation(observed, &selected)
	if historical && (value["recordedStatus"] == "inProgress" || value["state"] == "interaction-required") {
		observed, err = readCodexObservation(ctx, s, thread, selected, false, false)
		if err != nil {
			return nil, err
		}
		value, lifecycle = projectCodexObservation(observed, &selected)
	}
	applyCodexProgress(ctx, &s.events, value, obj(observed["thread"]))
	value["_turnLifecycle"] = lifecycle.checkpoint()
	return value, nil
}

func nativeNotificationWatch(ctx context.Context, s *service, b object) (history, writer string) {
	if notificationAgent(b) != "codex" {
		return "", ""
	}
	thread := text(b, "threadId")
	_, home, err := codexInputs()
	if err != nil {
		return "", ""
	}
	writer = wire(probeWriter(home, thread))
	s.codex.mu.Lock()
	path := s.codex.historyPaths[thread]
	s.codex.mu.Unlock()
	if path != "" {
		if file, err := openNativeHistory(home, object{"path": path}); err == nil {
			_ = file.Close()
			history = path
		}
	}
	return history, writer
}

func nativeEventWake(events *nativeEvents) <-chan struct{} {
	events.Lock()
	defer events.Unlock()
	if events.changed == nil {
		events.changed = make(chan struct{})
	}
	return events.changed
}

func nativeCodexWatchSource(ctx context.Context, s *service, thread string, selected **string) (nativeWaitSource, error) {
	source := nativeWaitSource{wake: func() <-chan struct{} { return nativeEventWake(&s.events) }}
	_, home, err := codexInputs()
	if err != nil {
		return source, err
	}
	if binding, err := codexDesktopBinding(thread); err != nil {
		return source, err
	} else if binding["transport"] == "local-daemon" {
		rpc, err := s.desktopBackendRPC(ctx, text(binding, "backend"))
		if err != nil {
			return source, err
		}
		source.alive = rpc.alive.Load
		source.observe = func(ctx context.Context) (object, error) {
			return readCodexObservationPages(ctx, s, thread, *selected, true, string(rpc.role),
				func(method string, params object) (any, error) { return rpc.call(ctx, method, params, 10*time.Second) })
		}
		return source, nil
	}
	background := codexBackground(thread) || fixtureUsesDesktop != nil && !fixtureUsesDesktop()
	if probeWriter(home, thread)["state"] == "held" {
		switch s.nativeWriterOwnership(ctx, home, thread)["owner"] {
		case "desktop":
			background = false
		case "external":
			background = true
		}
	}
	if background {
		rpc, err := s.codexUtility(ctx)
		if err != nil {
			return source, err
		}
		source.alive = rpc.alive.Load
		source.observe = func(ctx context.Context) (object, error) {
			return readCodexObservationPages(ctx, s, thread, *selected, true, string(rpc.role),
				func(method string, params object) (any, error) { return rpc.call(ctx, method, params, 10*time.Second) })
		}
		return source, nil
	}
	desktop, err := s.nativeDesktop(ctx)
	if err != nil {
		return source, err
	}
	source.alive = desktop.alive.Load
	var desktopOwner string
	source.observe = func(ctx context.Context) (object, error) {
		owner, err := desktop.owner(ctx, thread)
		if err != nil {
			return nil, err
		}
		if desktopOwner != "" && desktopOwner != owner {
			return nil, errors.New("runtime-owner-changed")
		}
		desktopOwner = owner
		state, err := desktop.readOwned(ctx, thread, true, owner)
		if err != nil {
			return nil, err
		}
		native, err := desktopControlThread(state, true)
		if err != nil {
			return nil, err
		}
		return hydrateCodexObservation(ctx, s, native, thread, *selected, true)
	}
	return source, nil
}

func nativeCodexWait(ctx context.Context, r operationRequest) (any, error) {
	started := time.Now()
	thread := text(r.args, "threadId")
	selected := optionalProjectString(r.args["turnId"])
	var lifecycle turnTransition
	var nativeTurns []any
	shutdown := r.service.codex.shutdown
	if shutdown == nil {
		shutdown = context.Background()
	}
	connect, cancel := context.WithTimeout(ctx, time.Duration(min(uintOr(r.args["timeoutMs"], 30000), 10000))*time.Millisecond)
	stop := context.AfterFunc(shutdown, cancel)
	source, err := nativeCodexWatchSource(connect, r.service, thread, &selected)
	connectErr := connect.Err()
	stop()
	cancel()
	if err != nil {
		reason := err.Error()
		switch {
		case shutdown.Err() != nil:
			reason = "connector-shutdown"
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case errors.Is(connectErr, context.DeadlineExceeded):
			reason = "native-connect-timeout"
		}
		result := finishNativeWait(waitInitialResult(r.args), waitUnconfirmed, reason, started, nil)
		nativeWaitCondition(result, r.args)
		if wantsTaskSummary(r.name, r.args) {
			if err := addCodexTaskSummaryEvidence(ctx, thread, result, nil); err != nil {
				return nil, err
			}
		}
		return result, nil
	}
	source.classify = func(value object, turn **string) object {
		out, next := projectCodexObservation(value, turn)
		applyCodexProgress(ctx, &r.service.events, out, obj(value["thread"]))
		lifecycle, selected = next, *turn
		nativeTurns = arr(field(value["thread"], "turns"))
		return out
	}
	result, err := runNativeWait(ctx, shutdown, source, r.args, started)
	if err != nil {
		return nil, err
	}
	if nativeTurnConflict(lifecycle) != nil {
		result["_turnLifecycle"] = lifecycle.checkpoint()
		if err := handleNotificationObservation(ctx, r.service, thread, text(result, "turnId"), result); err != nil {
			recordLog("WARN", "Notification conflict: "+err.Error(), nil)
		}
		delete(result, "_turnLifecycle")
	}
	nativeWaitCondition(result, r.args)
	if wantsTaskSummary(r.name, r.args) {
		turn := find(nativeTurns, "id", text(result, "turnId"))
		if err := addCodexTaskSummaryEvidence(ctx, thread, result, turn); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func init() {
	compactControlWaitResponse = compactNativeWaitResponse
	mergeNotificationLifecycle = nativeNotificationLifecycle
	mergeDispatchLifecycle = nativeDispatchLifecycle
	dispatchLifecycleOutcome = func(row object) string {
		return dispatchRecordTransition(row).push()
	}
	dispatchNativeTurnMetadata = nativePersistedTurnMetadata
	dispatchNativeTurnOutcome = func(thread string, turns []any, selected string) (string, any) {
		transition := codexTurnSnapshots(thread, turns, selected)
		state, _ := transition.wait()
		return string(state), transition.checkpoint()
	}
	observeNotificationTurn = nativeNotificationObserve
	notificationObservationEvidence = nativeNotificationWatch
	notificationIssueResponseToken = issueRespondToken
	dispatchTrackConversation = recordSRCReference
	endCodexOwnershipScope = func(_ context.Context, thread, reason string) error {
		return endNotificationScope(thread, reason)
	}
	observeNativeCodexOwnership = func(_ context.Context, thread string, owner object) (object, error) {
		return observeNotificationOwnership(thread, owner)
	}
	notificationRoutingEnvironment = func(systemPresent bool, real int64) (bool, int64, string, error) {
		appEnvLock.Lock()
		defer appEnvLock.Unlock()
		env, err := loadAppEnvironment(root(), real)
		return env.presence(systemPresent), env.clockNow(real), env.clockID(), err
	}
	readCoordinationCodexHead = func(ctx context.Context, s *service, thread string) (object, error) {
		observation, err := readCodexObservation(ctx, s, thread, nil, true, false)
		if err != nil {
			return nil, err
		}
		var selected *string
		value, transition := projectCodexObservation(observation, &selected)
		return object{"id": value["turnId"], "status": value["state"], "_turnLifecycle": transition.checkpoint()}, nil
	}
	registerOperation("codex_wait", nativeCodexWait, nil)
}

func init() {
	notificationNotifyConversation = func(account, target, confirmedAt string, tasks [][2]string) error {
		return publishSRCVerifiedTarget(account, target, optionalProjectString(dispatchFirstString(confirmedAt)), tasks)
	}
	srcVerifiedTarget = verifiedNotificationConversationTarget
	srcVerifiedTargets = verifiedNotificationConversationTargets
	srcInheritedTarget = func(source, task string) (string, error) {
		target, err := notificationConversationTargetForSend(source, task)
		return str(target), err
	}
}
