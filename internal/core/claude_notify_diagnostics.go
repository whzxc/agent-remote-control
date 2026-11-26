package core

import "slices"

func notificationTurnDiagnosis(bind object) object {
	observed := obj(bind["observation"])
	reasons := []any{}
	state := text(observed, "state")
	terminal := slices.Contains([]string{"completed", "failed", "cancelled", "interrupted"}, state)
	if reason, ok := bind["scopeEnd"].(string); ok {
		reasons = append(reasons, reason)
	}
	if successor := text(bind["successor"], "turnId"); successor != "" {
		reason := "successor-not-inherited"
		if field(bind["successor"], "inherited") == true {
			reason = "superseded-turn-inherited"
		}
		reasons = append(reasons, reason)
	}
	if observed["reconciliation"] == "pending-after-restart" {
		reasons = append(reasons, "pending-after-restart")
	} else if !terminal && observed == nil {
		reasons = append(reasons, "pending-observation")
	}
	delivery := arr(bind["deliveries"])
	if terminal && find(delivery, "key", "terminal") == nil {
		reasons = append(reasons, "no-terminal-delivery")
	}
	if len(delivery) == 0 {
		if terminal {
			reasons = append(reasons, "no-terminal-delivery")
		} else {
			reasons = append(reasons, "awaiting-observable-transition")
		}
	} else if find(delivery, "status", "pending") != nil || find(delivery, "status", "sending") != nil {
		reasons = append(reasons, "delivery-pending")
	} else {
		reasons = append(reasons, "delivery-recorded")
	}
	for _, d := range delivery {
		reason := field(field(d, "timing"), "queueReason")
		if field(d, "status") == "pending" && reason != nil && !slices.Contains(reasons, reason) {
			reasons = append(reasons, reason)
		}
	}
	retry := obj(bind["retry"])
	return object{"reasons": reasons, "terminal": terminal, "scope": object{"threadId": bind["threadId"], "sourceId": bind["sourceId"],
		"active": bind["scopeEnd"] == nil, "endedBy": bind["scopeEnd"]}, "successor": bind["successor"], "observation": bind["observation"],
		"retry": object{"status": retry["status"], "reason": retry["reason"], "notBefore": retry["notBefore"], "successorTurnId": retry["successorTurnId"]},
		"next": object{"via": "query", "op": "codex_read", "args": object{"threadId": bind["threadId"], "statusOnly": true},
			"hint": "Read the current native turn. Unknown history remains pending; a new unrelated turn does not inherit this binding."}}
}
