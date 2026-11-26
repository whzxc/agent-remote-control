package core

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"
)

var endCodexOwnershipScope func(context.Context, string, string) error

func nativeThreadHasInteraction(service *service, thread string) bool {
	return slices.ContainsFunc(service.events.pendingInteractions(), func(row object) bool {
		return field(row["params"], "threadId") == thread
	})
}

func releaseCodexWriter(ctx context.Context, s *service, thread string) (object, error) {
	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	ownership := s.nativeWriterOwnership(ctx, home, thread)
	result := object{"threadId": thread, "released": false, "state": "unconfirmed", "ownership": ownership}
	if ownership["state"] == "unheld" {
		result["released"], result["alreadyUnheld"], result["state"] = true, true, "completed"
		return result, nil
	}
	next := object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread}}
	if ownership["state"] != "held" {
		result["error"] = object{"code": "WRITER_RELEASE_UNCONFIRMED",
			"message": "The native writer lock state could not be determined. Re-probe this thread before attempting release.", "next": next}
		return result, nil
	}
	ownership["processes"] = writerProcesses(ctx, home, thread)
	if ownership["owner"] != "connector" {
		return nil, errors.New(wire(object{"code": "WRITER_RELEASE_REQUIRES_OWNER",
			"message":   "This writer is not owned by ARC's connector. The Desktop follower protocol exposes no safe per-thread release request. Use the exact owner step; ARC will not close another session.",
			"ownership": ownership, "next": writerReleaseStep(thread, ownership)}))
	}
	connection, err := s.codexUtility(ctx)
	if err != nil {
		return nil, err
	}
	metadata, err := connection.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, 3*time.Second)
	if err != nil {
		return nil, err
	}
	if text(field(field(metadata, "thread"), "status"), "type") != "idle" || nativeThreadHasInteraction(s, thread) {
		return nil, errors.New(wire(object{"code": "WRITER_ACTIVE",
			"message": "Release requires an idle connector thread with no pending interactions. Finish or explicitly interrupt the turn before release.",
			"next":    object{"via": "query", "op": "codex_read", "args": object{"threadId": thread, "statusOnly": true}}}))
	}
	next["hint"] = "Re-probe this exact writer after native cleanup. If it remains connector-owned, inspect the native release error. To archive it instead, use codex_archive with this threadId and release:true."
	native, err := connection.call(ctx, "thread/unsubscribe", object{"threadId": thread}, 3*time.Second)
	if err != nil {
		code, state := "WRITER_RELEASE_UNCONFIRMED", "unconfirmed"
		if strings.HasPrefix(err.Error(), "RPC_REJECTED:") {
			code, state = "WRITER_RELEASE_UNAVAILABLE", "failed"
		}
		result["state"], result["ownership"] = state, probeWriter(home, thread)
		result["error"] = object{"code": code,
			"message":     "The native app-server did not confirm per-thread unsubscribe. Inspect ownership before another attempt.",
			"nativeError": controlFailure(err), "next": next}
		return result, nil
	}
	result["nativeStatus"] = field(native, "status")
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		current := probeWriter(home, thread)
		if current["state"] == "unheld" {
			result["released"], result["ownership"], result["state"] = true, current, "completed"
			return result, nil
		}
		select {
		case <-ticker.C:
		case <-wait.Done():
			result["ownership"] = current
			result["error"] = object{"code": "WRITER_RELEASE_UNCONFIRMED",
				"message": "Native unsubscribe completed, but the writer lock did not become unheld within the release window. The app-server may still be unloading the thread or retaining another subscription.", "next": next}
			return result, nil
		}
	}
}

func archiveCodexThread(ctx context.Context, s *service, args, receipt object) (object, error) {
	thread := text(args, "threadId")
	receipt["threadId"] = thread
	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	binding, err := codexExecutionRecord(thread)
	if err != nil {
		return nil, err
	}
	var connection *rpcConnection
	if binding["owner"] == "desktop" && binding["transport"] == "local-daemon" {
		connection, err = s.desktopBackendRPC(ctx, text(binding, "backend"))
	} else {
		connection, err = s.codexUtility(ctx)
	}
	if err != nil {
		return nil, err
	}
	metadata, err := connection.call(ctx, "thread/read", object{"threadId": thread, "includeTurns": false}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	runtime := text(field(field(metadata, "thread"), "status"), "type")
	if runtime == "active" || nativeThreadHasInteraction(s, thread) {
		return nil, errors.New(wire(object{"code": "ARCHIVE_ACTIVE_TURN",
			"message": "The thread is active or has a pending interaction. Finish it, or explicitly interrupt it, before archiving.",
			"next":    object{"via": "query", "op": "codex_read", "args": object{"threadId": thread, "statusOnly": true}}}))
	}
	if endCodexOwnershipScope == nil {
		return nil, errors.New(PortPending)
	}
	if args["release"] == true {
		owner := s.nativeWriterOwnership(ctx, home, thread)
		if owner["state"] != "unheld" && (owner["owner"] != "connector" || runtime != "idle") {
			released, err := releaseCodexWriter(ctx, s, thread)
			if err != nil {
				return nil, err
			}
			if released["released"] != true {
				return nil, errors.New("RELEASE_UNCONFIRMED: read codex_owner before archive")
			}
		}
	}
	receipt["submissionStage"] = "submitting"
	if err := coreReceiptStore().checkpoint(ctx, receipt); err != nil {
		return nil, err
	}
	if _, err := connection.call(ctx, "thread/archive", object{"threadId": thread}, 10*time.Second); err != nil {
		if !strings.Contains(err.Error(), "active writer") {
			return nil, err
		}
		owner := s.nativeWriterOwnership(ctx, home, thread)
		owner["processes"] = writerProcesses(ctx, home, thread)
		var rpc object
		if data, ok := strings.CutPrefix(err.Error(), "RPC_REJECTED:"); ok {
			_ = decodeObject([]byte(data), &rpc)
		}
		return nil, errors.New(wire(object{"code": "ARCHIVE_WRITER_BUSY",
			"message":    "Native archival requires the owning session to release or archive this exact thread.",
			"nativeCode": rpc["code"], "ownership": owner, "retryable": false, "next": writerReleaseStep(thread, owner)}))
	}
	if err := endCodexOwnershipScope(ctx, thread, "thread-archived"); err != nil {
		return nil, err
	}
	return object{"threadId": thread, "archived": true, "nativeMethod": "thread/archive"}, nil
}

func init() {
	registerOperation("codex_release", func(ctx context.Context, r operationRequest) (any, error) {
		return runControlMutation(ctx, r, "release", r.args, func(ctx context.Context, row object) (any, error) {
			thread := text(row["arguments"], "threadId")
			row["threadId"] = thread
			return releaseCodexWriter(ctx, r.service, thread)
		})
	}, nil)
	registerOperation("codex_archive", func(ctx context.Context, r operationRequest) (any, error) {
		return runControlMutation(ctx, r, "archive", r.args, func(ctx context.Context, row object) (any, error) {
			return archiveCodexThread(ctx, r.service, obj(row["arguments"]), row)
		})
	}, nil)
}
