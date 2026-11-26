package core

import (
	"fmt"
	"slices"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/shared"
)

var sourcePresets = sync.OnceValue(func() []any {
	var rows []any
	if err := canonjson.Unmarshal(shared.ControlSources, &rows); err != nil {
		panic(err)
	}
	return rows
})

func sourcePreset(source string) object {
	if preset := find(sourcePresets(), "id", source); preset != nil {
		return preset
	}
	return object{"id": source, "platform": "custom", "displayName": source, "curated": false, "status": "custom", "recommendedTransport": "https", "recommendedAuth": "bearer", "caveat": object{"en": "Check the client's transport and auth support; unknown sources remain valid."}}
}

func sourceDefaultName(source string, names []string) string {
	base := text(sourcePreset(source), "displayName")
	candidate := base
	for suffix := 2; slices.Contains(names, candidate); suffix++ {
		candidate = fmt.Sprintf("%s %d", base, suffix)
	}
	return candidate
}

func limitWait(origin, args object) object {
	source := text(origin, "controlSource")
	preset := sourcePreset(source)
	limit, ok := uintValue(preset["waitTimeoutMs"])
	requested := uintOr(args["timeoutMs"], 30000)
	if !ok || requested <= limit {
		return nil
	}
	args["timeoutMs"] = limit
	return object{"controlSource": source, "requestedTimeoutMs": requested, "timeoutMs": limit, "capped": true, "reason": preset["waitTimeoutReason"], "hint": "Continue long tasks in multiple waits using next.args and the previous snapshotHash as expectedHash."}
}
