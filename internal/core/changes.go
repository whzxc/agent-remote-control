package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func nativeChangeBaselinePath(thread, turn string) string {
	return filepath.Join(root(), "changes", hash([]byte(thread)), hash([]byte(turn))+".json")
}

func captureNativeChangeBaseline(ctx context.Context, cwd string) object {
	unavailable := func(err error) object {
		return object{"cwd": cwd, "unavailable": err.Error(), "capturedAt": now()}
	}
	if !filepath.IsAbs(cwd) {
		return unavailable(errors.New("workspace unavailable"))
	}
	git := func(args ...string) (string, error) {
		return projectGit(ctx, cwd, args...)
	}
	dir, err := git("rev-parse", "--show-toplevel")
	if err != nil {
		return unavailable(err)
	}
	status, err := git("status", "--porcelain=v1", "-z")
	if err != nil {
		return unavailable(err)
	}
	head, _ := git("rev-parse", "--verify", "HEAD")
	branch, _ := git("symbolic-ref", "-q", "HEAD")
	common, _ := git("rev-parse", "--path-format=absolute", "--git-common-dir")
	var commonDir any
	if name, err := filepath.EvalSymlinks(strings.TrimSpace(common)); err == nil && common != "" {
		commonDir = name
	}
	return object{"cwd": cwd, "root": strings.TrimSpace(dir), "head": dispatchFirstString(strings.TrimSpace(head)),
		"ref": dispatchFirstString(strings.TrimSpace(branch)), "commonDir": commonDir, "dirty": status != "",
		"capturedAt": now(), "source": "before-turn-submission"}
}

func recordNativeChangeBaseline(thread, turn string, baseline object) error {
	if thread == "" || turn == "" || baseline == nil {
		return nil
	}
	path := nativeChangeBaselinePath(thread, turn)
	unlock := lockReceipt(path)
	if _, err := os.Stat(path); err == nil {
		unlock()
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		unlock()
		return err
	}
	row := clone(baseline)
	row["threadId"], row["turnId"] = thread, turn
	marker, _ := load(nativeChangeMarkerPath(thread, turn))
	if marker != nil {
		row["endedAt"] = field(marker, "observedAt")
	}
	err := save(path, row)
	unlock()
	if err != nil {
		return err
	}
	observeCoordinationBaseline(row)
	if marker != nil {
		nativeChangeEvidence(context.Background(), thread, turn, text(row, "cwd"), true)
	}
	return nil
}

func nativeChangeSnapshotPath(thread, turn string) string {
	return filepath.Join(root(), "change-snapshots", hash([]byte(thread)), hash([]byte(turn))+".json")
}

func nativeChangeMarkerPath(thread, turn string) string {
	return strings.TrimSuffix(nativeChangeSnapshotPath(thread, turn), ".json") + ".terminal"
}

func isNativeTerminal(turn any) bool {
	return slices.Contains([]string{"completed", "failed", "interrupted", "cancelled"}, text(turn, "status"))
}

func unavailableNativeChanges(thread, turn, reason string) object {
	return object{"threadId": thread, "turnId": turn, "files": nil, "summary": nil, "commits": nil, "fallback": true,
		"reason": reason, "changeEvidence": "unavailable", "next": object{"op": nil,
			"hint": "Restore the original workspace and recorded baseline, or inspect the turn's commits in the repository. A missing terminal snapshot cannot be reconstructed from the current workspace alone."}}
}

func captureTerminalNativeChanges(ctx context.Context, thread, turn string) {
	if thread == "" || turn == "" {
		return
	}
	path := nativeChangeBaselinePath(thread, turn)
	unlock := lockReceipt(path)
	if _, err := os.Stat(nativeChangeSnapshotPath(thread, turn)); err == nil {
		unlock()
		return
	}
	marker := nativeChangeMarkerPath(thread, turn)
	ended := now()
	if previous, err := load(marker); err == nil {
		ended = nonemptyTaskText(text(previous, "observedAt"), ended)
	} else if err := save(marker, object{"observedAt": ended}); err != nil {
		unlock()
		recordLog("WARN", err.Error(), nil)
		return
	}
	value, _ := load(path)
	baseline := obj(value)
	if baseline != nil && baseline["endedAt"] == nil {
		baseline["endedAt"] = ended
		if err := save(path, baseline); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
	}
	unlock()
	if baseline != nil {
		nativeChangeEvidence(ctx, thread, turn, text(baseline, "cwd"), true)
	}
}

