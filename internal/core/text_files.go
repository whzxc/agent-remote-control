package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func readUTF8File(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err == nil && !utf8.Valid(data) {
		return nil, errors.New("stream did not contain valid UTF-8")
	}
	return data, err
}

func putTextFile(ctx context.Context, service *service, operation string, args object) (object, error) {
	path := text(args, "path")
	if !filepath.IsAbs(path) {
		project, err := resolveProjectArgs(ctx, service, args)
		if err != nil {
			return nil, err
		}
		path = filepath.Join(text(project, "root"), path)
	}
	if err := checkProtectedPath(path); err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err == nil {
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			return nil, err
		}
	}
	if err := checkProtectedPath(path); err != nil {
		return nil, err
	}
	result, err := replaceTextFile(path, operation, args)
	if err != nil {
		return nil, err
	}
	project := filepath.Dir(path)
	if _, supplied := args["project"].(string); supplied {
		if resolved, err := resolveProjectArgs(ctx, service, args); err == nil {
			project = text(resolved, "root")
		}
	} else if root, err := projectGitString(ctx, project, false, "rev-parse", "--show-toplevel"); err == nil {
		project = strings.TrimSpace(root)
	}
	active, coverage := observeProjectTasks(ctx, service, project)
	result["activityCheck"] = coverage
	if len(active) != 0 {
		result["warning"] = object{"message": "Codex tasks are running in this project; concurrent changes are possible.", "threadIds": active}
	}
	return result, nil
}

func replaceTextFile(path, operation string, args object) (object, error) {
	unlock := lockReceipt(path)
	defer unlock()
	before, err := readUTF8File(path)
	exists := !errors.Is(err, os.ErrNotExist)
	if err != nil && (exists || operation != "write") {
		return nil, err
	}
	if expected, supplied := args["expectedHash"].(string); supplied && (!exists || !strings.EqualFold(expected, hash(before))) {
		return nil, errors.New("HASH_MISMATCH: file missing or content changed")
	}
	content := text(args, "content")
	replacements := 0
	if operation == "edit" {
		content = string(before)
		edits := arr(args["edits"])
		if edits == nil {
			return nil, errors.New("EDITS_REQUIRED")
		}
		for index, edit := range edits {
			old := text(edit, "oldText")
			if old == "" {
				return nil, fmt.Errorf("EDIT_%d: oldText must not be empty", index)
			}
			count := 0
			for offset := range content {
				if strings.HasPrefix(content[offset:], old) {
					count++
				}
			}
			if count == 0 {
				return nil, fmt.Errorf("EDIT_%d: oldText not found", index)
			}
			if count > 1 && field(edit, "replaceAll") != true {
				return nil, fmt.Errorf("EDIT_%d: oldText matches %d locations; provide a unique match or replaceAll", index, count)
			}
			replacements += strings.Count(content, old)
			content = strings.ReplaceAll(content, old, text(edit, "newText"))
		}
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o777); err != nil {
		return nil, err
	}
	temporary := filepath.Join(parent, ".arc-"+id()+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return nil, err
	}
	defer os.Remove(temporary)
	defer file.Close()
	if _, err := file.WriteString(content); err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil {
		if err := file.Chmod(info.Mode()); err != nil {
			return nil, err
		}
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return nil, err
	}
	current, err := readUTF8File(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if exists != (err == nil) || !bytes.Equal(current, before) {
		return nil, errors.New("FILE_CHANGED_DURING_EDIT")
	}
	if err := platform.ReplaceFile(temporary, path); err != nil {
		return nil, err
	}
	oldLines, newLines := fileTextLines(string(before)), fileTextLines(content)
	prefix, suffix := 0, 0
	for prefix < min(len(oldLines), len(newLines)) && oldLines[prefix] == newLines[prefix] {
		prefix++
	}
	for suffix < min(len(oldLines), len(newLines))-prefix && oldLines[len(oldLines)-suffix-1] == newLines[len(newLines)-suffix-1] {
		suffix++
	}
	return object{"path": path, "sha256": hash([]byte(content)), "created": !exists,
		"diff": object{"changed": string(before) != content, "replacements": replacements, "startLine": prefix + 1,
			"removedLines": len(oldLines) - prefix - suffix, "addedLines": len(newLines) - prefix - suffix,
			"summary": "changed line span (common prefix/suffix excluded)"}}, nil
}

func fileTextLines(value string) []string {
	if value == "" {
		return nil
	}
	lines := strings.Split(value, "\n")
	for index := range len(lines) - 1 {
		lines[index] = strings.TrimSuffix(lines[index], "\r")
	}
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func observeProjectTasks(ctx context.Context, service *service, rootPath string) ([]any, string) {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var cursor any
	seen := map[string]bool{}
	active := []any{}
	coverage := "observed"
	for {
		value, err := requestCodexNative(wait, service, "thread/list",
			object{"limit": 100, "cursor": cursor, "sortKey": "updated_at", "sortDirection": "desc"}, 3*time.Second)
		if err != nil || wait.Err() != nil {
			return active, "unavailable"
		}
		for _, thread := range arr(field(value, "data")) {
			cwd := text(thread, "cwd")
			if cwd == "" {
				continue
			}
			if canonical, err := filepath.EvalSymlinks(cwd); err == nil {
				cwd = canonical
			}
			if !projectContains(rootPath, cwd) {
				continue
			}
			status := field(thread, "status")
			if status == "active" || field(status, "type") == "active" {
				active = append(active, field(thread, "id"))
				continue
			}
			read, err := requestCodexNative(wait, service, "thread/read",
				object{"threadId": field(thread, "id"), "includeTurns": false}, 2*time.Second)
			switch observed := text(field(field(read, "thread"), "status"), "type"); {
			case err == nil && observed == "active":
				active = append(active, field(thread, "id"))
			case err == nil && observed == "idle":
			default:
				coverage = "partial"
			}
		}
		cursor = field(value, "nextCursor")
		if cursor == nil {
			break
		}
		key := wire(cursor)
		if seen[key] {
			coverage = "partial"
			break
		}
		seen[key] = true
	}
	if wait.Err() != nil {
		return active, "unavailable"
	}
	return active, coverage
}

func init() {
	for _, op := range []string{"write", "edit"} {
		registerOperation(op, func(ctx context.Context, request operationRequest) (any, error) {
			return runControlMutation(ctx, request, op, request.args, func(ctx context.Context, row object) (any, error) {
				return putTextFile(ctx, request.service, op, obj(row["arguments"]))
			})
		}, nil)
	}
}
