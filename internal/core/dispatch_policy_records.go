package core

import (
	"container/heap"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var dispatchRecordsMu sync.Mutex

// A supplies native lifecycle and conversation facts. B owns the transactional
// coordination projection written beside each dispatch and later-fix correlation.
var dispatchLifecycleOutcome func(object) string
var dispatchTrackConversation func(object) error
var dispatchSaveOwner func(string, object) error
var dispatchFixCorrelation func([]object, string) object

func dispatchOutcome(row object) string {
	if dispatchLifecycleOutcome != nil {
		return dispatchLifecycleOutcome(row)
	}
	if state := text(row["terminal"], "state"); state == "cancelled" {
		return "interrupted"
	} else {
		return state
	}
}

func dispatchSendTrigger(args object) any {
	if v, ok := args["trigger"].(string); ok {
		return v
	}
	return "unknown"
}

func dispatchRecordDir(thread string) (string, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return "", errors.New("INVALID_THREAD_ID")
	}
	return filepath.Join(root(), "dispatches", thread), nil
}

func dispatchCoordinationAdmission(base, thread, request string) (bool, error) {
	if _, err := uuid.Parse(thread); err != nil {
		return false, errors.New("INVALID_THREAD_ID")
	}
	if _, err := uuid.Parse(request); err != nil {
		return false, errors.New("INVALID_REQUEST_ID")
	}
	row, err := load(filepath.Join(base, "dispatches", thread, request+".json"))
	return obj(field(field(row, "coordination"), "association")) != nil, err
}

func readDispatchRecord(path string) (object, error) {
	value, err := load(path)
	if err != nil {
		return nil, err
	}
	row := obj(value)
	if row == nil {
		return nil, fmt.Errorf("INVALID_JSON: %s", path)
	}
	if importDispatchReview(row) {
		if err := save(path, row); err != nil {
			return nil, err
		}
	}
	return row, nil
}

func readDispatchRows(path string) ([]object, error) {
	files, err := os.ReadDir(path)
	results := []object{}
	if errors.Is(err, os.ErrNotExist) {
		return results, nil
	}
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		row, err := readDispatchRecord(filepath.Join(path, file.Name()))
		if err != nil {
			return nil, err
		}
		results = append(results, row)
	}
	slices.SortStableFunc(results, func(a, b object) int { return strings.Compare(text(a, "submittedAt"), text(b, "submittedAt")) })
	return results, nil
}

func readDispatchRecords(thread string) ([]object, error) {
	path, err := dispatchRecordDir(thread)
	if err != nil {
		return nil, err
	}
	return readDispatchRows(path)
}

func dispatchRecords(thread string) ([]object, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	return readDispatchRecords(thread)
}

func saveDispatchRecord(path string, row object) error {
	if dispatchSaveOwner != nil {
		return dispatchSaveOwner(path, row)
	}
	if obj(row["coordination"]) != nil {
		return errors.New(PortPending)
	}
	return save(path, row)
}

func recordDispatch(receipt object) error {
	if dispatchTrackConversation != nil {
		if err := dispatchTrackConversation(receipt); err != nil {
			return fmt.Errorf("SUBMISSION_UNCONFIRMED: dispatch accepted; conversation record failed: %w", err)
		}
	}
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	if err := recordDispatchLocked(receipt); err != nil {
		return fmt.Errorf("SUBMISSION_UNCONFIRMED: dispatch accepted; record failed: %w", err)
	}
	return nil
}

func recordDispatchLocked(receipt object) error {
	thread, request := text(receipt, "threadId"), text(receipt, "requestId")
	path, err := dispatchRecordDir(thread)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(request); err != nil {
		return errors.New("INVALID_REQUEST_ID")
	}
	previous, err := readDispatchRows(path)
	if err != nil {
		return err
	}
	row := clone(obj(field(receipt["task"], "dispatch")))
	if row == nil {
		row = object{}
	}
	for _, key := range []string{"requestId", "threadId", "turnId", "dispatchMode", "coordination", "origin", "agentAccountId"} {
		row[key] = receipt[key]
	}
	if op, exists := receipt["operation"]; exists {
		row["operation"] = op
	}
	row["acceptedAt"] = dispatchFirstString(row["submittedAt"], now())
	row["title"] = dispatchTitle(obj(receipt["task"]))
	row["agent"] = dispatchRowAgent(receipt)
	if validateDispatchCaller != nil {
		if caller := validateDispatchCaller(receipt["caller"]); caller != nil {
			row["caller"] = caller
		}
	}
	row["taskId"] = thread
	if taskID, exists := receipt["taskId"]; exists {
		row["taskId"] = taskID
	}
	if row["options"] == nil {
		row["options"] = object{}
	}
	row["configurationEvidence"] = "submitted-to-native"
	if row["dispatchMode"] == "steered" {
		row["configurationEvidence"] = "active-turn-settings"
	}
	row["purpose"] = "task"
	if len(previous) > 0 {
		last := previous[len(previous)-1]
		if purpose, exists := last["purpose"]; exists {
			row["purpose"] = purpose
		}
		if pack := clone(obj(last["pack"])); row["pack"] == nil && pack != nil {
			pack["inherited"], pack["appendedChars"] = true, 0
			row["pack"] = pack
		}
	}
	if purpose, exists := obj(receipt["arguments"])["purpose"]; exists {
		row["purpose"] = purpose
	}
	return saveDispatchRecord(filepath.Join(path, request+".json"), row)
}

