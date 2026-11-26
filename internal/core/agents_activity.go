package core

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"errors"
	"io"
	"maps"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type codexActivityClock struct {
	framing                   taskCodexTranscript
	threadTier                taskCodexThreadTier
	thread, turn, title, name string
	offset                    int64
	running                   bool
	started, turnStarted      any
	project, parent, relation any
	creator, turnTier         any
	configurations            map[string]object
	startedTurns              map[string]bool
}

func (c *codexActivityClock) observe(record object) {
	if !c.framing.include(record) {
		return
	}
	payload := record["payload"]
	at := record["timestamp"]
	if c.started == nil {
		c.started = at
	}
	if cwd := dispatchFirstString(record["cwd"], field(payload, "cwd")); cwd != nil {
		c.project = cwd
	}
	lateTier := c.threadTier.observe(record)
	switch record["type"] {
	case "session_meta":
		if c.thread == "" {
			c.thread = text(payload, "id")
			c.name = runeExcerpt(strings.TrimSpace(text(payload, "agent_nickname")), 240)
			c.creator = field(payload, "creator_account_id")
			if field(payload, "attached_thread") == true {
				c.parent, c.relation = field(payload, "forked_from_id"), "side-chat"
			} else if parent := text(field(field(field(payload, "source"), "subagent"), "thread_spawn"), "parent_thread_id"); parent != "" {
				c.parent, c.relation = parent, "subagent"
			}
		}
	case "turn_context":
		if turn := text(payload, "turn_id"); turn != "" {
			c.selectTurn(turn)
			c.configurations[turn] = object{"model": field(payload, "model"), "effort": field(payload, "effort"),
				"serviceTier": field(payload, "service_tier"), "threadServiceTier": c.turnTier}
		}
	case "event_msg":
		turn := str(dispatchFirstString(field(payload, "turn_id"), c.turn))
		switch field(payload, "type") {
		case "task_started":
			if turn != "" {
				c.selectTurn(turn)
				c.turnStarted, c.running = at, true
				c.startedTurns[turn] = true
			}
		case "task_complete", "turn_aborted":
			if c.turn == turn {
				c.running = false
			}
		}
	case "response_item":
		if c.title == "" && field(payload, "type") == "message" && field(payload, "role") == "user" {
			c.title = trackedTranscriptTitleText(cleanTaskTranscript(contentOfTaskValue(field(payload, "content"))))
		}
	}
	if lateTier != "" && lateTier == c.turn && c.configurations[lateTier] != nil {
		c.turnTier = c.threadTier.Current
		c.configurations[lateTier]["threadServiceTier"] = c.turnTier
	}
}

func (c *codexActivityClock) selectTurn(turn string) {
	if c.turn == turn {
		return
	}
	if c.configurations == nil {
		c.configurations, c.startedTurns = map[string]object{}, map[string]bool{}
	}
	c.turn, c.turnStarted, c.turnTier, c.running = turn, nil, c.threadTier.Current, false
}

type codexActivityFile struct {
	stamp *fileStamp
	clock codexActivityClock
	row   object
}

type codexActivityMonitor struct {
	sync.Mutex
	root                string
	sampled, discovered time.Time
	watch               *discoveryChanges
	discoveryRevision   uint64
	files               map[string]codexActivityFile
	active              []object
	known               map[string]string
	knownIDs            []string
}

func (m *codexActivityMonitor) close() {
	m.Lock()
	defer m.Unlock()
	if m.watch != nil {
		_ = m.watch.watcher.Close()
		m.watch = nil
	}
}

func (m *codexActivityMonitor) path(thread string) string {
	m.Lock()
	defer m.Unlock()
	return m.known[thread]
}

func (m *codexActivityMonitor) remember(thread, path string) {
	if _, exists := m.known[thread]; !exists {
		m.knownIDs = append(m.knownIDs, thread)
		if len(m.knownIDs) > 128 {
			delete(m.known, m.knownIDs[0])
			m.knownIDs = m.knownIDs[1:]
		}
	}
	m.known[thread] = path
}

