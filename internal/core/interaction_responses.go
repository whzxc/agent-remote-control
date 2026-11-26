package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func interactionAnswersDirectory(thread string) string {
	return filepath.Join(root(), "interaction-responses", hash([]byte(thread)))
}

func interactionAnsweredBy(origin object) object {
	if origin["ingressId"] == "local-ui" {
		return object{"kind": "local-ui"}
	}
	if source := text(origin, "sourceId"); source != "" && len(source) <= 256 {
		return object{"kind": "source", "sourceId": source}
	}
	return object{"kind": "unknown"}
}

func recordInteractionAnswer(ctx context.Context, request, args object) error {
	thread := text(request["params"], "threadId")
	if thread == "" {
		return errors.New("INTERACTION_THREAD_MISSING")
	}
	origin := currentOrigin(ctx)
	row := object{"request": request, "response": object{"result": args["result"], "error": args["error"], "skipped": args["skipped"] == true,
		"origin": origin, "answeredBy": interactionAnsweredBy(origin), "resolvedAt": now()}}
	fingerprint := hash([]byte(wire([]any{request["backendSession"], field(request["params"], "turnId"), request["id"]})))
	path := filepath.Join(interactionAnswersDirectory(thread), fingerprint+".json")
	if err := save(path, row); err != nil {
		return fmt.Errorf("SUBMISSION_UNCONFIRMED: response acknowledged but answer persistence failed: %w; read the original receipt", err)
	}
	return nil
}

func readInteractionAnswers(directory string) ([]object, error) {
	rows := []object{}
	entries, err := cachedEntries(directory)
	if errors.Is(err, os.ErrNotExist) {
		return rows, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if filepath.Ext(entry.path) != ".json" {
			continue
		}
		row, err := cachedLoad(entry.path)
		if err != nil {
			return nil, err
		}
		rows = append(rows, obj(row))
	}
	slices.SortStableFunc(rows, func(a, b object) int {
		return strings.Compare(text(a["response"], "resolvedAt"), text(b["response"], "resolvedAt"))
	})
	return rows, nil
}

func projectInteractionAnswers(thread string, apply func(request, response object)) error {
	rows, err := readInteractionAnswers(interactionAnswersDirectory(thread))
	if err != nil {
		return err
	}
	for _, row := range rows {
		apply(obj(row["request"]), obj(row["response"]))
	}
	return nil
}

func init() {
	readTaskTrackingAnswers = func(_ context.Context, _ *service, thread string) ([]object, error) {
		return readInteractionAnswers(interactionAnswersDirectory(thread))
	}
	decorateControlResult = append(decorateControlResult, func(_ context.Context, request operationRequest, result object) {
		if request.name != "task_timeline" {
			return
		}
		for _, entry := range arr(result["entries"]) {
			response := obj(field(entry, "response"))
			if origin := obj(response["origin"]); field(response["answeredBy"], "kind") == "local-ui" &&
				origin["ingressId"] == "local-ui" && origin["controlSource"] == "ARC" {
				origin["sourceLabel"] = "ARC"
			}
		}
	})
}
