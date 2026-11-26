package core

import (
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const noFileTarget = 8192
const fdWarningRatio = 0.9

var resourceAdjust sync.Mutex
var resourceStartup atomic.Pointer[object]
var initializeResourceLimits = sync.OnceValue(func() object {
	result := ensureNoFile("core-startup")
	resourceStartup.Store(&result)
	return result
})

func inheritedResourceLimits() object {
	initializeResourceLimits()
	return obj(ensureNoFile("app-server-spawn")["actual"])
}

func unknownLimits(reason any) object {
	return object{"state": "unknown", "soft": nil, "hard": nil, "source": "unavailable", "observedAt": nil, "error": reason}
}
func measuredLimits(soft, hard uint64, source string) object {
	limit := func(n uint64) any {
		if platform.NoFileUnlimited(n) {
			return "unlimited"
		}
		return n
	}
	return object{"state": "available", "soft": limit(soft), "hard": limit(hard), "source": source, "observedAt": now(), "error": nil}
}
func currentResourceLimits() object {
	if operatingSystem == "windows" {
		r := unknownLimits(nil)
		r["state"] = "not_applicable"
		return r
	}
	soft, hard, err := platform.NoFileLimits()
	if err != nil {
		return unknownLimits(err.Error())
	}
	return measuredLimits(soft, hard, "self-measured")
}
func meetsResourceTarget(limits object) bool {
	return limits["soft"] == "unlimited" || uintOr(limits["soft"], 0) >= noFileTarget
}
func ensureNoFile(stage string) object {
	resourceAdjust.Lock()
	defer resourceAdjust.Unlock()
	original := currentResourceLimits()
	reasons := []string{}
	report := object{"targetSoft": noFileTarget, "original": original, "actual": original, "attemptedSoft": nil,
		"platformCeiling": nil, "state": "not_applicable", "reasons": reasons, "observedAt": now()}
	if operatingSystem != "windows" {
		ceiling, err := platform.NoFileCeiling()
		if err != nil {
			reasons = append(reasons, err.Error())
		} else if ceiling > 0 {
			report["platformCeiling"] = ceiling
		}
		soft, hard, err := platform.NoFileLimits()
		if err != nil {
			reasons = append(reasons, "getrlimit: "+err.Error())
		} else {
			report["original"] = measuredLimits(soft, hard, "self-measured")
			if hard < noFileTarget {
				reasons = append(reasons, fmt.Sprintf("hard limit %d is below target %d", hard, noFileTarget))
			}
			target := min(hard, noFileTarget)
			if ceiling > 0 {
				target = min(target, ceiling)
			}
			if soft < target {
				report["attemptedSoft"] = target
				if err := platform.SetNoFileLimit(target, hard); err != nil {
					reasons = append(reasons, "setrlimit: "+err.Error())
				}
			}
		}
		actual := currentResourceLimits()
		report["actual"] = actual
		reached := meetsResourceTarget(actual)
		if !reached {
			reasons = append(reasons, fmt.Sprintf("RLIMIT_NOFILE soft target %d not verified", noFileTarget))
		}
		if ceiling > 0 && ceiling < noFileTarget {
			reasons = append(reasons, "platform ceiling is below the target")
		}
		report["state"] = "degraded"
		if reached && (ceiling == 0 || ceiling >= noFileTarget) {
			report["state"] = "ok"
		}
		report["reasons"] = reasons
	}
	level := "INFO"
	if report["state"] == "degraded" {
		level = "WARN"
	}
	recordLog(level, "Resource limits ("+stage+"): "+wire(report), nil)
	return report
}
func coreResourceStatus() object {
	var startup any
	if current := resourceStartup.Load(); current != nil {
		startup = *current
	}
	nofile := currentResourceLimits()
	state := "degraded"
	switch {
	case nofile["state"] == "not_applicable":
		state = "not_applicable"
	case field(startup, "state") == "degraded":
	case nofile["state"] == "unknown":
		state = "unknown"
	case meetsResourceTarget(nofile):
		state = "ok"
	}
	return object{"state": state, "nofile": nofile, "startup": startup}
}
func childResourceStatus(pid int, inherited object, unavailable string) object {
	nofile := unknownLimits(unavailable)
	if inherited != nil {
		nofile = clone(inherited)
	}
	if nofile["state"] == "available" {
		nofile["source"] = "inherited-at-spawn"
	}
	fd := object{"state": "unknown", "count": nil, "sampledAt": nil, "attemptedAt": nil, "error": unavailable}
	if pid > 0 {
		if operatingSystem == "linux" {
			soft, hard, err := platform.ChildFileLimits(pid)
			if err != nil {
				nofile["measurementError"] = err.Error()
			} else {
				nofile = measuredLimits(soft, hard, "child-measured")
			}
		}
		fd["attemptedAt"] = now()
		if count, err := platform.DescriptorCount(pid); err != nil {
			fd["error"] = err.Error()
		} else {
			fd["state"], fd["count"], fd["sampledAt"], fd["error"] = "available", count, now(), nil
		}
	}
	var ratio any
	if count, ok := uintValue(fd["count"]); ok {
		if soft := uintOr(nofile["soft"], 0); soft > 0 {
			ratio = float64(count) / float64(soft)
		}
	}
	state := "unknown"
	switch {
	case operatingSystem == "windows":
		nofile = currentResourceLimits()
		fd["state"], fd["error"] = "not_applicable", nil
		state = "not_applicable"
	case ratio != nil && ratio.(float64) >= fdWarningRatio:
		state = "pressure"
	case nofile["state"] == "available" && !meetsResourceTarget(nofile):
		state = "degraded"
	case fd["state"] == "available" && nofile["state"] == "available":
		state = "ok"
	}
	return object{"state": state, "nofile": nofile, "fd": fd, "usageRatio": ratio, "warningRatio": fdWarningRatio}
}
