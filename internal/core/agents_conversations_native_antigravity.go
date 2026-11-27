package core

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

const antigravityTranscript = ".system_generated/logs/transcript.jsonl"

func antigravityConversationRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".gemini", "antigravity"), filepath.Join(home, ".gemini", "antigravity-cli")}
}

func cleanAntigravityInput(raw string) string {
	const start, end = "<USER_REQUEST>", "</USER_REQUEST>"
	if _, tail, found := strings.Cut(raw, start); found {
		if input, _, found := strings.Cut(tail, end); found {
			raw = input
		}
	}
	input := strings.NewReplacer(start, "", end, "").Replace(raw)
	for _, tag := range []string{"ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE", "CONTEXT_SUMMARY", "SYSTEM_MESSAGE", "EPHEMERAL_MESSAGE", "GRILL_ME"} {
		open, close := "<"+tag+">", "</"+tag+">"
		for {
			before, tail, found := strings.Cut(input, open)
			if !found {
				break
			}
			_, after, found := strings.Cut(tail, close)
			if !found {
				break
			}
			input = before + after
		}
	}
	return strings.TrimSpace(input)
}

func antigravityNativeText(step object) string {
	if step["type"] == "USER_INPUT" {
		return cleanAntigravityInput(text(step, "content"))
	}
	return strings.TrimSpace(text(step, "content"))
}

func antigravityUnquoteArg(value any) any {
	raw, ok := value.(string)
	if !ok || len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return value
	}
	var decoded string
	if unmarshalJSON([]byte(raw), &decoded) == nil {
		return decoded
	}
	return value
}

func antigravityNativeToolArgs(raw any) any {
	parsed := parseTrackedInput(raw)
	args := obj(parsed)
	if args == nil {
		return antigravityUnquoteArg(parsed)
	}
	normalized := make(object, len(args))
	for key, value := range args {
		normalized[key] = antigravityUnquoteArg(value)
	}
	for _, mapping := range [][]string{
		{"command", "CommandLine", "commandLine", "Command"},
		{"cwd", "Cwd", "WorkingDirectory", "workingDirectory"},
		{"path", "Path", "TargetFile", "FilePath", "AbsolutePath", "DirectoryPath", "SearchPath"},
		{"old_string", "Target", "TargetContent", "OldString"},
		{"new_string", "Replacement", "ReplacementContent", "NewString"},
		{"content", "Content", "CodeContent"},
	} {
		if _, exists := normalized[mapping[0]]; exists {
			continue
		}
		for _, alias := range mapping[1:] {
			if value, ok := normalized[alias].(string); ok && strings.TrimSpace(value) != "" {
				normalized[mapping[0]] = value
				break
			}
		}
	}
	return normalized
}

func antigravityNativeToolCall(turnID string, step object, index int, call any) object {
	id := strings.TrimSpace(text(call, "id"))
	if id == "" {
		id = fmt.Sprintf("%s:antigravity:%s:tool:%d", turnID, wire(step["step_index"]), index)
	}
	return object{
		"type":      "toolCall",
		"id":        id,
		"name":      field(call, "name"),
		"arguments": antigravityNativeToolArgs(firstTaskValue(field(call, "arguments"), field(call, "args"))),
	}
}

func antigravityNativeDispatch(step object) object {
	model := text(step, "model")
	if strings.TrimSpace(model) == "" {
		return nil
	}
	if i := strings.LastIndexByte(model, '-'); i > 0 && slices.Contains(antigravityEfforts, model[i+1:]) {
		return object{"model": model[:i], "effort": model[i+1:]}
	}
	return object{"model": model}
}

type antigravityNativeTurn struct {
	start, end time.Time
	dispatch   object
}

func (turn *antigravityNativeTurn) observe(step object) {
	if at, err := time.Parse(time.RFC3339Nano, text(step, "created_at")); err == nil {
		if turn.start.IsZero() {
			turn.start = at
		}
		turn.end = at
	}
	if step["type"] == "PLANNER_RESPONSE" {
		if value := antigravityNativeDispatch(step); value != nil {
			turn.dispatch = value
		}
	}
}

