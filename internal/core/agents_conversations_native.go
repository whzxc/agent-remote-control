package core

import (
	"bytes"
	"context"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const agentNativeHead = 64 << 10
const agentNativeTail = 128 << 10
const agentNativeHistoryTail = 8 << 20

type nativeConversationFile struct {
	path string
	row  object
}

type nativeConversationMetadata struct {
	stamp *fileStamp
	row   object
}

var nativeConversationMetadataCache struct {
	sync.Mutex
	rows map[[2]string]nativeConversationMetadata
}

func nativeAgentTranscriptRoots(agent string) []string {
	if agent == "claude" {
		return nativeClaudeTranscriptRoots()
	}
	if agent != "pi" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	expand := func(path string) string {
		if path == "~" {
			return home
		}
		if relative, ok := strings.CutPrefix(path, "~/"); ok {
			return filepath.Join(home, relative)
		}
		return path
	}
	dir := nonemptyTaskText(os.Getenv("PI_CODING_AGENT_DIR"), filepath.Join(home, ".pi", "agent"))
	result := []string{filepath.Join(expand(dir), "sessions")}
	if override := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); override != "" {
		result = append(result, expand(override))
	}
	return result
}

func nativeTranscriptSidechain(path string, records []object) bool {
	if strings.HasPrefix(filepath.Base(path), "agent-") || slices.Contains(strings.Split(filepath.ToSlash(path), "/"), "subagents") {
		return true
	}
	var sidechain, main bool
	for _, record := range records {
		if record["isSidechain"] == true {
			sidechain = true
		} else if role := field(record["message"], "role"); role == "user" || role == "assistant" {
			main = true
		}
	}
	return sidechain && !main
}

func nativeTranscriptRead(ctx context.Context, file *os.File, start, length int64, prefixPartial, suffixPartial bool) ([]object, error) {
	reader := io.NewSectionReader(file, start, length)
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	cost := currentRuntimeCost(ctx)
	if cost != nil {
		cost.read.Add(uint64(len(data)))
	}
	if prefixPartial {
		_, rest, found := bytes.Cut(data, []byte{'\n'})
		data = nil
		if found {
			data = rest
		}
	}
	if suffixPartial {
		data = data[:bytes.LastIndexByte(data, '\n')+1]
	}
	result := []object{}
	for line := range bytes.SplitSeq(data, []byte{'\n'}) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(line) == 0 {
			continue
		}
		if cost != nil {
			cost.parsed.Add(uint64(len(line)))
		}
		var row object
		if decodeObject(line, &row) == nil && row != nil {
			result = append(result, row)
		}
	}
	return result, nil
}

func nativeAgentMessageText(record object) string {
	content := field(record["message"], "content")
	if value, ok := content.(string); ok {
		return value
	}
	parts := []string{}
	for _, block := range arr(content) {
		if field(block, "type") == "text" {
			if value, ok := field(block, "text").(string); ok {
				parts = append(parts, value)
			}
		}
	}
	return strings.Join(parts, " ")
}

