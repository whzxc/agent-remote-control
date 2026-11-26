package core

import (
	"context"
	"errors"
)

func decideCodexReceipt(ctx context.Context, r operationRequest) (any, error) {
	request, action := text(r.args, "requestId"), text(r.args, "action")
	switch action {
	case "approve", "bypass", "reject":
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
	if row["state"] != "awaiting-approval" || field(row["desktopRecovery"], "state") == "waiting-for-local" {
		return row, nil
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
	default:
		return nil, errors.New(PortPending)
	}
	source := "cloud"
	if r.source.local {
		source = "local"
	}
	decision := action
	if decision == "approve" {
		decision = "approved"
	}
	row["approval"] = object{"decision": decision, "source": source, "answeredBy": interactionAnsweredBy(origin), "at": now()}
	delete(row, "nextAction")
	row["backendSession"] = session
	if action == "reject" {
		row["state"] = "rejected"
		return row, store.checkpoint(ctx, row)
	}
	lifetime := r.service.jobs.begin()
	if lifetime == nil {
		return nil, errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	row["state"] = "reserved"
	if err := store.checkpoint(ctx, row); err != nil {
		r.service.jobs.finish()
		return nil, err
	}
	unlocked = true
	unlock()
	wait := min(uintOr(r.args["waitMs"], 25000), 120000)
	return launchControlMutation(withOrigin(ctx, obj(row["origin"])), r.service, store, row, lifetime, wait, func(ctx context.Context, row object) (any, error) {
		return perform(ctx, r, row)
	})
}

func init() {
	decideControlReceipt = decideCodexReceipt
}