func nativeChangeEvidence(ctx context.Context, thread, turn, cwd string, terminal bool) object {
	snapshot := nativeChangeSnapshotPath(thread, turn)
	unlock := lockReceipt(snapshot)
	defer unlock()
	if value, err := load(snapshot); err == nil && obj(value) != nil {
		return obj(value)
	}
	path := nativeChangeBaselinePath(thread, turn)
	value, _ := load(path)
	baseline := obj(value)
	if baseline == nil || baseline["unavailable"] != nil {
		return unavailableNativeChanges(thread, turn, "turn-baseline-unavailable")
	}
	entries, _ := cachedEntries(filepath.Dir(path))
	var next object
	for _, entry := range entries {
		if filepath.Ext(entry.path) != ".json" || entry.path == path {
			continue
		}
		raw, err := cachedLoad(entry.path)
		at := text(raw, "capturedAt")
		if err == nil && field(raw, "root") == baseline["root"] && at > text(baseline, "capturedAt") &&
			(next == nil || at < text(next, "capturedAt")) {
			next = obj(raw)
		}
	}
	end := text(next, "head")
	if next != nil && (next["dirty"] == true || end == "") {
		return unavailableNativeChanges(thread, turn, "historical-turn-end-unavailable: next baseline is dirty or has no commit")
	}
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	result, err := queryNativeChangeWorkspace(wait, thread, turn, cwd, baseline, end)
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return unavailableNativeChanges(thread, turn, "change-snapshot-timeout (5s)")
	}
	if err != nil {
		return unavailableNativeChanges(thread, turn, "workspace-or-git-evidence-unavailable")
	}
	if terminal && result["fallback"] == false {
		result["changeEvidence"] = "terminal-git-snapshot"
		if err := save(snapshot, result); err != nil {
			result["persistenceError"], result["changeEvidence"] = err.Error(), "live-git-baseline: snapshot persistence failed"
		}
		applyChangeCoordinationEvidence(baseline, result)
		observeCoordinationBaseline(baseline)
	}
	return result
}

func applyChangeCoordinationEvidence(baseline, evidence object) {
	baseline["files"] = evidence["files"]
	baseline["renamed"] = slices.ContainsFunc(decodedTaskList(evidence["files"]), func(file any) bool {
		return field(file, "renamed") == true
	})
}

func retainedNativeChangeBaselines() ([]object, error) {
	rows := []object{}
	owners, err := cachedEntries(filepath.Join(root(), "changes"))
	if err != nil {
		return nil, err
	}
	since := time.Now().Add(-14 * 24 * time.Hour)
	for _, owner := range owners[:min(128, len(owners))] {
		if !owner.kind.IsDir() {
			continue
		}
		files, err := cachedEntries(owner.path)
		if err != nil {
			continue
		}
		for _, file := range files[:min(128, len(files))] {
			if filepath.Ext(file.path) != ".json" {
				continue
			}
			value, err := cachedLoad(file.path)
			if err != nil || nativeConversationTime(obj(value), "endedAt").Before(since) {
				continue
			}
			baseline := clone(obj(value))
			path := nativeChangeSnapshotPath(text(value, "threadId"), text(value, "turnId"))
			if snapshot, err := cachedLoad(path); err == nil {
				applyChangeCoordinationEvidence(baseline, obj(snapshot))
			}
			rows = append(rows, baseline)
			if len(rows) == 128 {
				return rows, nil
			}
		}
	}
	return rows, nil
}

