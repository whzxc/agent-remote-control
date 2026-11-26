package core

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
)

func codexConversationPreview(ctx context.Context, s *service, thread string, owner object, known bool) (object, error) {
	if owner["owner"] == "external" || owner["runtimeStatus"] == "active" {
		return nil, nil
	}
	turns, err := requestCodexNative(ctx, s, "thread/turns/list", object{"threadId": thread,
		"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, 3*time.Second)
	if err != nil {
		return nil, err
	}
	rows := arr(field(turns, "data"))
	if len(rows) == 0 {
		return nil, nil
	}
	turn := clone(obj(rows[0]))
	terminal, ok := codexTurnSnapshot(thread, turn).terminal()
	if !ok || terminal.outcome != turnCompleted || text(turn, "id") == "" {
		return nil, nil
	}
	items, err := requestCodexNative(ctx, s, "thread/items/list", object{"threadId": thread, "turnId": turn["id"],
		"limit": 48, "sortDirection": "desc"}, 3*time.Second)
	if err != nil {
		return nil, err
	}
	rows = arr(field(items, "data"))
	if len(rows) == 0 || field(items, "nextCursor") == nil && field(turns, "nextCursor") == nil {
		return nil, nil
	}
	input := make([]any, 0, len(rows))
	for _, row := range slices.Backward(rows) {
		input = append(input, field(row, "item"))
	}
	turn["items"] = input
	var timeline taskTimeline
	timeline.backfillCodex(object{"id": thread, "turns": []any{turn}}, nil, nil, 0, 0, now())
	if err := projectInteractionAnswers(thread, func(request, response object) { timeline.answered(request, response) }); err != nil {
		return nil, err
	}
	result := timeline.response(thread, 0)
	if len(decodedTaskList(result["entries"])) == 0 {
		return nil, nil
	}
	result["preview"], result["executionEvidence"], result["ownership"] = true, "partial", owner
	coverage := dispatchSetSection(result, "coverage")
	coverage["state"], coverage["reason"] = "partial", "recent-preview"
	if !known {
		result["readOnly"] = true
	}
	return result, nil
}

func codexConversationHistory(ctx context.Context, s *service, thread string) (object, error) {
	metadata, err := readCodexMetadata(ctx, s, thread)
	if err != nil {
		return nil, err
	}
	if metadata["id"] != thread {
		return nil, errors.New("NATIVE_THREAD_ID_MISMATCH")
	}
	turns, err := controlSubmissionHistory(ctx, false, func(ctx context.Context, cursor any) (object, error) {
		value, err := requestCodexNative(ctx, s, "thread/turns/list", object{"threadId": thread,
			"cursor": cursor, "limit": 100, "sortDirection": "desc", "itemsView": "full"}, 15*time.Second)
		return obj(value), err
	})
	if err != nil {
		return nil, err
	}
	metadata["turns"] = turns
	return metadata, nil
}

func externalCodexConversationTimeline(ctx context.Context, s *service, thread string, owner object) (object, error) {
	var timeline taskTimeline
	var native object
	if path := s.codex.activity.path(thread); path != "" || owner["owner"] == "external" {
		var err error
		native = object{"id": thread, "path": path}
		if path == "" {
			native, err = readCodexMetadata(ctx, s, thread)
			if err != nil {
				return nil, err
			}
			if native["id"] != thread {
				return nil, errors.New("NATIVE_THREAD_ID_MISMATCH")
			}
		}
		_, home, err := codexInputs()
		if err != nil {
			return nil, err
		}
		file, err := openNativeHistory(home, native)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		var clock codexActivityClock
		err = visitNativeRollout(file, thread, func(row object) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			timeline.backfillCodexRecords([]any{row})
			clock.observe(row)
			return nil
		})
		if err != nil {
			return nil, err
		}
		for turn, config := range clock.configurations {
			if summary := dispatchSummary(config); summary != nil {
				timeline.TurnDispatchSummaries[turn] = summary
			}
		}
		if native["cwd"] == nil {
			native["cwd"] = clock.project
		}
	} else {
		var err error
		native, err = codexConversationHistory(ctx, s, thread)
		if err != nil {
			return nil, err
		}
		timeline.backfillCodex(native, nil, nil, 0, 0, now())
	}

	if err := projectInteractionAnswers(thread, func(request, response object) { timeline.answered(request, response) }); err != nil {
		return nil, err
	}
	result := timeline.response(thread, 0)
	result["readOnly"], result["ownership"] = true, owner
	projects, _ := cachedNativeProjects(ctx, s)
	result["projectName"] = localProjectName(projects, text(native, "cwd"), text(native, "projectId"))
	if digest, ok := result["snapshotHash"].(string); ok {
		result["snapshotHash"] = hash([]byte(wire([]any{digest, owner["currentOwner"], owner["state"], owner["history"], owner["handback"], owner["origin"], owner["processes"]})))
	}
	return result, nil
}

func nativeCodexConversationTimeline(ctx context.Context, s *service, args object) (object, error) {
	thread := text(args, "id")
	if _, err := uuid.Parse(thread); err != nil {
		return nil, errors.New("INVALID_SESSION_ID")
	}
	ownerValue, err := nativeCodexOwner(ctx, operationRequest{args: object{"threadId": thread}, service: s})
	if err != nil {
		return nil, err
	}
	owner := obj(ownerValue)
	s.events.Lock()
	live := s.events.taskTimelines[thread]
	known, loaded := live != nil, live != nil && live.HistoryLoaded && !live.ObservationLost
	s.events.Unlock()
	if !known {
		records, err := s.readCodexTaskRecords(ctx)
		if err != nil {
			return nil, err
		}
		known = slices.ContainsFunc(records, func(row object) bool { return receiptThread(row) == thread })
	}
	var result object
	if args["recent"] == true && args["after"] == nil && !loaded {
		result, _ = codexConversationPreview(ctx, s, thread, owner, known)
	}
	if result == nil {
		switch {
		case !known || owner["owner"] == "external":
			result, err = externalCodexConversationTimeline(ctx, s, thread, owner)
		default:
			result, err = trackedCodexConversation(ctx, s, thread, uintOr(args["after"], 0), owner, loaded)
		}
	}
	if err != nil {
		return nil, err
	}
	ref, err := taskSRCReference("codex", thread)
	if err != nil {
		return nil, err
	}
	result["srcConversation"] = ref
	return result, nil
}

func trackedCodexConversation(ctx context.Context, s *service, thread string, after uint64, owner object, loaded bool) (object, error) {
	var metadata object
	s.events.Lock()
	timeline := s.events.taskTrackingTimeline(thread)
	baseline, observed := timeline.Revision, timeline.ObservedEvents
	s.events.Unlock()
	if !loaded {
		var err error
		metadata, err = codexConversationHistory(ctx, s, thread)
		if err != nil {
			return nil, err
		}
	}
	answers, err := readInteractionAnswers(interactionAnswersDirectory(thread))
	if err != nil {
		return nil, err
	}
	s.events.Lock()
	defer s.events.Unlock()
	timeline = s.events.taskTrackingTimeline(thread)
	if metadata != nil {
		timeline.backfillCodex(metadata, nil, nil, baseline, observed, now())
		timeline.ObservationLost = timeline.Unsubscribed
	}
	syncTrackedNativeInteractions(&s.events, now())
	for _, answer := range answers {
		timeline.answered(answer["request"], answer["response"])
	}
	result := timeline.response(thread, after)
	result["ownership"] = owner
	return result, nil
}

func init() {
	readTaskTrackingAnswers = func(_ context.Context, _ *service, thread string) ([]object, error) {
		return readInteractionAnswers(interactionAnswersDirectory(thread))
	}
	resolveTrackedConversation = func(ctx context.Context, s *service, args object) (object, error) {
		if args["agent"] != "codex" {
			return nativeAgentTimeline(ctx, s, args)
		}
		return nativeCodexConversationTimeline(ctx, s, args)
	}
	registerRoute(http.MethodPost, "agents/conversations/timeline", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return resolveTrackedConversation(ctx, s, body)
	})
	registerRoutePattern(http.MethodGet, "agents/timeline/([A-Za-z0-9-]+)", func(ctx context.Context, s *service, body object, parts []string) (any, error) {
		args := clone(body)
		if args == nil {
			args = object{}
		}
		args["agent"], args["id"] = "codex", parts[0]
		if task, err := s.nativeAgentTask("", parts[0]); err == nil {
			args["agent"] = task["agent"]
		}
		return resolveTrackedConversation(ctx, s, args)
	})
}