func discoverCodexActivityPaths(dir string, paths map[string]bool) {
	entries, err := cachedEntries(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if strings.HasPrefix(filepath.Base(entry.path), ".") {
			continue
		}
		if entry.kind.IsDir() {
			discoverCodexActivityPaths(entry.path, paths)
		} else if entry.kind.IsRegular() && filepath.Ext(entry.path) == ".jsonl" {
			paths[entry.path] = true
		}
	}
}

func decodeCodexActivityRecords(ctx context.Context, input io.Reader, consume func(object)) (int64, error) {
	lines := bufio.NewReader(input)
	var read int64
	for {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		line, err := lines.ReadBytes('\n')
		if err == io.EOF {
			return read, nil
		}
		if err != nil {
			return read, err
		}
		read += int64(len(line))
		var record object
		if decodeObject(line, &record) == nil {
			consume(record)
		}
		if cost := currentRuntimeCost(ctx); cost != nil {
			cost.read.Add(uint64(len(line)))
			cost.parsed.Add(uint64(len(line)))
		}
	}
}

func sampleCodexActivityFile(ctx context.Context, home, path string, stamp *fileStamp, old codexActivityFile) (codexActivityFile, error) {
	file, err := openNativeHistory(home, object{"path": path})
	if err != nil {
		return codexActivityFile{}, err
	}
	defer file.Close()
	if !stamp.appendsTo(old.stamp) {
		old = codexActivityFile{}
	}
	clock := &old.clock
	if _, err := file.Seek(clock.offset, io.SeekStart); err != nil {
		return codexActivityFile{}, err
	}
	read, err := decodeCodexActivityRecords(ctx, io.LimitReader(file, int64(stamp.Length)-clock.offset), clock.observe)
	if err != nil {
		return codexActivityFile{}, err
	}
	clock.offset += read
	current, err := readStamp(path)
	if err != nil || !stampSame(stamp, current) && !current.appendsTo(stamp) {
		return codexActivityFile{}, errors.New("Transcript changed during activity sampling")
	}
	old.stamp, old.row = stamp, nil
	if !clock.running || uuid.Validate(clock.thread) != nil {
		return old, nil
	}
	const tailLimit = 128 * 1024
	start := max(int64(stamp.Length)-tailLimit, 0)
	data, err := io.ReadAll(io.NewSectionReader(file, start, int64(stamp.Length)-start))
	if err != nil {
		return codexActivityFile{}, err
	}
	partial := start != 0
	if partial {
		if _, rest, found := bytes.Cut(data, []byte{'\n'}); found {
			data = rest
		} else {
			data = nil
		}
	}
	timeline := taskTimeline{Partial: partial}
	_, err = decodeCodexActivityRecords(ctx, bytes.NewReader(data), func(row object) { timeline.backfillCodexRecords([]any{row}) })
	if err != nil {
		return codexActivityFile{}, err
	}
	timeline.Turn, timeline.Status = clock.turn, "running"
	if at, ok := clock.turnStarted.(string); ok {
		timeline.TurnStartedAt = &at
	}
	row := timeline.transcriptSession(clock.thread, "codex")
	row["startedAt"], row["turnStartedAt"], row["turnCount"], row["turnId"] = clock.started, clock.turnStarted, len(clock.startedTurns), clock.turn
	row["creatorAccountId"], row["project"] = clock.creator, clock.project
	if clock.title != "" {
		row["title"] = clock.title
	}
	if clock.parent != nil {
		row["parentSessionId"], row["relationKind"] = clock.parent, clock.relation
	}
	if summary := dispatchSummary(clock.configurations[clock.turn]); summary != nil {
		row["dispatchSummary"] = summary
	}
	old.row = row
	return old, nil
}