func nativeChangeGitRows(raw string, titleLimit int) []any {
	rows := []any{}
	for _, line := range fileTextLines(raw) {
		sha, title, found := strings.Cut(line, "\x00")
		if found {
			if titleLimit > 0 {
				title = runeExcerpt(title, titleLimit)
			}
			rows = append(rows, object{"sha": sha, "title": title})
		}
	}
	return rows
}

func nativeChangeNumstat(raw string) []any {
	parts := strings.Split(raw, "\x00")
	files := []any{}
	number := func(raw string) any {
		if value, err := strconv.ParseUint(raw, 10, 64); err == nil {
			return value
		}
		return nil
	}
	for i := 0; i < len(parts); i++ {
		tabs := strings.SplitN(parts[i], "\t", 3)
		if len(tabs) != 3 {
			continue
		}
		file := tabs[2]
		renamed := file == ""
		if renamed && i+2 < len(parts) {
			file, i = parts[i+2], i+2
		}
		files = append(files, object{"path": file, "added": number(tabs[0]), "removed": number(tabs[1]), "binary": tabs[0] == "-", "renamed": renamed})
	}
	return files
}

func queryNativeChangeWorkspace(ctx context.Context, thread, turn, cwd string, baseline object, end string) (object, error) {
	recordedDirectory, err := filepath.EvalSymlinks(text(baseline, "cwd"))
	if err != nil {
		return nil, err
	}
	actual, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, err
	}
	rootPath, err := projectGit(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, err
	}
	repository := strings.TrimSpace(rootPath)
	git := func(args ...string) (string, error) { return projectGit(ctx, repository, args...) }
	start := text(baseline, "head")
	if recordedDirectory != actual || baseline["capturedAt"] == nil {
		return unavailableNativeChanges(thread, turn, "turn-baseline-does-not-match-workspace"), nil
	}
	if start != "" {
		if _, err := git("cat-file", "-e", start); err != nil {
			return unavailableNativeChanges(thread, turn, "turn-baseline-does-not-match-workspace"), nil
		}
	}
	head := end
	if head == "" {
		value, _ := git("rev-parse", "--verify", "HEAD")
		head = strings.TrimSpace(value)
	}
	emptyTree, err := git("hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return nil, err
	}
	base := nonemptyTaskText(start, strings.TrimSpace(emptyTree))
	commits := []any{}
	if head != "" {
		argument := head
		if start != "" {
			argument = start + ".." + head
		}
		raw, err := git("log", "--format=%H%x00%s", argument)
		if err != nil {
			return nil, err
		}
		commits = nativeChangeGitRows(raw, 0)
	}
	diffArgs := []string{"diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", base}
	if end != "" {
		diffArgs = append(diffArgs, end)
	}
	raw, err := git(append(diffArgs, "--")...)
	if err != nil {
		return nil, err
	}
	files := nativeChangeNumstat(raw)
	dirty := false
	if end == "" {
		untracked, err := git("ls-files", "--others", "--exclude-standard", "-z")
		if err != nil {
			return nil, err
		}
		for file := range strings.SplitSeq(untracked, "\x00") {
			if file == "" {
				continue
			}
			data, err := projectReadBytes(repository, file)
			binary := err != nil || !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00')
			var added any
			if !binary {
				added = len(fileTextLines(string(data)))
			}
			files = append(files, object{"path": file, "added": added, "removed": 0, "untracked": true, "binary": binary})
		}
		status, err := git("status", "--porcelain=v1", "-z")
		if err != nil {
			return nil, err
		}
		dirty = status != ""
	}
	var added, removed, binary uint64
	for _, file := range files {
		added += uintOr(field(file, "added"), 0)
		removed += uintOr(field(file, "removed"), 0)
		if field(file, "binary") == true {
			binary++
		}
	}
	return object{"threadId": thread, "turnId": turn, "baseline": baseline, "fallback": false, "mode": "since-turn-start", "reason": nil,
		"head": dispatchFirstString(head), "base": base, "workspaceDirty": dirty, "commitCount": len(commits), "commits": commits, "files": files,
		"summary": object{"files": len(files), "added": added, "removed": removed, "binaryOrUnreadable": binary},
		"root":    repository, "changeEvidence": "live-git-baseline", "observedAt": now(),
		"attribution": "workspace changes may include other tasks and pre-existing dirty files"}, nil
}

