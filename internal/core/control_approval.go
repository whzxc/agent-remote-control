package core

import (
	"context"
	"errors"
)

func decideCodexReceipt(ctx context.Context, r operationRequest, localDecision bool) (any, error) {
	request, action := text(r.args, "requestId"), text(r.args, "action")
	switch action {
	case "approve", "bypass", "reject", "restart-desktop", "independent-desktop":
	default:
		return nil, errors.New("invalid approval action")
	}
	session := text(r.service.metadata, "instance")
	store := coreReceiptStore()
	unlock := lockReceipt(request)
	unlocked := false
	defer func() {
		if !unlocked {
			unlock()
		}
	}()
	row, err := store.readInContext(ctx, request, session)
	if err != nil {
		return nil, err
	}
	origin := currentOrigin(ctx)
	if !r.source.local && origin["sourceId"] != field(row["origin"], "sourceId") {
		return nil, errors.New("RECEIPT_SOURCE_MISMATCH")
	}
	if row["state"] != "awaiting-approval" {
		return row, nil
	}
	recovery := obj(row["desktopRecovery"])
	desktopDecision := action == "restart-desktop" || action == "independent-desktop"
	recoveryPending := recovery["state"] == "waiting-for-local"
	if recoveryPending {
		if !localDecision {
			return row, nil
		}
		if r.args["desktopDecisionId"] != recovery["decisionId"] {
			return nil, errors.New("DESKTOP_RECOVERY_DECISION_STALE")
		}
		switch action {
		case "restart-desktop":
			recovery["state"], recovery["choice"] = "preparing", "restart"
		case "independent-desktop":
			recovery["state"], recovery["choice"] = "preparing", "independent"
		case "reject":
			recovery["state"] = "cancelled"
		default:
			return row, nil
		}
	} else if desktopDecision {
		return nil, errors.New("DESKTOP_RECOVERY_DECISION_NOT_PENDING")
	}
	var perform func(context.Context, operationRequest, object) (object, error)
	switch row["operation"] {
	case "create":
		perform = createBackgroundCodex
	case "send":
		perform = sendCodexMutation
	case "resume":
		perform = resumeCodexMutation
	case "interrupt":
		perform = interruptCodexMutation
	case "native":
	default:
		return nil, errors.New("UNSUPPORTED_OPERATION: Read the original receipt before deciding the operation.")
	}
	if !recoveryPending {
		source := "cloud"
		if localDecision {
			source = "local"
		}
		decision := action
		if decision == "approve" {
			decision = "approved"
		}
		row["approval"] = object{"decision": decision, "source": source, "answeredBy": interactionAnsweredBy(origin), "at": now()}
	}
	delete(row, "nextAction")
	row["backendSession"] = session
	if action == "reject" {
		row["state"] = "rejected"
		if recoveryPending {
			row["state"] = "not-executed"
		}
		return row, store.checkpoint(ctx, row)
	}
	row["state"] = "reserved"
	if row["operation"] == "create" && row["executionOwner"] == "desktop" && (fixtureUsesDesktop == nil || fixtureUsesDesktop()) {
		settings, err := notificationSettings()
		if err != nil {
			return nil, err
		}
		prepareDesktopCodexCreate(ctx, r.service, row, settings)
		if row["state"] != "reserved" {
			return row, store.checkpoint(ctx, row)
		}
	}
	lifetime := r.service.jobs.begin()
	if lifetime == nil {
		return nil, errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	if err := store.checkpoint(ctx, row); err != nil {
		r.service.jobs.finish()
		return nil, err
	}
	unlocked = true
	unlock()
	wait := min(uintOr(r.args["waitMs"], 25000), 120000)
	return launchControlMutation(withOrigin(ctx, obj(row["origin"])), r.service, store, row, lifetime, wait, func(ctx context.Context, row object) (any, error) {
		if perform == nil {
			return executeNativeCodexReceipt(ctx, r.service, "codex_call", row)
		}
		return perform(ctx, r, row)
	})
}

func init() {
	decideControlReceipt = func(ctx context.Context, r operationRequest) (any, error) {
		return decideCodexReceipt(ctx, r, false)
	}
}
