package core

import (
	"context"
	"errors"
	"os"
)

func lookupNativeAgentReceipt(ctx context.Context, r operationRequest) (any, bool, error) {
	name, action := text(r.args, "requestId"), text(r.args, "action")
	store := agentReceiptStore()
	path, err := store.path(name)
	if err != nil {
		return nil, false, err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	} else if err != nil {
		return nil, true, err
	}
	corePath, err := coreReceiptStore().path(name)
	if err != nil {
		return nil, true, err
	}
	if _, err := os.Stat(corePath); err == nil {
		return nil, true, errors.New("REQUEST_ID_CONFLICT: ambiguous receipt owner")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, true, err
	}
	session := text(r.service.metadata, "instance")
	unlock := lockReceipt(name)
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	row, err := store.readInContext(ctx, name, session)
	if err != nil {
		return nil, true, err
	}
	origin := currentOrigin(ctx)
	if !r.source.local && origin["sourceId"] != field(row["origin"], "sourceId") {
		return nil, true, errors.New("RECEIPT_SOURCE_MISMATCH")
	}
	if action == "" || action == "read" || row["state"] != "awaiting-approval" {
		return row, true, nil
	}
	if action != "approve" && action != "bypass" && action != "reject" {
		return nil, true, errors.New("INVALID_APPROVAL_ACTION")
	}
	row["approval"], row["answeredBy"], row["backendSession"] = action, interactionAnsweredBy(origin), session
	delete(row, "nextAction")
	if action == "reject" {
		row["state"] = "rejected"
		return row, true, store.checkpoint(ctx, row)
	}
	r.name = text(row, "operation")
	perform := nativeAgentMutationHandlers[r.name]
	if perform == nil {
		return nil, true, errors.New("UNKNOWN_TOOL")
	}
	arguments := dispatchSetSection(row, "arguments")
	arguments["approval"] = "approved"
	if action == "bypass" {
		arguments["approval"] = action
	}
	if r.name != "agent_create" {
		task, err := r.service.nativeAgentTask(text(row, "agent"), text(row, "taskId"))
		if err != nil {
			return nil, true, err
		}
		row["previousTurnId"] = task["turnId"]
	}
	lifetime := r.service.jobs.begin()
	if lifetime == nil {
		return nil, true, errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	row["state"] = "reserved"
	if err := store.checkpoint(ctx, row); err != nil {
		r.service.jobs.finish()
		return nil, true, err
	}
	unlock()
	unlock = nil
	wait := min(uintOr(r.args["waitMs"], 25000), 120000)
	value, err := launchControlMutation(withOrigin(ctx, obj(row["origin"])), r.service, store, row, lifetime, wait,
		func(ctx context.Context, row object) (any, error) { return perform(ctx, r, row) })
	return value, true, err
}

func init() {
	ownedReceiptLookup = append(ownedReceiptLookup, lookupNativeAgentReceipt)
}
