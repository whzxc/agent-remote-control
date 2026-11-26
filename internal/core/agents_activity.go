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
	"os"
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
	turnEnded, turnDuration   any
	turnStatus                string
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
			c.startedTurns[turn] = true
			c.configurations[turn] = object{"model": field(payload, "model"), "effort": field(payload, "effort"),
				"serviceTier": field(payload, "service_tier"), "threadServiceTier": c.turnTier}
		}
	case "event_msg":
		turn := str(dispatchFirstString(field(payload, "turn_id"), c.turn))
		switch field(payload, "type") {
		case "task_started":
			if turn != "" {
				c.selectTurn(turn)
				c.turnStarted, c.running, c.turnStatus = at, true, "running"
				c.startedTurns[turn] = true
			}
		case "task_complete", "turn_aborted":
			if c.turn == "" && turn != "" {
				c.selectTurn(turn)
			}
			if c.turn == turn {
				c.running, c.turnEnded, c.turnDuration = false, at, field(payload, "duration_ms")
				c.turnStatus = "completed"
				if field(payload, "type") == "turn_aborted" {
					c.turnStatus = "cancelled"
				}
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
	c.turnEnded, c.turnDuration, c.turnStatus = nil, nil, ""
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
	titleStamp          *fileStamp
	titles              map[string]string
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

func codexConversationClock(ctx context.Context, file *os.File, size int64) (object, error) {
	start := max(0, size-(128<<10))
	rows, err := nativeTranscriptRead(ctx, file, start, size-start, start != 0, true)
	if err != nil {
		return nil, err
	}
	var clock codexActivityClock
	for _, row := range rows {
		clock.observe(row)
	}
	var summary any
	if config := clock.configurations[clock.turn]; config != nil {
		if value := dispatchSummary(config); value != nil {
			summary = value
		}
	}
	if start != 0 && summary == nil && clock.turn != "" {
		contextStart := max(0, size-(4<<20))
		contextRecords, err := nativeTranscriptRead(ctx, file, contextStart, size-contextStart, contextStart != 0, true)
		if err != nil {
			return nil, err
		}
		for _, row := range slices.Backward(contextRecords) {
			if row["type"] == "turn_context" && field(row["payload"], "turn_id") == clock.turn {
				var recorded codexActivityClock
				recorded.observe(row)
				if config := recorded.configurations[clock.turn]; config != nil {
					if value := dispatchSummary(config); value != nil {
						summary = value
					}
				}
				break
			}
		}
	}
	var count any
	if start == 0 {
		count = len(clock.startedTurns)
	}
	return object{"parentSessionId": clock.parent, "relationKind": clock.relation, "dispatchSummary": summary,
		"turnCount": count, "turnId": clock.turn, "turnStartedAt": clock.turnStarted, "turnEndedAt": clock.turnEnded, "turnDurationMs": clock.turnDuration,
		"status": dispatchFirstString(clock.turnStatus), "metadataPartial": start != 0}, nil
}

func codexConversationClockForThread(ctx context.Context, home string, thread any) object {
	path := text(thread, "path")
	if path == "" {
		return nil
	}
	file, err := openNativeHistory(home, obj(thread))
	if err != nil {
		return nil
	}
	defer file.Close()
	stamp, err := readStamp(path)
	if err != nil || stamp == nil {
		return nil
	}
	key := [2]string{"codex", path}
	nativeConversationMetadataCache.Lock()
	cached := nativeConversationMetadataCache.rows[key]
	nativeConversationMetadataCache.Unlock()
	if stampSame(cached.stamp, stamp) {
		return maps.Clone(cached.row)
	}
	row, err := codexConversationClock(ctx, file, int64(stamp.Length))
	if err != nil {
		return nil
	}
	if current, err := readStamp(path); err != nil || !stampSame(current, stamp) && !current.appendsTo(stamp) {
		return nil
	}
	nativeConversationMetadataCache.Lock()
	if nativeConversationMetadataCache.rows == nil || len(nativeConversationMetadataCache.rows) >= cacheFiles {
		nativeConversationMetadataCache.rows = make(map[[2]string]nativeConversationMetadata)
	}
	nativeConversationMetadataCache.rows[key] = nativeConversationMetadata{stamp, maps.Clone(row)}
	nativeConversationMetadataCache.Unlock()
	return row
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
		m.titleStamp, m.titles = nil, nil
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
	if len(active) > 0 {
		m.loadTitles(ctx, home)
		for _, row := range active {
			thread := text(row, "id")
			if path := m.known[thread]; next[path].clock.name == "" && m.titles[thread] != "" {
				row["title"] = m.titles[thread]
			}
		}
	}
	m.files, m.active = next, active
	return slices.Clone(active)
}

func (m *codexActivityMonitor) loadTitles(ctx context.Context, home string) {
	path := filepath.Join(home, "session_index.jsonl")
	stamp, err := readStamp(path)
	if err != nil || stampSame(stamp, m.titleStamp) {
		return
	}
	if stamp == nil {
		m.titles, m.titleStamp = nil, nil
		return
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	titles := map[string]string{}
	if _, err := decodeCodexActivityRecords(ctx, io.LimitReader(file, int64(stamp.Length)), func(row object) {
		if id, title := text(row, "id"), text(row, "thread_name"); id != "" && title != "" {
			titles[id] = title
		}
	}); err == nil {
		m.titles, m.titleStamp = titles, stamp
	}
}

func readNativeAgentActivity(ctx context.Context, s *service) (object, error) {
	defer beginRuntimeWork("activity")()
	ctx = withRuntimeCost(ctx, "activity", "poll")
	disabled, err := disabledNativeAgents()
	if err != nil {
		return nil, err
	}
	nowAt := time.Now()
	var rows []object
	if !slices.Contains(disabled, any("codex")) {
		if _, home, err := codexInputs(); err == nil {
			rows = s.codex.activity.sample(ctx, home, nowAt)
		}
	}
	byID := make(map[string]object, len(rows))
	for _, row := range rows {
		byID[text(row, "id")] = clone(row)
	}
	if !slices.Contains(disabled, any("codex")) {
		for thread, row := range nativeCodexLiveActivity(&s.events) {
			rollout := byID[thread]
			for _, key := range []string{"title", "project", "startedAt", "parentSessionId", "relationKind"} {
				if row[key] == nil || row[key] == "" {
					row[key] = rollout[key]
				}
			}
			if row["turnId"] == rollout["turnId"] && obj(rollout["dispatchSummary"]) != nil {
				summary := dispatchSetSection(row, "dispatchSummary")
				for key, value := range obj(rollout["dispatchSummary"]) {
					if summary[key] == nil {
						summary[key] = value
					}
				}
			}
			byID[thread] = row
		}
	}
	agents := object{}
	ids := []string{}
	if len(byID) > 0 {
		ids = append(ids, "codex")
		sessions := slices.Collect(maps.Values(byID))
		projects, _ := cachedNativeProjects(ctx, s)
		records, _ := s.readCodexTaskRecords(ctx)
		byTask := make(map[string]object, len(records))
		for _, record := range records {
			thread := str(dispatchFirstString(record["threadId"], field(record["task"], "threadId")))
			if byTask[thread] == nil {
				byTask[thread] = record
			}
		}
		for _, row := range sessions {
			thread := text(row, "id")
			if row["open"] == nil && ctx.Value(&peerControlKey) == nil {
				if navigation := nativeAgentNavigation("codex", thread); navigation != nil {
					row["open"] = navigation
				}
			}
			if name := localProjectName(projects, text(row, "project"), text(row, "projectId")); name != nil {
				row["projectName"] = name
			}
			if origin := taskSourceOrigin(thread, optionalProjectString(row["turnId"])); origin != nil {
				row["origin"] = origin
			}
			if record := byTask[thread]; record != nil {
				row["agentAccountId"] = record["agentAccountId"]
				if row["origin"] == nil {
					row["origin"] = record["origin"]
				}
				if row["source"] == "transcript" {
					row["source"], row["timeline"] = "codex-thread", true
				}
			}
		}
		slices.SortFunc(sessions, func(a, b object) int { return cmp.Compare(text(a, "id"), text(b, "id")) })
		agents["codex"] = object{"sessions": nativeActivitySessions(sessions)}
	}
	byAgent := map[string][]object{}
	ownedClaude := map[string]bool{}
	for _, process := range s.agents.processes() {
		task := process.snapshot()
		agent, taskID := text(task, "agent"), text(task, "taskId")
		if task["archived"] == true || slices.Contains(disabled, any(agent)) || !nativeAgentReadAllowed(ctx, agent, taskID) {
			continue
		}
		select {
		case <-process.done:
			continue
		default:
		}
		if !agentTurnActive(task) && len(decodedTaskList(task["pendingInteractions"])) == 0 {
			continue
		}
		var timeline taskTimeline
		_ = unmarshalJSON([]byte(wire(task["tracking"])), &timeline)
		info := object{"id": taskID, "taskId": taskID, "agent": agent, "title": task["title"], "project": task["cwd"], "startedAt": task["createdAt"]}
		row := timeline.session(taskID, info, "arc-task", nil)
		row["nativeSessionId"], row["agentAccountId"], row["origin"] = task["sessionId"], task["agentAccountId"], task["origin"]
		if agent == "claude" {
			ownedClaude[text(task, "sessionId")] = true
		}
		byAgent[agent] = append(byAgent[agent], row)
	}
	if ctx.Value(&peerControlKey) == nil && !slices.Contains(disabled, any("claude")) {
		if states, err := listNativeAgentStates("claude", true); err == nil {
			for _, task := range states {
				if task["archived"] == true {
					ownedClaude[text(task, "sessionId")] = true
				}
			}
		}
		for _, row := range s.agents.claudeActivity.sample(ctx, nowAt) {
			if !ownedClaude[text(row, "id")] {
				byAgent["claude"] = append(byAgent["claude"], clone(row))
			}
		}
	}
	for agent, sessions := range byAgent {
		ids = append(ids, agent)
		slices.SortFunc(sessions, func(a, b object) int { return cmp.Compare(text(a, "id"), text(b, "id")) })
		agents[agent] = object{"sessions": nativeActivitySessions(sessions)}
	}
	slices.Sort(ids)
	return object{"agents": agents, "activeAgents": ids, "observedAt": now(), "scope": "selected-local-transcripts-and-connector-live-sessions"}, nil
}

func nativeCodexLiveActivity(events *nativeEvents) map[string]object {
	pending := map[string]bool{}
	for _, request := range events.pendingInteractions() {
		if request["stale"] != true {
			pending[text(request["params"], "threadId")] = true
		}
	}
	events.Lock()
	defer events.Unlock()
	result := map[string]object{}
	for thread, timeline := range events.taskTimelines {
		if timeline.Status == "running" || timeline.Status == "inProgress" || pending[thread] {
			result[thread] = timeline.session(thread, timeline.Info, "codex-thread", nil)
		}
	}
	return result
}

type claudeActivityMonitor struct {
	sync.Mutex
	sampled time.Time
	files   map[string]nativeConversationMetadata
	active  []object
}

func (m *claudeActivityMonitor) sample(ctx context.Context, nowAt time.Time) []object {
	m.Lock()
	defer m.Unlock()
	if nowAt.Sub(m.sampled) < 2*time.Second {
		return slices.Clone(m.active)
	}
	m.sampled = nowAt
	paths := map[string]bool{}
	for _, dir := range nativeAgentTranscriptRoots("claude") {
		discoverCodexActivityPaths(dir, paths)
	}
	next, active := map[string]nativeConversationMetadata{}, []object{}
	seen := map[string]bool{}
	for _, path := range slices.Sorted(maps.Keys(paths)) {
		if ctx.Err() != nil {
			return slices.Clone(m.active)
		}
		if nativeTranscriptSidechain(path, nil) {
			continue
		}
		stamp, err := readStamp(path)
		if err != nil || stamp == nil || stamp.Modified == nil {
			continue
		}
		previous := m.files[path]
		if previous.row == nil && nowAt.Sub(time.Unix(stamp.Modified.Seconds, int64(stamp.Modified.Nanos))) > 5*time.Minute {
			continue
		}
		entry := previous
		if !stampSame(previous.stamp, stamp) {
			entry = nativeConversationMetadata{stamp, sampleClaudeActivityFile(ctx, path, stamp)}
		}
		if entry.row != nil {
			id := text(entry.row, "id")
			if !seen[id] {
				active, seen[id] = append(active, entry.row), true
			}
		}
		if len(next) < 128 || entry.row != nil {
			next[path] = entry
		}
	}
	m.files, m.active = next, active
	return slices.Clone(active)
}

func sampleClaudeActivityFile(ctx context.Context, path string, stamp *fileStamp) object {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	start := max(0, int64(stamp.Length)-agentNativeTail)
	records, err := nativeTranscriptRead(ctx, file, start, int64(stamp.Length)-start, start != 0, true)
	if err != nil {
		return nil
	}
	rows := make([]any, len(records))
	for i, record := range records {
		rows[i] = record
	}
	timeline := taskTimeline{Partial: start != 0}
	timeline.backfillClaude(rows)
	if !timeline.transcriptActive() {
		return nil
	}
	if current, err := readStamp(path); err != nil || !stampSame(stamp, current) && !current.appendsTo(stamp) {
		return nil
	}
	id := nonemptyTaskText(text(timeline.Info, "id"), strings.TrimSuffix(filepath.Base(path), ".jsonl"))
	if uuid.Validate(id) != nil {
		return nil
	}
	row := timeline.transcriptSession(id, "claude")
	if metadata := scanNativeAgentConversation(ctx, "claude", path); metadata != nil {
		row["title"], row["startedAt"] = metadata["title"], metadata["createdAt"]
	}
	return row
}

func nativeActivitySessions(sessions []object) []any {
	result := make([]any, len(sessions))
	for i, session := range sessions {
		result[i] = session
	}
	return result
}

func init() {
	registerRoute(http.MethodGet, "agents/activity", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return readNativeAgentActivity(ctx, s)
	})
}
