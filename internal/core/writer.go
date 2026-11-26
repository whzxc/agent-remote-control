package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

func probeWriterPath(path string) object {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return object{"state": "unheld", "evidence": "lock-absent"}
	}
	if err != nil {
		return object{"state": "unknown", "reason": err.Error()}
	}
	defer file.Close()
	locked, err := platform.TryFileLock(file, runtime.GOOS == "windows")
	if err != nil {
		return object{"state": "unknown", "reason": err.Error()}
	}
	state := "unheld"
	if !locked {
		state = "held"
	}
	return object{"state": state, "evidence": "native-writer-file-lock"}
}

func writerLockPath(home, thread string) (string, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return "", errors.New("INVALID_THREAD_ID")
	}
	if home == "" {
		return "", errors.New("CODEX_HOME_UNAVAILABLE")
	}
	return filepath.Join(home, "thread-writer-locks", thread+".lock"), nil
}

func probeWriter(home, thread string) object {
	path, err := writerLockPath(home, thread)
	if err != nil {
		return object{"state": "unknown", "reason": "lock-location-unavailable"}
	}
	return probeWriterPath(path)
}

func writerBusy(thread string, ownership object) object {
	return object{
		"code":      "THREAD_WRITER_BUSY",
		"message":   "The native thread writer is held by another owner. The requested operation did not complete. Inspect codex_owner; finish or archive this exact thread in its owning session before retrying.",
		"retryable": false,
		"ownership": ownership,
		"next": object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread},
			"hint": "Inspect the current owner and follow its exact-thread handoff step before retrying."},
	}
}

func writerProcesses(ctx context.Context, home, thread string) []object {
	result := []object{}
	if runtime.GOOS == "windows" {
		return result
	}
	path, err := writerLockPath(home, thread)
	if err != nil {
		return result
	}
	lsof := "lsof"
	if runtime.GOOS == "darwin" {
		lsof = "/usr/sbin/lsof"
	}
	probe, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	output, _ := commandOutput(probe, lsof, "-t", "--", path)
	cancel()
	pids := make([]string, 0, 16)
	for line := range strings.SplitSeq(output, "\n") {
		pid, err := strconv.ParseUint(line, 10, 32)
		if err == nil {
			pids = append(pids, strconv.FormatUint(pid, 10))
		}
		if len(pids) == 16 {
			break
		}
	}
	if len(pids) == 0 {
		return result
	}
	probe, cancel = context.WithTimeout(ctx, 800*time.Millisecond)
	output, _ = commandOutput(probe, "ps", "-p", strings.Join(pids, ","), "-o", "pid=", "-o", "comm=")
	cancel()
	for line := range strings.SplitSeq(output, "\n") {
		line = strings.TrimSpace(line)
		separator := strings.IndexFunc(line, unicode.IsSpace)
		if separator < 0 {
			continue
		}
		pid, err := strconv.ParseUint(line[:separator], 10, 32)
		if err != nil {
			continue
		}
		executable := strings.TrimSpace(line[separator:])
		var app any
		if prefix, _, found := strings.Cut(executable, ".app/"); found {
			app = prefix + ".app"
		}
		result = append(result, object{"pid": pid, "executable": executable, "app": app, "evidence": "open-descriptor-on-held-writer-lock"})
	}
	return result
}

func writerReleaseStep(thread string, ownership object) object {
	switch {
	case ownership["owner"] == "connector":
		if ownership["runtimeStatus"] == "idle" {
			return object{"via": "act", "op": "codex_release", "args": object{"threadId": thread},
				"hint": "Release this idle ARC connector-owned writer. To archive it instead, use codex_archive with this threadId and release:true. The bundled executable's app path does not identify the writer owner."}
		}
		return object{"via": "query", "op": "codex_read", "args": object{"threadId": thread, "statusOnly": true},
			"hint": "Inspect this ARC connector-owned turn. Finish or explicitly interrupt it before codex_release; codex_archive with release:true also requires an idle thread."}
	case ownership["owner"] == "shared-app-server" || ownership["origin"] == "shared-app-server":
		return object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread},
			"hint": "The shared Codex app-server holds the writer. Its subscribing client is unknown. Check this thread again after native unload or release by its owning client."}
	case ownership["owner"] != "desktop":
		return object{"via": "query", "op": "codex_owner", "args": object{"threadId": thread},
			"hint": "Check ownership again after the reported process releases this thread. Its session is managed on the owning side."}
	default:
		return object{"via": "act", "op": "task_open", "args": object{"agent": "codex", "id": thread},
			"hint": "In the owning ChatGPT/Codex app, select this exact thread and choose Archive from its thread menu. Closing the ARC panel or unsubscribing ARC does not release a Desktop writer. If the owner is an external terminal, end that exact native session normally. Do not kill a shared app-server or delete locks. Re-probe codex_owner before retrying archive."}
	}
}