func queryNativeChanges(ctx context.Context, r operationRequest) (any, error) {
	thread, selected := text(r.args, "threadId"), text(r.args, "turnId")
	if selected != "" {
		if value, err := load(nativeChangeSnapshotPath(thread, selected)); err == nil {
			return nativeChangePage(ctx, obj(value), r.args), nil
		}
	}
	task, err := readCodexMetadata(ctx, r.service, thread)
	if err != nil {
		return nil, err
	}
	if task["id"] != thread {
		return nil, errors.New("native-thread-id-mismatch")
	}
	page, err := readCodexTurnPage(ctx, r.service, object{"threadId": thread, "turnId": r.args["turnId"]})
	if err != nil {
		return nil, err
	}
	turns := arr(page["data"])
	var turn any
	if len(turns) != 0 {
		turn = turns[0]
	}
	value := nativeChangeEvidence(ctx, thread, text(turn, "id"), text(task, "cwd"), isNativeTerminal(turn))
	return nativeChangePage(ctx, value, r.args), nil
}

func nativeChangePage(ctx context.Context, value, args object) object {
	if value == nil {
		return nil
	}
	limit := max(1, min(100, uintOr(args["limit"], 10)))
	offset := uintOr(args["offset"], 0)
	file, wantPatch := args["path"].(string)
	if commits := arr(value["commits"]); commits != nil {
		count := uint64(len(commits))
		start := min(offset, count)
		if wantPatch {
			start = 0
		}
		end := min(start+limit, count)
		value["commits"], value["nextOffset"] = commits[start:end], nil
		if end < count && !wantPatch {
			value["nextOffset"] = end
		}
	}
	if !wantPatch {
		return value
	}
	diffArgs := []string{"diff", "--no-ext-diff", "--no-textconv", text(value, "base")}
	common, directory := text(value["baseline"], "commonDir"), text(value, "root")
	var patch string
	var err error
	switch {
	case value["fallback"] == false && value["workspaceDirty"] == false && common != "":
		diffArgs = append(diffArgs, text(value, "head"), "--", file)
		patch, err = projectGit(ctx, common, append([]string{"--git-dir", common}, diffArgs...)...)
	case value["changeEvidence"] == "live-git-baseline":
		patch, err = projectGit(ctx, directory, append(diffArgs, "--", file)...)
		for _, raw := range arr(value["files"]) {
			if field(raw, "path") != file || field(raw, "untracked") != true {
				continue
			}
			var data []byte
			data, err = projectReadBytes(directory, file)
			if err == nil {
				patch = "Binary file " + file + " is untracked\n"
				if utf8.Valid(data) && !strings.ContainsRune(string(data), '\x00') {
					lines := fileTextLines(string(data))
					var result strings.Builder
					result.WriteString("--- /dev/null\n+++ b/" + file + "\n@@ -0,0 +1," + strconv.Itoa(len(lines)) + " @@\n")
					for _, line := range lines {
						result.WriteString("+" + line + "\n")
					}
					if len(data) != 0 && data[len(data)-1] != '\n' {
						result.WriteString("\\ No newline at end of file\n")
					}
					patch = result.String()
				}
			}
			break
		}
	default:
		err = errors.New("snapshot-patch-unavailable")
	}
	if err != nil {
		value["diff"] = nil
		value["diffUnavailable"] = "The snapshot retains file statistics, but the patch is uncommitted or its Git objects are unavailable."
		value["next"] = object{"op": nil, "hint": "Inspect the saved commit range in a repository containing those objects; recover uncommitted content from the original workspace or backups."}
		return value
	}
	units := utf16.Encode([]rune(patch))
	count := uint64(len(units))
	start := min(offset, count)
	end := start + min(count-start, min(65536, uintOr(args["length"], 16000)))
	var next any
	if end < count {
		next = end
	}
	value["diff"] = object{"path": file, "text": string(utf16.Decode(units[start:end])), "offset": offset,
		"nextOffset": next, "characters": count, "sha256": hash([]byte(patch))}
	return value
}

