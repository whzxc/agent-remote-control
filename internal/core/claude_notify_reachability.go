package core

import (
	"context"
	"crypto/subtle"
	"errors"
	"slices"
)

const notificationReceiptHeader = "⟢ ARC · automated, not from the user · guide topic:notify"

// D owns profiles, visibility probes and identity confirmation. A owns Antigravity
// delivery and source-conversation projection.
var notificationClaudeProfile func(string) (string, error)
var notificationClaudePublicAccount func(string) object
var notificationClaudeProfiles func() ([]any, error)
var notificationClaudeCandidates func(context.Context, string) ([]any, error)
var notificationClaudeLegacyRoute func(string) (string, error)
var notificationClaudeIdentity func(context.Context, string) (object, error)
var notificationConfirmIdentity func(string, object) (object, error)
var notificationSessionSend func(context.Context, string, string, string, string) error
var notificationSourceRows func() ([]any, error)
var notificationNotifyConversation func(account, target, confirmedAt string, tasks [][2]string) error
var notificationClaudeIdentityStatus func(context.Context, string) (object, error)

func newNotificationReachability() object {
	return object{"state": "unverified", "reason": "handshake-required", "attempts": 0, "deliveryStatus": "not-attempted",
		"lastError": nil, "challengeHash": "", "sourceId": "", "expiresAt": 0, "identityEvidence": nil, "verifiedAt": 0, "failedAt": 0}
}

func notificationReachability(target object) object {
	if r := obj(target["reachability"]); r != nil {
		return r
	}
	r := newNotificationReachability()
	target["reachability"] = r
	return r
}

func failNotificationReachability(reach object, reason string, at int64) {
	reach["state"], reach["reason"], reach["failedAt"] = "failed", reason, at
	reach["challengeHash"], reach["expiresAt"] = "", 0
}

func expireNotificationReachability(reach object, now int64) {
	if expires := uintOr(reach["expiresAt"], 0); text(reach, "challengeHash") != "" && uint64(now) >= expires {
		failNotificationReachability(reach, "handshake-timeout", int64(expires)*1000)
	}
}

func notificationRouteNext(action, target string) object {
	return object{"via": "act", "op": "notify_control", "args": object{"action": action, "target": target}}
}

func notificationReachabilityControl(ctx context.Context, r operationRequest, source string, settings object) (any, error) {
	action := text(r.args, "action")
	target, err := notificationSessionID(text(r.args, "target"))
	if err != nil {
		return nil, err
	}
	channel := notificationTargetChannel(target)
	var result object
	if action == "bind" {
		result, err = registerNotificationTarget(source, target, channel, r.args, settings)
		if err != nil {
			return nil, err
		}
	}
	route, err := notificationAccountRoute(ctx, source, target, channel, r, settings)
	if err != nil {
		if result != nil {
			result["ok"], result["error"] = false, controlFailure(err)
			result["next"] = field(result["error"], "next")
			return result, nil
		}
		return nil, err
	}
	if action == "route" {
		return route, nil
	}
	if result != nil {
		result["accountRoute"] = route
		if err := syncNotificationConversation(source, target, false); err != nil {
			return nil, err
		}
		if r.args["verify"] == false {
			return result, nil
		}
	}
	verification, err := verifyNotificationTarget(ctx, source, target, channel, settings)
	if result == nil {
		return verification, err
	}
	if err != nil {
		result["ok"], result["error"] = false, controlFailure(err)
		return result, nil
	}
	if verification["ok"] == false {
		result["ok"], result["error"] = false, verification["error"]
		delete(verification, "error")
	}
	if next := verification["next"]; next != nil {
		result["next"] = next
		delete(verification, "next")
	}
	result["verification"] = verification
	return result, nil
}

func registerNotificationTarget(source, target, channel string, args, settings object) (object, error) {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	now := notificationClock().Unix()
	_, bindTask := args["threadId"].(string)
	if bindTask {
		if _, err := controlNotificationState(state, settings, source, object{"action": "rebind", "threadId": args["threadId"], "target": target}, now); err != nil {
			return nil, err
		}
	}
	notificationTarget(state, settings, source, channel, target, now)["registered"] = true
	if err := saveNotificationState(state); err != nil {
		return nil, err
	}
	next := notificationRouteNext("verify", target)
	next["hint"] = "Binding persists if verification fails. Acknowledge only the code received in the target conversation. Pass the returned notify object on future dispatches; registration alone does not subscribe tasks."
	return object{"action": "bind", "bound": true, "target": target, "threadId": args["threadId"], "taskBound": bindTask,
		"notify": object{"channel": channel, "target": target}, "next": next}, nil
}

