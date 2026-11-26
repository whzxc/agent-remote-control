package core

import (
	"slices"
	"time"
)

const srcCorrelationSeconds = 600

func resolveSRCReference(conversations []object, account, identifier string) object {
	for _, row := range conversations {
		if row["accountId"] == account && (row["id"] == identifier || slices.Contains(arr(row["aliases"]), any(identifier))) {
			return clone(row)
		}
	}
	return nil
}

func verifiedSRCReference(conversations []object, bindings map[string]object, account string, reference object, at string) []object {
	alias := text(reference, "id")
	if row := resolveSRCReference(conversations, account, alias); row["kind"] == "chat" {
		return conversations
	}
	handshake, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return conversations
	}
	candidate := -1
	for index, row := range conversations {
		if row["accountId"] != account || row["kind"] != "chat" {
			continue
		}
		active, err := time.Parse(time.RFC3339Nano, text(row, "lastActiveAt"))
		age := handshake.UnixMilli() - active.UnixMilli()
		if err != nil || age < 0 || age > srcCorrelationSeconds*1000 {
			continue
		}
		if candidate != -1 {
			return conversations
		}
		candidate = index
	}
	if candidate == -1 {
		return conversations
	}
	chat := clone(conversations[candidate])
	aliases := append(arr(chat["aliases"]), alias)
	slices.SortFunc(aliases, func(a, b any) int {
		left, leftString := a.(string)
		right, rightString := b.(string)
		switch {
		case leftString != rightString:
			if leftString {
				return 1
			}
			return -1
		case left < right:
			return -1
		case left > right:
			return 1
		default:
			return 0
		}
	})
	chat["aliases"] = slices.CompactFunc(aliases, func(a, b any) bool { return wire(a) == wire(b) })
	isCowork := func(row object) bool {
		return row["accountId"] == account && row["kind"] == "cowork" && row["id"] == alias
	}
	for _, cowork := range conversations {
		if !isCowork(cowork) {
			continue
		}
		for _, key := range []string{"firstSeenAt", "lastSeenAt", "lastActiveAt"} {
			current, err := time.Parse(time.RFC3339Nano, text(cowork, key))
			if err != nil {
				continue
			}
			old, err := time.Parse(time.RFC3339Nano, text(chat, key))
			if err != nil || (key == "firstSeenAt" && current.UnixMilli() < old.UnixMilli()) ||
				(key != "firstSeenAt" && current.UnixMilli() > old.UnixMilli()) {
				chat[key] = cowork[key]
			}
		}
	}
	for _, row := range bindings {
		if isCowork(row) {
			for _, key := range []string{"kind", "id", "url"} {
				row[key] = chat[key]
			}
		}
	}
	conversations[candidate] = chat
	return slices.DeleteFunc(conversations, isCowork)
}