func dispatchTurnFact(task, turn, key string) object {
	rows, err := dispatchRecords(task)
	if err != nil {
		return nil
	}
	for _, row := range slices.Backward(rows) {
		fact := obj(row[key])
		if row["turnId"] != turn || fact == nil {
			continue
		}
		if key != "pack" {
			return fact
		}
		pack := object{"name": fact["name"], "review": fact["review"]}
		if fact["inherited"] == true {
			pack["inherited"] = true
		}
		return pack
	}
	return nil
}

func dispatchHistoryTime(row object) (time.Time, error) {
	at := text(row, "submittedAt")
	if row["dispatchOrigin"] == "external" {
		at = text(row["review"], "reviewedAt")
	}
	return time.Parse(time.RFC3339Nano, at)
}

type dispatchDatedRow struct {
	at   time.Time
	path string
	row  object
}

type dispatchHistoryHeap []dispatchDatedRow

func (h dispatchHistoryHeap) Len() int { return len(h) }
func (h dispatchHistoryHeap) Less(i, j int) bool {
	if h[i].at.Equal(h[j].at) {
		return h[i].path < h[j].path
	}
	return h[i].at.Before(h[j].at)
}
func (h dispatchHistoryHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *dispatchHistoryHeap) Push(value any) { *h = append(*h, value.(dispatchDatedRow)) }
func (h *dispatchHistoryHeap) Pop() any {
	last := len(*h) - 1
	row := (*h)[last]
	(*h)[last] = dispatchDatedRow{}
	*h = (*h)[:last]
	return row
}

func dispatchHistoryRows(cutoff time.Time) ([]object, error) {
	dispatchRecordsMu.Lock()
	defer dispatchRecordsMu.Unlock()
	newest := dispatchHistoryHeap{}
	for _, kind := range []string{"dispatches", "reviews"} {
		dir := filepath.Join(root(), kind)
		threads, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, thread := range threads {
			if !thread.IsDir() {
				continue
			}
			threadDir := filepath.Join(dir, thread.Name())
			entries, err := os.ReadDir(threadDir)
			if err != nil {
				return nil, err
			}
			for _, entry := range entries {
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
					continue
				}
				info, err := entry.Info()
				if err != nil {
					return nil, err
				}
				if info.ModTime().Before(cutoff) {
					continue
				}
				path := filepath.Join(threadDir, entry.Name())
				row, err := readDispatchRecord(path)
				if err != nil {
					return nil, err
				}
				at, err := dispatchHistoryTime(row)
				if err != nil {
					at = info.ModTime()
				}
				if !at.Before(cutoff) {
					heap.Push(&newest, dispatchDatedRow{at, path, row})
					if newest.Len() > dispatchHistoryLimit+1 {
						heap.Pop(&newest)
					}
				}
			}
		}
	}
	rows := make([]object, newest.Len())
	for i := len(rows) - 1; i >= 0; i-- {
		rows[i] = heap.Pop(&newest).(dispatchDatedRow).row
	}
	return rows, nil
}

type dispatchGroupKey struct{ model, effort, tier, options string }
type dispatchGroup struct {
	dispatches, pass, rework, failed, interrupted uint64
	durations                                     []uint64
	external, externalPass, externalRework        uint64
	usageSamples, input, output, cache            uint64
	cost                                          float64
}