func reviewNativeChangeEvidence(ctx context.Context, thread string, turn any) object {
	turnID := text(turn, "id")
	baseline, _ := load(nativeChangeBaselinePath(thread, turnID))
	evidence := nativeChangeEvidence(ctx, thread, turnID, text(baseline, "cwd"), isNativeTerminal(turn))
	if evidence["fallback"] == false {
		files := []object{}
		for _, file := range arr(evidence["files"]) {
			files = append(files, selectFields(obj(file), "path", "added", "removed"))
		}
		return object{"files": files, "changeEvidence": evidence["changeEvidence"], "attribution": evidence["attribution"]}
	}
	if files := nativeReviewFiles(arr(field(turn, "items"))); files != nil {
		return object{"files": files, "changeEvidence": "native-file-changes", "attribution": nil}
	}
	return evidence
}

func nativeNotificationChanges(ctx context.Context, s *service, thread, turn string) any {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	value, err := queryNativeChanges(wait, operationRequest{service: s, args: object{"threadId": thread, "turnId": turn, "limit": 5}})
	if err != nil {
		reason := runeExcerpt(err.Error(), 200)
		if errors.Is(wait.Err(), context.DeadlineExceeded) {
			reason = "change-summary-timeout (5s)"
		}
		return object{"unavailable": reason, "observedAt": now()}
	}
	evidence := obj(value)
	if evidence["files"] == nil {
		return object{"commits": nil, "summary": nil, "unavailable": evidence["reason"], "next": evidence["next"], "observedAt": now()}
	}
	truncated := evidence["nextOffset"] != nil
	commits := []object{}
	for _, commit := range arr(evidence["commits"]) {
		title := text(commit, "title")
		short := runeExcerpt(title, 120)
		truncated = truncated || short != title
		commits = append(commits, object{"sha": field(commit, "sha"), "title": short})
	}
	result := selectFields(evidence, "commitCount", "summary", "fallback", "observedAt", "attribution")
	result["commits"], result["truncated"] = commits, truncated
	return result
}

func nativeGitProgress(ctx context.Context, thread, turn string) object {
	baseline, _ := load(nativeChangeBaselinePath(thread, turn))
	if baseline == nil {
		return object{"commits": nil, "elapsedMs": nil, "baseline": nil, "unavailable": "turn-baseline-unavailable"}
	}
	result := object{"commits": nil, "elapsedMs": nil, "baseline": field(baseline, "capturedAt")}
	if at := nativeConversationTime(obj(baseline), "capturedAt"); !at.IsZero() {
		result["elapsedMs"] = max(0, time.Since(at).Milliseconds())
	}
	head := text(baseline, "head")
	if head == "" {
		result["unavailable"] = "turn-baseline-has-no-commit"
		return result
	}
	dir, revision := text(baseline, "root"), head+"..HEAD"
	count, err := projectGit(ctx, dir, "rev-list", "--count", revision)
	if err == nil {
		var total uint64
		total, err = strconv.ParseUint(strings.TrimSpace(count), 10, 64)
		if err == nil {
			var log string
			log, err = projectGit(ctx, dir, "log", "-5", "--format=%H%x00%s", revision)
			if err == nil {
				result["commits"] = object{"count": total, "recent": nativeChangeGitRows(log, 160), "scope": "workspace-since-turn-baseline"}
			}
		}
	}
	if err != nil {
		result["unavailable"] = err.Error()
	}
	return result
}

func init() {
	registerOperation("codex_changes", queryNativeChanges, nil)
	coordinationRetainedBaselines = retainedNativeChangeBaselines
	coordinationCaptureTerminalChanges = captureTerminalNativeChanges
	notificationCompletionChanges = nativeNotificationChanges
}