func (turn antigravityNativeTurn) timing() object {
	if turn.start.IsZero() {
		return nil
	}
	return object{"startedAt": turn.start.Format(time.RFC3339Nano), "endedAt": turn.end.Format(time.RFC3339Nano),
		"durationMs": max(0, turn.end.Sub(turn.start).Milliseconds())}
}

func scanAntigravityTranscript(ctx context.Context, file string, accept func(object)) (bool, error) {
	input, err := os.Open(file)
	if err != nil {
		return false, err
	}
	defer input.Close()
	partial := false
	reader := bufio.NewReader(input)
	for {
		if err := ctx.Err(); err != nil {
			return partial, err
		}
		line, err := readProtocolLine(reader, taskHostMaxFrame)
		if err == io.EOF {
			return partial, nil
		}
		if err != nil {
			return true, err
		}
		if strings.TrimSpace(string(line)) == "" {
			continue
		}
		step := object{}
		if decodeObject(line, &step) != nil || step == nil {
			partial = true
			continue
		}
		accept(step)
	}
}

func antigravityNativeConversation(ctx context.Context, file, session string, modified time.Time) (object, error) {
	updated := modified.UTC().Format("2006-01-02T15:04:05.000Z")
	var prompt, reply, created string
	var users, replies int
	var turn antigravityNativeTurn
	var dispatch object
	partial, err := scanAntigravityTranscript(ctx, file, func(step object) {
		switch step["type"] {
		case "USER_INPUT":
			users++
			turn = antigravityNativeTurn{}
			if prompt == "" {
				prompt = runeExcerpt(antigravityNativeText(step), 240)
			}
		case "PLANNER_RESPONSE":
			replies++
			if reply == "" {
				reply = runeExcerpt(antigravityNativeText(step), 240)
			}
		}
		turn.observe(step)
		if turn.dispatch != nil {
			dispatch = turn.dispatch
		}
		if created == "" {
			if at, err := time.Parse(time.RFC3339Nano, text(step, "created_at")); err == nil {
				created = at.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	})
	if err != nil {
		return nil, err
	}
	preview := nonemptyTaskText(prompt, reply)
	timing := turn.timing()
	if users == 0 && replies > 0 {
		users = 1
		replies--
	}
	return object{"id": session, "nativeSessionId": session, "agent": "antigravity", "source": "native",
		"title": runeExcerpt(preview, 120), "preview": preview, "project": nil, "status": nil,
		"createdAt": nonemptyTaskText(created, updated), "updatedAt": updated, "dispatchSummary": dispatch,
		"turnCount": users, "turnStartedAt": timing["startedAt"], "turnEndedAt": timing["endedAt"],
		"turnDurationMs": timing["durationMs"], "messageCount": users + replies, "metadataPartial": partial}, nil
}

func nativeAntigravityTimeline(ctx context.Context, session string) (object, error) {
	if _, err := uuid.Parse(session); err != nil {
		return nil, errors.New("INVALID_SESSION_ID")
	}
	var steps []object
	var partial bool
	var err error = os.ErrNotExist
	for _, root := range antigravityConversationRoots() {
		file := filepath.Join(root, "brain", session, filepath.FromSlash(antigravityTranscript))
		partial, err = scanAntigravityTranscript(ctx, file, func(step object) {
			steps = append(steps, step)
		})
		if !errors.Is(err, os.ErrNotExist) {
			break
		}
	}
	if err != nil {
		return nil, errors.New("NATIVE_CONVERSATION_NOT_FOUND")
	}
	timeline := taskTimeline{Info: object{"id": session, "agent": "antigravity"}, Partial: partial}
	timeline.init()
	var dispatch object
	turnCount := 0
	hasResponse := false
	for len(steps) != 0 {
		turnID, end := "native-initial", 1
		if head := steps[0]; head["type"] == "USER_INPUT" {
			turnID = wire(head["step_index"])
			turnCount++
		}
		for end < len(steps) && steps[end]["type"] != "USER_INPUT" {
			end++
		}
		turnSteps := steps[:end]
		steps = steps[end:]
		timeline.Turn = turnID
		lastAnswer := -1
		for i, step := range slices.Backward(turnSteps) {
			if step["type"] == "PLANNER_RESPONSE" && antigravityNativeText(step) != "" {
				lastAnswer = i
				break
			}
		}
		var turn antigravityNativeTurn
		for i, step := range turnSteps {
			turn.observe(step)
			revision := timeline.Revision
			at, content := text(step, "created_at"), antigravityNativeText(step)
			calls := arr(step["tool_calls"])
			switch step["type"] {
			case "USER_INPUT":
				timeline.agent("arc/user", object{"text": content, "turnId": turnID}, at)
			case "PLANNER_RESPONSE":
				hasResponse = true
				items := []any{}
				if thinking := strings.TrimSpace(text(step, "thinking")); thinking != "" {
					items = append(items, object{"type": "thinking", "thinking": thinking})
				}
				if content != "" {
					items = append(items, object{"type": "text", "text": content})
				}
				for callIndex, call := range calls {
					items = append(items, antigravityNativeToolCall(turnID, step, callIndex, call))
				}
				timeline.agent("message_end", object{"message": object{"role": "assistant", "content": items}}, at)
			}
			for _, item := range slices.Backward(timeline.Entries) {
				if uintOr(item["cursor"], 0) <= revision {
					break
				}
				item["stepIndex"], item["source"], item["nativeStatus"] = step["step_index"], step["source"], step["status"]
				switch step["status"] {
				case "DONE", "COMPLETED":
					item["status"] = "completed"
				case "ERROR", "FAILED":
					item["status"] = "failed"
				case "ACTIVE", "RUNNING":
					item["status"] = "running"
				}
				switch item["type"] {
				case "user":
					item["role"] = "user"
				case "thinking":
					item["role"] = "assistant"
				case "text":
					item["role"] = "assistant"
					if len(calls) == 0 || i == lastAnswer {
						item["phase"] = "final_answer"
					}
				}
			}
		}
		if timing := turn.timing(); timing != nil {
			timeline.TurnTimings[turnID] = timing
		}
		if turn.dispatch != nil {
			timeline.TurnDispatchSummaries[turnID], dispatch = turn.dispatch, turn.dispatch
		}
	}
	if turnCount == 0 && hasResponse {
		turnCount = 1
	}
	result := timeline.response(session, 0)
	result["turnCount"], result["status"], result["readOnly"] = turnCount, nil, true
	if result["dispatchSummary"] == nil {
		result["dispatchSummary"] = dispatch
	}
	return result, nil
}

func antigravityConversationSummaries(ctx context.Context, path string) map[string]object {
	before, err := readStamp(path)
	if err != nil || before == nil {
		return nil
	}
	walPath := path + "-wal"
	walBefore, err := readStamp(walPath)
	if err != nil {
		return nil
	}
	source := path
	immutable := "immutable=1"
	if walBefore != nil && walBefore.Length != 0 {
		dir, err := os.MkdirTemp("", "arc-antigravity-")
		if err != nil {
			return nil
		}
		defer os.RemoveAll(dir)
		source, immutable = filepath.Join(dir, "summaries.db"), ""
		for _, paths := range [][2]string{{path, source}, {walPath, source + "-wal"}} {
			if err := copyNativeSummary(paths[0], paths[1]); err != nil {
				return nil
			}
		}
	}
	unchanged := func() bool {
		after, err := readStamp(path)
		walAfter, walErr := readStamp(walPath)
		return err == nil && walErr == nil && stampSame(before, after) && stampSame(walBefore, walAfter)
	}
	if !unchanged() {
		return nil
	}
	location := filepath.ToSlash(source)
	if !strings.HasPrefix(location, "/") {
		location = "/" + location
	}
	uri := url.URL{Scheme: "file", Path: location, RawQuery: "mode=ro&" + immutable}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil
	}
	defer db.Close()
	query, err := db.QueryContext(ctx, "SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, agent_name, status, last_modified_time FROM conversation_summaries")
	if err != nil {
		return nil
	}
	defer query.Close()
	rows := map[string]object{}
	for query.Next() {
		var session string
		var title, preview, workspace, parent, name, status, updated sql.NullString
		if query.Scan(&session, &title, &preview, &workspace, &parent, &name, &status, &updated) != nil {
			continue
		}
		var uris []string
		_ = unmarshalJSON([]byte(workspace.String), &uris)
		var project any
		for _, raw := range uris {
			if parsed, err := url.Parse(raw); err == nil && parsed.Scheme == "file" && (parsed.Host == "" || parsed.Host == "localhost") {
				localPath := parsed.Path
				if operatingSystem == "windows" && len(localPath) >= 3 && localPath[2] == ':' {
					localPath = localPath[1:]
				}
				project = filepath.FromSlash(localPath)
				break
			}
		}
		rows[session] = object{"title": title.String, "preview": preview.String, "project": project,
			"parentSessionId": parent.String, "agentName": name.String, "nativeStatus": status.String, "updatedAt": updated.String}
	}
	if query.Err() != nil || !unchanged() {
		return nil
	}
	return rows
}

func copyNativeSummary(source, dest string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	return errors.Join(err, output.Close())
}

func enrichNativeAntigravity(row, summary object) {
	if summary == nil {
		return
	}
	if parent := strings.TrimSpace(text(summary, "parentSessionId")); parent != "" {
		row["parentSessionId"], row["relationKind"] = parent, "subagent"
	}
	title := strings.TrimSpace(text(summary, "title"))
	if title == "" && row["relationKind"] == "subagent" {
		title = strings.TrimSpace(text(summary, "agentName"))
	}
	if title != "" {
		row["title"] = runeExcerpt(title, 120)
	}
	if preview := strings.TrimSpace(text(summary, "preview")); preview != "" {
		row["preview"] = runeExcerpt(preview, 240)
	}
	row["project"] = summary["project"]
	if name := strings.TrimSpace(text(summary, "agentName")); name != "" {
		row["agentName"] = name
	}
	if status := strings.TrimSpace(text(summary, "nativeStatus")); status != "" {
		row["nativeStatus"], row["status"] = status, status
		switch strings.ToLower(strings.TrimPrefix(status, "CASCADE_RUN_STATUS_")) {
		case "done", "completed", "finished":
			row["status"] = "completed"
		case "failed", "error":
			row["status"] = "failed"
		case "running", "active":
			row["status"] = "running"
		case "cancelled", "canceled", "interrupted":
			row["status"] = "interrupted"
		case "idle":
			row["status"] = "idle"
		}
	}
	at := nativeConversationTime(summary, "updatedAt")
	if at.After(nativeConversationTime(row, "updatedAt")) {
		row["updatedAt"] = at.UTC().Format("2006-01-02T15:04:05.000Z")
	}
}

func listNativeAntigravity(ctx context.Context) []object {
	roots := antigravityConversationRoots()
	if len(roots) == 0 {
		return nil
	}
	summaries := antigravityConversationSummaries(ctx, filepath.Join(roots[0], "conversation_summaries.db"))
	result := []object{}
	seen := map[string]bool{}
	for _, root := range roots {
		brain := filepath.Join(root, "brain")
		entries, err := os.ReadDir(brain)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			session := entry.Name()
			if _, err := uuid.Parse(session); err != nil || !entry.IsDir() || seen[session] {
				continue
			}
			file := filepath.Join(brain, session, filepath.FromSlash(antigravityTranscript))
			info, err := os.Stat(file)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			row, err := antigravityNativeConversation(ctx, file, session, info.ModTime())
			if err == nil {
				enrichNativeAntigravity(row, summaries[session])
				result, seen[session] = append(result, row), true
			}
		}
	}
	return result
}