func (g *dispatchGroup) observe(row object, external bool) {
	verdict := text(row["review"], "verdict")
	if external {
		g.external++
		switch verdict {
		case "pass":
			g.externalPass++
		case "rework":
			g.externalRework++
		}
		return
	}
	g.dispatches++
	switch verdict {
	case "pass":
		g.pass++
	case "rework":
		g.rework++
	}
	switch dispatchOutcome(row) {
	case "failed":
		g.failed++
	case "interrupted":
		g.interrupted++
	case "completed":
		if duration, ok := uintValue(field(row["terminal"], "observedDurationMs")); ok {
			g.durations = append(g.durations, duration)
		}
		if u := obj(row["usage"]); uintOr(u["calls"], 0) > 0 {
			g.usageSamples++
			g.input += uintOr(u["inputTokens"], 0)
			g.output += uintOr(u["outputTokens"], 0)
			g.cache += uintOr(u["cacheReadTokens"], 0)
			cost, _ := dispatchNumber(u["costUsd"])
			g.cost += cost
		}
	}
}

func (g *dispatchGroup) merge(other *dispatchGroup) {
	g.dispatches += other.dispatches
	g.pass += other.pass
	g.rework += other.rework
	g.failed += other.failed
	g.interrupted += other.interrupted
	g.external += other.external
	g.externalPass += other.externalPass
	g.externalRework += other.externalRework
	g.durations = append(g.durations, other.durations...)
	g.usageSamples += other.usageSamples
	g.input += other.input
	g.output += other.output
	g.cache += other.cache
	g.cost += other.cost
}

func (g *dispatchGroup) median() float64 {
	slices.Sort(g.durations)
	n := len(g.durations)
	return (float64(g.durations[(n-1)/2]) + float64(g.durations[n/2])) / 2
}

func dispatchConfigurationFact(row object, key string) string {
	if v := str(dispatchFirstString(field(row["turnEvidence"], key), field(row["effectiveConfiguration"], key))); v != "" && v != "unknown" {
		return v
	}
	return text(row, key)
}

func summarizeDispatchHistory(rows []object, agent string, compact bool, cutoff time.Time) object {
	groups := make(map[dispatchGroupKey]*dispatchGroup)
	seen := make(map[[2]string]bool)
	for _, row := range rows[:min(len(rows), dispatchHistoryLimit)] {
		external := row["dispatchOrigin"] == "external"
		if dispatchRowAgent(row) != agent || (!external && agent != "codex" && row["submission"] != "accepted") ||
			row["purpose"] == "self-test" || (!external && row["dispatchMode"] != "new-turn") {
			continue
		}
		at, err := dispatchHistoryTime(row)
		turn := [2]string{text(row, "threadId"), text(row, "turnId")}
		if err != nil || at.Before(cutoff) || seen[turn] {
			continue
		}
		seen[turn] = true
		model, effort, tier := dispatchConfigurationFact(row, "model"), dispatchConfigurationFact(row, "effort"), dispatchConfigurationFact(row, "serviceTier")
		if external && (model == "" || model == "unknown" || effort == "" || effort == "unknown") {
			continue
		}
		if agent != "codex" {
			effort = ""
		}
		if tier == "" {
			tier = "unknown"
		}
		options := "{}"
		if value, exists := row["options"]; exists {
			options = wire(value)
		}
		key := dispatchGroupKey{model, effort, tier, options}
		if groups[key] == nil {
			groups[key] = &dispatchGroup{}
		}
		groups[key].observe(row, external)
	}
	rankedKeys := func() []dispatchGroupKey {
		keys := make([]dispatchGroupKey, 0, len(groups))
		for key := range groups {
			keys = append(keys, key)
		}
		slices.SortFunc(keys, func(a, b dispatchGroupKey) int {
			left, right := groups[a], groups[b]
			if left.dispatches+left.external > right.dispatches+right.external {
				return -1
			}
			if left.dispatches+left.external < right.dispatches+right.external {
				return 1
			}
			for _, pair := range [][2]string{{a.model, b.model}, {a.effort, b.effort}, {a.tier, b.tier}, {a.options, b.options}} {
				if pair[0] != pair[1] {
					return strings.Compare(pair[0], pair[1])
				}
			}
			return 0
		})
		return keys
	}
	if compact {
		kept := 0
		var other dispatchGroup
		for _, key := range rankedKeys() {
			group := groups[key]
			if group.dispatches >= 10 && kept < 6 {
				kept++
			} else {
				other.merge(group)
				delete(groups, key)
			}
		}
		if other.dispatches+other.external > 0 {
			groups[dispatchGroupKey{model: "other", options: "{}"}] = &other
		}
	}
	result := []any{}
	for _, key := range rankedKeys() {
		g := groups[key]
		var options any
		_ = unmarshalJSON([]byte(key.options), &options)
		row := object{"agent": agent, "model": key.model, "effort": key.effort, "serviceTier": key.tier, "options": options,
			"dispatches": g.dispatches, "pass": g.pass, "rework": g.rework, "failed": g.failed, "interrupted": g.interrupted, "unreviewed": g.dispatches - g.pass - g.rework}
		if g.external > 0 {
			row["external"] = object{"reviews": g.external, "pass": g.externalPass, "rework": g.externalRework}
		}
		if len(g.durations) > 0 {
			row["medianObservedDurationMs"], row["durationSamples"] = g.median(), len(g.durations)
		}
		if g.usageSamples > 0 {
			row["usage"] = object{"samples": g.usageSamples, "inputTokens": g.input, "outputTokens": g.output, "cacheReadTokens": g.cache,
				"costUsd": math.Round(g.cost*1_000_000) / 1_000_000}
		}
		result = append(result, row)
	}
	quality := dispatchQualityHistory(rows, agent, cutoff)
	if dispatchFixCorrelation != nil {
		selected := []object{}
		for _, r := range rows[:min(len(rows), dispatchHistoryLimit)] {
			if at, err := time.Parse(time.RFC3339Nano, text(r, "submittedAt")); dispatchRowAgent(r) == agent && err == nil && !at.Before(cutoff) {
				selected = append(selected, r)
			}
		}
		quality["laterFixCorrelation"] = dispatchFixCorrelation(selected, filepath.Join(root(), "coordination/ref-watch/quality-correlations.json"))
	}
	return object{"windowDays": 30, "excludedPurpose": "self-test", "groups": result, "quality": quality, "coverage": quality["coverage"]}
}

