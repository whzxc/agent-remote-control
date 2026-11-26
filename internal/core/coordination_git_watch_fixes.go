package core

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

func coordinationFixCommit(message string) bool {
	title, _, _ := strings.Cut(message, "\n")
	if strings.HasPrefix(title, "fix: ") || strings.HasPrefix(title, "fix!: ") {
		return true
	}
	rest, ok := strings.CutPrefix(title, "fix(")
	_, suffix, closed := strings.Cut(rest, ")")
	return ok && closed && (strings.HasPrefix(suffix, ": ") || strings.HasPrefix(suffix, "!: "))
}

func coordinationFixLinked(message string, row object) bool {
	turn := text(row, "turnId")
	if turn == "" {
		return false
	}
	for line := range strings.Lines(message) {
		if strings.TrimSpace(line) == "ARC-Turn: "+turn {
			return true
		}
	}
	return false
}

func coordinationFixFiles(row object) []string {
	paths := []string{}
	for _, entry := range arr(row["files"]) {
		if path, ok := field(entry, "path").(string); ok {
			paths = append(paths, path)
		}
	}
	return axSet(paths)
}

func coordinationFixOverlap(rows []object, commit object, common, branch string, continuous bool) []object {
	changed := coordinationFixFiles(commit)
	at, err := time.Parse(time.RFC3339Nano, text(commit, "committedAt"))
	result := []object{}
	if err != nil {
		return result
	}
	message := text(commit, "message")
	for _, row := range rows {
		if row["commonDir"] != common {
			continue
		}
		end, err := time.Parse(time.RFC3339Nano, text(row, "endedAt"))
		if err != nil || !at.After(end) || at.After(end.Add(14*24*time.Hour)) || !coordinationFixCommit(message) && !coordinationFixLinked(message, row) {
			continue
		}
		overlap := []string{}
		for _, path := range coordinationFixFiles(row) {
			if slices.Contains(changed, path) {
				overlap = append(overlap, path)
			}
		}
		if len(overlap) == 0 {
			continue
		}
		shared := slices.ContainsFunc(rows, func(other object) bool {
			if other["threadId"] == row["threadId"] && other["turnId"] == row["turnId"] || other["commonDir"] != common {
				return false
			}
			start, err := time.Parse(time.RFC3339Nano, text(other, "capturedAt"))
			if err != nil || start.After(at) {
				return false
			}
			otherFiles := coordinationFixFiles(other)
			if slices.ContainsFunc(overlap, func(path string) bool { return slices.Contains(otherFiles, path) }) {
				return true
			}
			if arr(other["files"]) != nil {
				return false
			}
			otherEnd, endErr := time.Parse(time.RFC3339Nano, text(other, "endedAt"))
			rowStart, startErr := time.Parse(time.RFC3339Nano, text(row, "capturedAt"))
			return endErr != nil || startErr != nil || !otherEnd.Before(rowStart)
		})
		var count any
		coverage := "unknown"
		if continuous && row["dirty"] == false && row["renamed"] != true && commit["renamed"] != true && arr(row["files"]) != nil && !shared {
			count, coverage = len(overlap), "bounded"
		}
		result = append(result, object{"threadId": row["threadId"], "turnId": row["turnId"], "commit": commit["commit"], "ref": branch, "overlapCount": count, "coverage": coverage})
	}
	return result
}

var coordinationFixWrite sync.Mutex

func observeCoordinationFixes(ctx context.Context, root, common, branch, before, after string, continuous bool, rows []object, path string) error {
	log, err := coordinationLocalGit(ctx, root, "log", "-65", "--format=%H", before+".."+after)
	if err != nil {
		return err
	}
	ids := strings.Fields(log)
	complete := continuous && len(ids) <= 64 && len(rows) < 128
	correlations := []object{}
	for _, oid := range ids[:min(64, len(ids))] {
		if !coordinationOIDPattern.MatchString(oid) {
			return errors.New("invalid-object-id")
		}
		raw, err := coordinationLocalGit(ctx, root, "show", "--format=%cI%x00%B%x00", "--name-status", "-z", "--find-renames", oid, "--")
		if err != nil {
			return err
		}
		if len(raw) > 256*1024 {
			return errors.New("fix-evidence-capacity")
		}
		at, rest, _ := strings.Cut(raw, "\x00")
		message, rest, _ := strings.Cut(rest, "\x00")
		if !coordinationFixCommit(message) && !slices.ContainsFunc(rows, func(row object) bool { return coordinationFixLinked(message, row) }) {
			continue
		}
		tokens := strings.Split(rest, "\x00")
		tokens = slices.DeleteFunc(tokens, func(value string) bool { return value == "" })
		var paths []any
		renamed := false
		for len(tokens) > 0 {
			status := strings.TrimSpace(tokens[0])
			tokens = tokens[1:]
			count := 1
			if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
				renamed = true
				count = 2
			}
			count = min(count, len(tokens))
			for _, path := range tokens[:count] {
				paths = append(paths, object{"path": path})
			}
			tokens = tokens[count:]
		}
		commit := object{"commit": oid, "committedAt": at, "message": message, "files": paths, "renamed": renamed}
		correlations = append(correlations, coordinationFixOverlap(rows, commit, common, branch, complete)...)
	}
	coordinationFixWrite.Lock()
	defer coordinationFixWrite.Unlock()
	value, err := cachedLoad(path)
	state := obj(value)
	if errors.Is(err, os.ErrNotExist) {
		state = object{"correlations": []any{}}
	} else if err != nil {
		return err
	}
	entries := arr(state["correlations"])
	if entries == nil {
		return errors.New("fix-correlation-state-unavailable")
	}
	for _, entry := range correlations {
		if !slices.ContainsFunc(entries, func(existing any) bool {
			return field(existing, "threadId") == entry["threadId"] && field(existing, "turnId") == entry["turnId"] && field(existing, "commit") == entry["commit"]
		}) {
			entries = append(entries, entry)
		}
	}
	state["correlations"], state["coverage"] = entries[max(0, len(entries)-512):], "bounded"
	return save(path, state)
}

func coordinationFixSummary(ctx context.Context, rows []object, path string) object {
	value, _ := cachedJSONWithRuntimeCost(path, currentRuntimeCost(ctx))
	cost := currentRuntimeCost(ctx)
	selected := map[[2]string]bool{}
	for _, row := range rows {
		if cost != nil {
			cost.rows.Add(1)
		}
		selected[[2]string{text(row, "threadId"), text(row, "turnId")}] = true
	}
	details := []any{}
	entries := arr(field(value, "correlations"))
	matches, unknown, retained := 0, 0, 0
	for _, row := range entries[:min(512, len(entries))] {
		if cost != nil {
			cost.rows.Add(1)
		}
		if !selected[[2]string{text(row, "threadId"), text(row, "turnId")}] {
			continue
		}
		retained++
		if uintOr(field(row, "overlapCount"), 0) > 0 {
			matches++
		}
		if field(row, "coverage") == "unknown" {
			unknown++
		}
		if len(details) < 16 {
			details = append(details, row)
		}
	}
	coverage := "unknown"
	if retained > 0 {
		coverage = "bounded"
	}
	return object{"kind": "correlation", "coverage": coverage, "matches": matches, "unknown": unknown, "retained": retained, "details": details, "limit": 512,
		"interpretation": "Fix-path overlap is correlation only; unobserved history remains unknown."}
}