func deriveNativeAgentConversation(agent, path string, head, tail []object, complete bool, modified time.Time) object {
	records := append(slices.Clone(head), tail...)
	if agent == "claude" && nativeTranscriptSidechain(path, records) {
		return nil
	}
	var id string
	if agent == "pi" {
		for _, record := range head {
			if record["type"] == "session" {
				if uintOr(record["version"], 0) != 3 {
					return nil
				}
				id = text(record, "id")
				break
			}
		}
	} else {
		id = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		if uuid.Validate(id) != nil {
			for _, record := range records {
				if id = text(record, "sessionId"); id != "" {
					break
				}
			}
		}
	}
	if uuid.Validate(id) != nil {
		return nil
	}
	updated := modified.UTC().Format("2006-01-02T15:04:05.000Z")
	var title taskTranscriptTitle
	var preview, created string
	var project any
	var status any
	count := 0
	for _, record := range records {
		if agent == "claude" && record["isSidechain"] == true {
			continue
		}
		if directory, ok := record["cwd"].(string); ok {
			project = directory
		}
		title.observe(record)
		message := record["message"]
		role := text(message, "role")
		if role == "user" || role == "assistant" || role == "toolResult" {
			count++
		}
		if role == "assistant" {
			if value := strings.Join(strings.Fields(nativeAgentMessageText(record)), " "); value != "" {
				preview = runeExcerpt(value, 240)
			}
		}
		if agent == "claude" && record["isMeta"] != true && (role == "user" || role == "assistant") {
			var latest taskTimeline
			latest.backfillClaude([]any{record})
			status = nil
			if latest.Status != "" {
				status = latest.Status
			}
		}
		if created == "" {
			if at := nativeConversationTime(record, "timestamp"); !at.IsZero() {
				created = at.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	}
	var messageCount, titleValue any
	if value := title.value(); value != nil {
		titleValue = *value
	}
	if complete {
		messageCount = count
	}
	return object{"agent": agent, "id": id, "nativeSessionId": id, "source": "native", "title": titleValue, "preview": preview,
		"project": project, "createdAt": nonemptyTaskText(created, updated), "updatedAt": updated, "status": status,
		"messageCount": messageCount, "metadataPartial": !complete}
}

func scanNativeAgentConversation(ctx context.Context, agent, path string) object {
	before, err := readStamp(path)
	if err != nil || before == nil {
		return nil
	}
	key := [2]string{agent, path}
	nativeConversationMetadataCache.Lock()
	entry := nativeConversationMetadataCache.rows[key]
	nativeConversationMetadataCache.Unlock()
	if stampSame(entry.stamp, before) {
		if cost := currentRuntimeCost(ctx); cost != nil {
			cost.hits.Add(1)
		}
		return maps.Clone(entry.row)
	}
	if cost := currentRuntimeCost(ctx); cost != nil {
		cost.misses.Add(1)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	size := int64(before.Length)
	complete := size <= agentNativeHead
	head, err := nativeTranscriptRead(ctx, file, 0, min(size, agentNativeHead), false, !complete)
	if err != nil {
		return nil
	}
	var tail []object
	if !complete {
		start := max(0, size-agentNativeTail)
		tail, err = nativeTranscriptRead(ctx, file, start, size-start, start != 0, false)
		if err != nil {
			return nil
		}
	}
	modified := time.Unix(0, 0)
	if before.Modified != nil {
		modified = time.Unix(before.Modified.Seconds, int64(before.Modified.Nanos))
	}
	row := deriveNativeAgentConversation(agent, path, head, tail, complete, modified)
	after, err := readStamp(path)
	if err != nil || !stampSame(before, after) {
		return nil
	}
	nativeConversationMetadataCache.Lock()
	if nativeConversationMetadataCache.rows == nil || len(nativeConversationMetadataCache.rows) >= cacheFiles {
		nativeConversationMetadataCache.rows = make(map[[2]string]nativeConversationMetadata)
	}
	nativeConversationMetadataCache.rows[key] = nativeConversationMetadata{before, maps.Clone(row)}
	nativeConversationMetadataCache.Unlock()
	return row
}

func nativeAgentConversationFiles(ctx context.Context, agent string) []nativeConversationFile {
	result := []nativeConversationFile{}
	visited := map[string]bool{}
	for _, dir := range nativeAgentTranscriptRoots(agent) {
		_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				return nil
			}
			if path == dir {
				return nil
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") || agent == "claude" && entry.Name() == "subagents" {
					return filepath.SkipDir
				}
				return nil
			}
			if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") || filepath.Ext(path) != ".jsonl" ||
				agent == "claude" && strings.HasPrefix(entry.Name(), "agent-") || visited[path] {
				return nil
			}
			visited[path] = true
			if row := scanNativeAgentConversation(ctx, agent, path); row != nil {
				result = append(result, nativeConversationFile{path, row})
			}
			return nil
		})
	}
	slices.SortFunc(result, func(a, b nativeConversationFile) int {
		if order := strings.Compare(text(b.row, "updatedAt"), text(a.row, "updatedAt")); order != 0 {
			return order
		}
		return strings.Compare(a.path, b.path)
	})
	seen := map[string]bool{}
	return slices.DeleteFunc(result, func(file nativeConversationFile) bool {
		id := text(file.row, "id")
		known := seen[id]
		seen[id] = true
		return known
	})
}

func nativeAgentTranscriptTimeline(ctx context.Context, file nativeConversationFile) (object, error) {
	reader, err := os.Open(file.path)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	info, err := reader.Stat()
	if err != nil {
		return nil, err
	}
	start := max(0, info.Size()-agentNativeHistoryTail)
	records, err := nativeTranscriptRead(ctx, reader, start, info.Size()-start, start != 0, false)
	if err != nil {
		return nil, err
	}
	id, agent := text(file.row, "id"), text(file.row, "agent")
	if agent == "pi" {
		return nativePiTimeline(id, records, start != 0), nil
	}
	timeline := taskTimeline{Partial: start != 0}
	transcript := make([]any, len(records))
	for i, row := range records {
		transcript[i] = row
	}
	timeline.backfillClaude(transcript)
	result := timeline.response(id, 0)
	result["readOnly"] = true
	return result, nil
}

func nativePiTimeline(id string, records []object, partial bool) object {
	timeline := taskTimeline{Info: object{"id": id, "agent": "pi"}, Partial: partial}
	entries := map[string]object{}
	var leaf string
	for _, row := range records {
		if row["type"] == "session" {
			continue
		}
		leaf = text(row, "id")
		if leaf != "" {
			entries[leaf] = row
		}
	}
	branch := []object{}
	seen := map[string]bool{}
	for leaf != "" {
		row := entries[leaf]
		if row == nil || seen[leaf] {
			timeline.Partial = true
			break
		}
		seen[leaf] = true
		branch = append(branch, row)
		leaf = text(row, "parentId")
	}
	for _, row := range slices.Backward(branch) {
		at := text(row, "timestamp")
		switch row["type"] {
		case "compaction":
			timeline.agent("compaction_end", object{"reason": row["trigger"]}, at)
			if last := timeline.Entries[len(timeline.Entries)-1]; row["tokensBefore"] != nil {
				before := len(wire(last))
				obj(last["notice"])["tokensBefore"] = row["tokensBefore"]
				timeline.Bytes += len(wire(last)) - before
			}
		case "branch_summary", "custom_message":
			timeline.Partial = true
		case "message":
			switch message := row["message"]; field(message, "role") {
			case "user":
				if prompt := trackedTranscriptUserText(row, nativeAgentMessageText(row)); strings.TrimSpace(prompt) != "" {
					timeline.agent("arc/user", object{"turnId": row["id"], "text": prompt}, at)
				}
			case "assistant":
				timeline.agent("message_end", object{"message": message}, at)
			case "toolResult":
				timeline.agent("tool_execution_end", object{"toolCallId": field(message, "toolCallId"), "toolName": field(message, "toolName"),
					"isError": field(message, "isError"), "result": message}, at)
			default:
				timeline.Partial = true
			}
		}
	}
	result := timeline.response(id, 0)
	result["status"], result["readOnly"] = nil, true
	return result
}