func summarizeDispatchPacks(rows []object, cutoff time.Time) map[string]string {
	grouped := make(map[string]*dispatchGroup)
	seen := make(map[[2]string]bool)
	for _, row := range rows[:min(len(rows), dispatchHistoryLimit)] {
		name, hasPack := field(row["pack"], "name").(string)
		if !hasPack || row["dispatchOrigin"] == "external" || row["purpose"] == "self-test" || row["dispatchMode"] != "new-turn" ||
			(dispatchRowAgent(row) != "codex" && row["submission"] != "accepted") {
			continue
		}
		at, err := dispatchHistoryTime(row)
		key := [2]string{text(row, "threadId"), text(row, "turnId")}
		if err != nil || at.Before(cutoff) || seen[key] {
			continue
		}
		seen[key] = true
		if grouped[name] == nil {
			grouped[name] = &dispatchGroup{}
		}
		grouped[name].observe(row, false)
	}
	result := make(map[string]string, len(grouped))
	for name, g := range grouped {
		line := fmt.Sprintf("n%d", g.dispatches)
		if len(g.durations) > 0 {
			line += fmt.Sprintf(" med%.1fm", g.median()/60000)
		}
		line += fmt.Sprintf(" pass%d rework%d unrev%d", g.pass, g.rework, g.dispatches-g.pass-g.rework)
		if g.failed > 0 {
			line += fmt.Sprintf(" fail%d", g.failed)
		}
		if g.interrupted > 0 {
			line += fmt.Sprintf(" int%d", g.interrupted)
		}
		result[name] = line
	}
	return result
}

func dispatchRevisitMinutes(receipt object) any {
	selection := obj(receipt["dispatch"])
	if selection == nil {
		selection = obj(field(receipt["result"], "dispatch"))
	}
	if selection == nil {
		return nil
	}
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	rows, err := dispatchHistoryRows(cutoff)
	if err != nil {
		return nil
	}
	history := summarizeDispatchHistory(rows, dispatchRowAgent(receipt), false, cutoff)
	options := selection["options"]
	if _, exists := selection["options"]; !exists {
		options = object{}
	}
	var sample object
	for _, item := range arr(history["groups"]) {
		row := obj(item)
		if field(row, "model") != selection["model"] || text(row, "effort") != text(selection, "effort") || wire(row["options"]) != wire(options) ||
			(text(selection, "serviceTier") != "" && row["serviceTier"] != selection["serviceTier"]) {
			continue
		}
		if sample != nil {
			return nil
		}
		sample = row
	}
	if ms, ok := dispatchNumber(sample["medianObservedDurationMs"]); ok {
		return uint64(max(math.Ceil(ms/60000), 1))
	}
	return nil
}

func init() {
	applyPriorDispatchPurpose = func(thread string, args object) error {
		rows, err := dispatchRecords(thread)
		if err == nil && len(rows) != 0 && rows[len(rows)-1]["purpose"] == "self-test" {
			args["purpose"] = "self-test"
		}
		return err
	}
	controlRevisitMinutes = dispatchRevisitMinutes
}
