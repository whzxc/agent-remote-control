package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const maxNativeHistoryBytes = 32 << 20

func nativeWriterRejected(err error) bool {
	if err == nil {
		return false
	}
	message, ok := strings.CutPrefix(err.Error(), "RPC_REJECTED:")
	if !ok {
		return false
	}
	var rpc object
	return decodeObject([]byte(message), &rpc) == nil && strings.Contains(text(rpc, "message"), "already has an active writer")
}

var controlDesktopTurns func(object) ([]any, error)

func desktopControlThread(snapshot object, complete bool) (object, error) {
	thread := selectFields(snapshot, "id", "agentNickname", "source", "cwd")
	thread["name"], thread["path"] = snapshot["title"], snapshot["rolloutPath"]
	thread["createdAt"], thread["updatedAt"] = uintOr(snapshot["createdAt"], 0)/1000, uintOr(snapshot["updatedAt"], 0)/1000
	thread["model"], thread["reasoningEffort"], thread["status"] = snapshot["latestModel"], snapshot["latestReasoningEffort"], snapshot["threadRuntimeStatus"]
	thread["runtimeSource"] = "codex-desktop-owner"
	settings := obj(snapshot["latestThreadSettings"])
	if model, exists := settings["model"]; exists {
		thread["model"] = model
	}
	if effort, exists := settings["effort"]; exists {
		thread["reasoningEffort"] = effort
	} else if effort, exists := obj(field(snapshot["latestCollaborationMode"], "settings"))["reasoning_effort"]; exists {
		thread["reasoningEffort"] = effort
	}
	if provider, exists := settings["modelProvider"]; exists {
		thread["modelProvider"] = provider
	}
	if complete {
		turns, err := controlDesktopTurns(snapshot)
		if err != nil {
			return nil, err
		}
		thread["turns"] = turns
	}
	return thread, nil
}

var nativeThreadTitle func(object) string

func summarizeControlThread(thread object) object {
	state := text(thread["status"], "type")
	var runtimeSource any = thread["runtimeSource"]
	if state == "" || state == "notLoaded" {
		state, runtimeSource = "unknown", "persisted-history-only"
	}
	var archived any
	parts := strings.FieldsFunc(text(thread, "path"), func(c rune) bool { return c == '/' || c == '\\' })
	for _, part := range slices.Backward(parts) {
		if part == "sessions" || part == "archived_sessions" {
			archived = part == "archived_sessions"
			break
		}
	}
	var title any = thread["name"]
	if nativeThreadTitle != nil {
		title = nativeThreadTitle(thread)
	}
	effective := func(key string) any {
		if value, ok := thread[key]; ok {
			return value
		}
		return "unknown"
	}
	send, change := "requires-native-ownership-check", "requires-idle"
	switch state {
	case "idle":
		send, change = "new-turn", "new-turn-and-subsequent"
	case "active":
		send = "steer"
	}
	flags, exists := obj(thread["status"])["activeFlags"]
	if !exists {
		flags = []any{}
	}
	result := object{"archived": archived, "threadId": thread["id"], "project": thread["cwd"], "title": title,
		"preview": thread["preview"], "cwd": thread["cwd"], "runtimeStatus": state, "runtimeSource": runtimeSource,
		"configuration": object{"scope": "thread-defaults", "source": "thread/read-or-list", "model": effective("model"),
			"effort": effective("reasoningEffort"), "modelProvider": effective("modelProvider"), "turnEffective": "unknown"},
		"actions":     object{"read": true, "send": send, "interrupt": "native-ownership-check", "configurationChange": change},
		"activeFlags": flags, "updatedAt": thread["updatedAt"], "observedAt": now(), "businessDelivery": "not-assessed"}
	if operatingSystem != "linux" && thread["runtimeSource"] != "connector-app-server" {
		result["desktopUrl"] = "codex://threads/" + text(thread, "id")
	}
	return result
}

func nativeItemKey(thread, turn string, item any) string {
	return hash([]byte(wire([]any{thread, turn, item})))
}

func nativeItemExcerpt(item object, offset, length uint64) object {
	var value string
	switch text(item, "type") {
	case "agentMessage":
		value = text(item, "text")
	case "userMessage":
		rows := []string{}
		for _, part := range arr(item["content"]) {
			if field(part, "type") == "text" {
				rows = append(rows, text(part, "text"))
			}
		}
		value = strings.Join(rows, "\n")
	default:
		value = wire(item)
	}
	units := utf16.Encode([]rune(value))
	count := uint64(len(units))
	start := min(offset, count)
	end := start + min(length, count-start)
	var next any
	if end < count {
		next = end
	}
	return object{"itemId": item["id"], "type": item["type"], "text": string(utf16.Decode(units[start:end])),
		"textHash": hash([]byte(value)), "offset": offset, "textLength": count, "nextOffset": next, "textTruncated": end < count}
}

func compactNativeItem(item object, length int) object {
	projected := object{"type": item["type"]}
	truncated := false
	excerpt := func(raw any) string {
		full := str(raw)
		preview := runeExcerpt(full, length)
		truncated = truncated || len(preview) < len(full)
		return preview
	}
	switch text(item, "type") {
	case "agentMessage":
		projected["text"] = excerpt(item["text"])
	case "userMessage":
		parts := []any{}
		for _, item := range arr(item["content"]) {
			if p := obj(item); p != nil && p["text"] != nil {
				p = clone(p)
				p["text"] = excerpt(p["text"])
				parts = append(parts, p)
			} else {
				parts = append(parts, item)
			}
		}
		projected["content"] = parts
	case "commandExecution":
		projected["command"], projected["exitCode"], projected["status"] = item["command"], item["exitCode"], item["status"]
		projected["output"] = excerpt(item["aggregatedOutput"])
	case "fileChange":
		projected["status"] = item["status"]
		changes := []object{}
		for _, change := range arr(item["changes"]) {
			changes = append(changes, object{"path": field(change, "path"), "kind": field(change, "kind"), "diff": excerpt(field(change, "diff"))})
		}
		projected["changes"] = changes
	case "error":
		for _, key := range []string{"message", "error", "code"} {
			if value, ok := item[key]; ok {
				projected[key] = value
			}
		}
	default:
		return nil
	}
	if truncated {
		projected["truncated"] = true
	}
	return projected
}