func (m *codexActivityMonitor) sample(ctx context.Context, home string, now time.Time) []object {
	m.Lock()
	defer m.Unlock()
	dir := filepath.Join(home, "sessions")
	if dir != m.root {
		if m.watch != nil {
			_ = m.watch.watcher.Close()
		}
		m.root, m.watch, m.sampled, m.discovered = dir, nil, time.Time{}, time.Time{}
		m.files, m.known, m.knownIDs, m.active = map[string]codexActivityFile{}, map[string]string{}, nil, nil
		m.watch, _ = watchDiscovery([]string{dir, filepath.Join(home, "session_index.jsonl")}, nil)
	}
	if now.Sub(m.sampled) < 2*time.Second {
		return slices.Clone(m.active)
	}
	m.sampled = now
	paths := map[string]bool{}
	revision := uint64(0)
	if m.watch != nil {
		revision = m.watch.revision.Load()
	}
	if now.Sub(m.discovered) >= 30*time.Second || m.watch == nil || m.watch.failed.Load() || revision != m.discoveryRevision {
		m.discovered, m.discoveryRevision = now, revision
		discoverCodexActivityPaths(dir, paths)
	} else {
		for path := range m.files {
			paths[path] = true
		}
		for _, day := range []time.Time{now, now.AddDate(0, 0, -1)} {
			discoverCodexActivityPaths(filepath.Join(dir, day.Format("2006/01/02")), paths)
		}
	}
	active := []object{}
	next := map[string]codexActivityFile{}
	recordRuntimeWork(ctx, runtimeWorkCost{Owner: "activity", Reason: "poll", Rows: len(paths), ScanSet: len(paths)})
	for _, path := range slices.Sorted(maps.Keys(paths)) {
		if ctx.Err() != nil {
			return slices.Clone(m.active)
		}
		stamp, err := readStamp(path)
		if err != nil || stamp == nil || stamp.Modified == nil {
			continue
		}
		old := m.files[path]
		if !old.clock.running && now.Sub(time.Unix(stamp.Modified.Seconds, int64(stamp.Modified.Nanos))) > 5*time.Minute {
			continue
		}
		if !stampSame(old.stamp, stamp) {
			old, err = sampleCodexActivityFile(ctx, home, path, stamp, old)
			if err != nil {
				continue
			}
		}
		if old.row != nil {
			m.remember(old.clock.thread, path)
			row := clone(old.row)
			if old.clock.name != "" {
				row["title"] = old.clock.name
			}
			active = append(active, row)
		}
		if len(next) < 128 || old.clock.running {
			next[path] = old
		}
	}
	m.files, m.active = next, active
	return slices.Clone(active)
}

func readNativeAgentActivity(ctx context.Context, s *service) (object, error) {
	defer beginRuntimeWork("activity")()
	_, home, err := codexInputs()
	if err != nil {
		return nil, err
	}
	rows := s.codex.activity.sample(ctx, home, time.Now())
	byID := make(map[string]object, len(rows))
	for _, row := range rows {
		byID[text(row, "id")] = clone(row)
	}
	s.events.Lock()
	for thread, timeline := range s.events.taskTimelines {
		if timeline.Status != "running" && timeline.Status != "waiting-permission" {
			continue
		}
		row := timeline.session(thread, timeline.Info, "codex-thread", nil)
		for _, key := range []string{"title", "project", "startedAt", "dispatchSummary", "parentSessionId", "relationKind"} {
			if row[key] == nil || row[key] == "" {
				row[key] = byID[thread][key]
			}
		}
		byID[thread] = row
	}
	s.events.Unlock()
	agents := object{}
	ids := []string{}
	if len(byID) > 0 {
		ids = append(ids, "codex")
		sessions := slices.Collect(maps.Values(byID))
		slices.SortFunc(sessions, func(a, b object) int { return cmp.Compare(text(a, "id"), text(b, "id")) })
		agents["codex"] = object{"sessions": sessions}
	}
	return object{"agents": agents, "activeAgents": ids, "observedAt": now(), "scope": "selected-local-transcripts-and-connector-live-sessions"}, nil
}

func init() {
	registerRoute(http.MethodGet, "agents/activity", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return readNativeAgentActivity(ctx, s)
	})
}