func notificationAccountRoute(ctx context.Context, source, target, channel string, r operationRequest, settings object) (object, error) {
	action := text(r.args, "action")
	if channel == "antigravity-session" {
		if action == "route" {
			return nil, errors.New("ANTIGRAVITY_ACCOUNT_ROUTE_UNSUPPORTED: agentapi uses the native Desktop login")
		}
		return object{"target": target, "transport": "agentapi"}, nil
	}
	notificationEventOperation.Lock()
	state, err := readNotificationState()
	if err != nil {
		notificationEventOperation.Unlock()
		return nil, err
	}
	t := findNotificationTarget(state, source, channel, target)
	if t["registered"] != true {
		rows, err := notificationBindings()
		if err != nil {
			notificationEventOperation.Unlock()
			return nil, err
		}
		if slices.ContainsFunc(rows, func(b object) bool {
			return b["sourceId"] == source && b["target"] == target && b["channel"] == channel
		}) {
			t = notificationTarget(state, settings, source, channel, target, notificationClock().Unix())
		} else {
			notificationEventOperation.Unlock()
			return nil, dispatchObjectError(object{"code": "NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE", "message": "Bind this target before reading or changing its account route", "next": notificationRouteNext("bind", target)})
		}
	}
	if (action == "verify" || action == "bind" && r.args["verify"] != false) && settings["notificationsEnabled"] == false {
		notificationEventOperation.Unlock()
		return nil, errors.New("NOTIFICATIONS_DISABLED")
	}
	profile := text(t, "accountId")
	if accountID, specified := r.args["accountId"].(string); specified {
		selected, err := notificationClaudeProfile(accountID)
		if err != nil {
			notificationEventOperation.Unlock()
			return nil, err
		}
		if selected != profile {
			profile = selected
			t["accountId"], t["reachability"] = profile, newNotificationReachability()
		}
	} else if profile == "" && notificationClaudeLegacyRoute != nil {
		profile, err = notificationClaudeLegacyRoute(target)
		if err != nil {
			notificationEventOperation.Unlock()
			return nil, err
		}
		if profile != "" {
			t["accountId"] = profile
		}
	}
	err = saveNotificationState(state)
	notificationEventOperation.Unlock()
	if err != nil {
		return nil, err
	}
	if account := notificationClaudePublicAccount(profile); action == "route" || account["id"] != nil {
		profiles, err := notificationClaudeProfiles()
		return object{"target": target, "accountId": account["id"], "profiles": profiles}, err
	}
	candidates, err := notificationClaudeCandidates(ctx, target)
	if err != nil {
		return nil, err
	}
	var selected, sourceProfile string
	owners := make(map[string]bool)
	visible, unknown := false, false
	for _, item := range candidates {
		row := obj(item)
		profile := text(row, "accountId")
		account := notificationClaudePublicAccount(profile)
		accountID := text(account, "id")
		if accountID != "" {
			row["accountId"] = accountID
		}
		if accountID != "" && r.source.origin["accountId"] == accountID && sourceProfile == "" {
			sourceProfile = profile
		}
		switch row["visibility"] {
		case "unknown":
			unknown = true
		case "visible":
			visible = true
			if accountID != "" {
				owners[accountID] = true
			}
			if selected == "" {
				selected = profile
			}
		}
	}
	if !visible {
		selected = sourceProfile
	} else if unknown || len(owners) != 1 {
		selected = ""
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err = readNotificationState()
	if err != nil {
		return nil, err
	}
	t = findNotificationTarget(state, source, channel, target)
	if t == nil {
		return nil, errors.New("NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE")
	}
	profile = text(t, "accountId")
	if profile == "" && selected != "" {
		profile, t["accountId"] = selected, selected
	}
	if profile == "" {
		next := notificationRouteNext("route", target)
		next["hint"] = "Inspect safe profiles, then set accountId with action:route and retry action:verify. If no profile can see the session, correct the session ID or have the user explicitly sign in to its owner profile."
		return nil, dispatchObjectError(object{"code": "ACCOUNT_SELECTION_REQUIRED",
			"message": "No unique visible Claude profile was confirmed. Select an accountId from candidates for this source-owned target; unknown means the read-only probe was inconclusive. ARC did not send a challenge or change accounts.",
			"target":  target, "candidates": candidates, "next": next})
	}
	return object{"target": target, "accountId": notificationClaudePublicAccount(profile)["id"], "profiles": candidates}, saveNotificationState(state)
}

func verifyNotificationTarget(ctx context.Context, source, target, channel string, settings object) (object, error) {
	code := id()
	digest := hash([]byte(code))
	var profile string
	var evidence object
	if channel == "claude-session" && notificationClaudeIdentity != nil && notificationClaudeRun != nil {
		selected, err := notificationSourceAccount(source, target)
		if err == nil {
			profile = selected
			evidence, err = notificationClaudeIdentity(ctx, profile)
			if err != nil {
				return nil, err
			}
		}
	}
	err := func() error {
		notificationEventOperation.Lock()
		defer notificationEventOperation.Unlock()
		state, err := readNotificationState()
		if err != nil {
			return err
		}
		t := findNotificationTarget(state, source, channel, target)
		if t["registered"] != true {
			rows, err := notificationBindings()
			if err != nil {
				return err
			}
			if !slices.ContainsFunc(rows, func(b object) bool {
				return b["sourceId"] == source && b["channel"] == channel && b["target"] == target
			}) {
				return dispatchObjectError(object{"code": "NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE",
					"message": "Call notify_control action:bind with this cloud-session target to register and verify it in one step. Optionally include an existing source-owned threadId to bind its wakeups without resending work. Future dispatches need the returned notify object.",
					"target":  target, "next": notificationRouteNext("bind", target), "guide": object{"tool": "guide", "arguments": object{"topic": "notify"}}})
			}
		}
		if settings["notificationsEnabled"] == false {
			return errors.New("NOTIFICATIONS_DISABLED")
		}
		now := notificationClock().Unix()
		t = notificationTarget(state, settings, source, channel, target, now)
		currentProfile := text(t, "accountId")
		if channel == "claude-session" {
			if currentProfile == "" {
				return errors.New("ACCOUNT_SELECTION_REQUIRED: Bind this target with notify_control and an accountId")
			}
			if currentProfile != profile || evidence["profileId"] != nil && evidence["profileId"] != profile {
				return dispatchObjectError(object{"code": "ACCOUNT_ROUTE_CHANGED", "message": "The route changed before verification. Retry for the current route.", "next": notificationRouteNext("verify", target)})
			}
		}
		reach := notificationReachability(t)
		expireNotificationReachability(reach, now)
		switch {
		case t["breaker"] == true:
			return errors.New("NOTIFICATION_BREAKER_ACTIVE")
		case uintOr(t["tokens"], 0) == 0:
			return errors.New("NOTIFICATION_TOKEN_WAIT")
		case text(reach, "challengeHash") != "":
			return errors.New("HANDSHAKE_PENDING: receive the code or retry after expiry")
		}
		notificationCharge(t, settings, now)
		next := newNotificationReachability()
		next["reason"], next["attempts"], next["deliveryStatus"] = "handshake-pending", uintOr(reach["attempts"], 0)+1, "sending"
		next["challengeHash"], next["sourceId"], next["expiresAt"] = digest, source, now+300
		if evidence != nil {
			next["identityEvidence"] = evidence
		}
		t["reachability"] = next
		return saveNotificationState(state)
	}()
	if err != nil {
		return nil, err
	}
	body := notificationReceiptHeader + "\n◎ ping · " + code
	if channel == "antigravity-session" {
		body += "\nCall notification_ack with target " + target + " and code " + code + "."
	}
	delivery := notificationSessionSend(ctx, channel, profile, target, body)
	missing := delivery != nil && notificationSessionNotFound(delivery.Error())
	var account object
	if missing && channel == "claude-session" {
		account = notificationSafeLocalAccount(ctx, profile)
	}
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	state, err := readNotificationState()
	if err != nil {
		return nil, err
	}
	t := notificationTarget(state, settings, source, channel, target, notificationClock().Unix())
	reach := notificationReachability(t)
	sent := "delivered"
	if delivery != nil {
		sent = "failed"
	}
	ownsAttempt := reach["challengeHash"] == digest || (reach["state"] == "verified" && t["accountId"] == profile)
	if ownsAttempt {
		reach["deliveryStatus"] = sent
		if delivery != nil {
			reason := "handshake-delivery-failed"
			if missing {
				reason = "claude-session-not-found"
			}
			failNotificationReachability(reach, reason, notificationClock().UnixMilli())
		}
	}
	result := object{"target": target, "reachability": reach["state"], "reason": reach["reason"], "expiresAt": reach["expiresAt"],
		"verificationAttempts": reach["attempts"], "deliveryStatus": sent,
		"next": object{"via": "query", "op": "notify_status", "args": object{"target": target}},
		"hint": "Confirm only with the code received in the target conversation via notification_ack. A successful send alone does not verify reachability."}
	if delivery != nil {
		result["ok"] = false
		next := notificationRouteNext("verify", target)
		next["hint"] = "Correct the reported delivery failure before retrying verification. Binding is retained."
		problem := object{"code": "NOTIFICATION_DELIVERY_FAILED", "message": "The verification message could not be delivered. Inspect notification logs, correct the destination or transport, and retry notify_control action:verify. Binding remains registered."}
		if missing && channel == "claude-session" {
			next = notificationRouteNext("route", target)
			next["hint"] = "Inspect this source-owned target's accountId and available profiles. Set its route with notify_control action:route and accountId, then retry action:verify. Correct the session ID if necessary. ARC never logs in or switches Claude accounts automatically."
			problem = object{"code": "CLAUDE_SESSION_NOT_FOUND", "message": "Claude CLI reported Session not found. Likely causes are a different local Claude account or an incorrect cloud-session ID; account mismatch is not confirmed.", "localAccount": account}
		} else if missing {
			next = notificationRouteNext("verify", target)
			problem = object{"code": "CLAUDE_SESSION_NOT_FOUND", "message": "Antigravity did not return conversation metadata. Correct the conversation ID before retrying; no message was sent."}
		}
		result["next"], result["error"] = next, problem
		if ownsAttempt {
			reach["lastError"] = problem
		}
	}
	return result, saveNotificationState(state)
}

func acknowledgeNotificationChallenge(state object, source string, args object) (object, error) {
	target, err := notificationSessionID(text(args, "target"))
	if err != nil {
		return nil, err
	}
	t := findNotificationTarget(state, source, notificationTargetChannel(target), target)
	if t == nil {
		return nil, errors.New("HANDSHAKE_NOT_FOUND")
	}
	reach := notificationReachability(t)
	expireNotificationReachability(reach, notificationClock().Unix())
	digest := hash([]byte(text(args, "code")))
	if reach["sourceId"] != source || subtle.ConstantTimeCompare([]byte(text(reach, "challengeHash")), []byte(digest)) != 1 {
		if err := saveNotificationState(state); err != nil {
			return nil, err
		}
		return nil, dispatchObjectError(object{"code": "HANDSHAKE_INVALID_OR_EXPIRED", "message": "The code is invalid, expired or already consumed. Verify this target again.", "next": notificationRouteNext("verify", target)})
	}
	resolution := object{"state": "unresolved", "reason": "No provider identity was available for the sending profile. Verify again after signing in."}
	if evidence := clone(obj(reach["identityEvidence"])); evidence != nil {
		evidence["sourceId"], evidence["target"], evidence["confirmedAt"] = source, target, now()
		resolution, err = notificationConfirmIdentity(source, evidence)
		if err != nil {
			return nil, err
		}
	}
	reach["verifiedAt"], reach["state"], reach["reason"] = notificationClock().UnixMilli(), "verified", "handshake-confirmed"
	reach["challengeHash"], reach["expiresAt"] = "", 0
	if err := saveNotificationState(state); err != nil {
		return nil, err
	}
	if err := syncNotificationConversation(source, target, true); err != nil {
		return nil, err
	}
	return object{"target": target, "reachability": "verified", "reason": "handshake-confirmed", "identityResolution": resolution}, nil
}

func notificationSafeLocalAccount(ctx context.Context, profile string) object {
	row := object{"available": false, "reason": "auth-status-unavailable"}
	if notificationClaudeIdentityStatus != nil {
		facts, err := notificationClaudeIdentityStatus(ctx, profile)
		if err != nil {
			row["reason"] = err.Error()
		} else {
			delete(row, "reason")
			if logged, ok := facts["loggedIn"].(bool); ok {
				row["loggedIn"], row["available"] = logged, true
			}
			for _, key := range []string{"email", "authMethod"} {
				if v, ok := facts[key].(string); ok {
					r := []rune(v)
					row[key], row["available"] = string(r[:min(len(r), 320)]), true
				}
			}
		}
	}
	row["accountId"], row["observedAt"] = profile, now()
	return row
}