func openNativeHistory(home string, thread object) (*os.File, error) {
	path := text(thread, "path")
	sessions, err := filepath.EvalSymlinks(filepath.Join(home, "sessions"))
	if err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if canonical != path || !belowPath(path, sessions) || filepath.Ext(path) != ".jsonl" {
		return nil, errors.New("invalid history path")
	}
	return platform.OpenNativeHistory(path)
}

func readNativeHistory(home string, thread object) (string, error) {
	file, err := openNativeHistory(home, thread)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if stat, err := file.Stat(); err != nil {
		return "", err
	} else if stat.Size() > maxNativeHistoryBytes {
		return "", errors.New("history too large")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxNativeHistoryBytes))
	if err == nil && !utf8.Valid(data) {
		err = errors.New("invalid history UTF-8")
	}
	return string(data), err
}

func visitNativeRollout(input io.Reader, session string, visit func(object) error) error {
	lines := bufio.NewReader(input)
	matched := false
	for {
		line, err := lines.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		var row object
		if err := decodeObject(line, &row); err != nil {
			return fmt.Errorf("INVALID_NATIVE_HISTORY: %w", err)
		}
		if !matched && (row["type"] != "session_meta" || field(row["payload"], "id") != session) {
			return errors.New("NATIVE_THREAD_ID_MISMATCH")
		}
		matched = true
		if err := visit(row); err != nil {
			return err
		}
	}
	if !matched {
		return errors.New("NATIVE_THREAD_ID_MISMATCH")
	}
	return nil
}

var nativeSchemaBinary func(context.Context, *service) (string, error)

func nativeControlSchema(ctx context.Context, request operationRequest) (any, error) {
	request.service.schemas.Lock()
	defer request.service.schemas.Unlock()
	if request.service.schemas.value == nil {
		binary, err := nativeSchemaBinary(ctx, request.service)
		if err != nil {
			return nil, err
		}
		value, err := loadNativeSchema(ctx, binary)
		if err != nil {
			return nil, err
		}
		request.service.schemas.value = value
	}
	return selectNativeSchema(request.service.schemas.value, request.args)
}

func loadNativeSchema(ctx context.Context, binary string) (object, error) {
	dir, err := os.MkdirTemp("", "arc-schema-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	if _, err := commandOutput(ctx, binary, "app-server", "generate-json-schema", "--experimental", "--out", dir); err != nil {
		return nil, err
	}
	server, err := load(filepath.Join(dir, "ServerRequest.json"))
	if err != nil {
		return nil, err
	}
	client, err := load(filepath.Join(dir, "ClientRequest.json"))
	if err != nil {
		return nil, err
	}
	responses := object{}
	for _, branch := range arr(field(server, "oneOf")) {
		properties := field(branch, "properties")
		method := nativeMethod(branch)
		param := text(field(properties, "params"), "$ref")
		pieces := strings.Split(param, "/")
		name := strings.TrimSuffix(pieces[len(pieces)-1], "Params") + "Response.json"
		if method == "" || param == "" || filepath.Base(name) != name {
			continue
		}
		if schema, err := load(filepath.Join(dir, name)); err == nil {
			responses[method] = schema
		}
	}
	return object{"client": client, "server": server, "responses": responses}, nil
}

func nativeMethod(branch any) string {
	enum := arr(field(field(field(branch, "properties"), "method"), "enum"))
	if len(enum) == 0 {
		return ""
	}
	return str(enum[0])
}

func selectNativeSchema(data, args object) (object, error) {
	direction := metricString(args["direction"], "client")
	root := obj(data[direction])
	branches := arr(root["oneOf"])
	if branches == nil {
		return nil, errors.New("SCHEMA_UNAVAILABLE")
	}
	if method, ok := args["method"].(string); ok {
		for _, branch := range branches {
			if nativeMethod(branch) != method {
				continue
			}
			params := obj(field(field(branch, "properties"), "params"))
			if params == nil {
				params = object{"type": "null"}
			}
			return object{"method": method, "direction": direction, "description": field(branch, "description"),
				"paramsSchema": schemaClosure(params, obj(root["definitions"])), "responseSchema": field(data["responses"], method)}, nil
		}
		return nil, errors.New("METHOD_NOT_FOUND")
	}
	search := strings.ToLower(text(args, "search"))
	methods := []object{}
	for _, branch := range branches {
		if method := nativeMethod(branch); strings.Contains(strings.ToLower(method), search) {
			methods = append(methods, object{"method": method, "description": field(branch, "description")})
		}
	}
	start := min(uintOr(args["offset"], 0), uint64(len(methods)))
	end := min(start+min(uintOr(args["limit"], 100), 1000), uint64(len(methods)))
	var next any
	if end < uint64(len(methods)) {
		next = end
	}
	return object{"source": "current-binary-generated-experimental-schema", "total": len(methods), "methods": methods[start:end], "nextOffset": next}, nil
}

func init() {
	registerOperation("codex_schema", nativeControlSchema, nil)
}
