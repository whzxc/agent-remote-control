package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const controlMetricsDays = 30
const controlMetricsBytes = 64 << 20
const sequenceGap = 5 * time.Minute

var metricID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
var controlMetricsMu sync.Mutex

func metricIdentifier(value any) any {
	if value, ok := value.(string); ok && metricID.MatchString(value) {
		return value
	}
	return nil
}

func metricString(value any, fallback string) string {
	if value, ok := value.(string); ok {
		return value
	}
	return fallback
}

func dispatchMetricOp(name string) bool {
	return slices.Contains([]string{"codex_create", "codex_send", "agent_create", "agent_send"}, name)
}

type controlCallMetric struct {
	started time.Time
	row     object
}

func beginControlMetric(source requestSource, tool string, envelope any) controlCallMetric {
	started := time.Now()
	op := text(envelope, "op")
	args := obj(field(envelope, "args"))
	if tool == "guide" {
		op, args = "guide", obj(envelope)
	}
	if operation(op) == nil {
		op = "unknown"
	}
	var cacheScope, guideLayer, dispatch any
	switch op {
	case "guide":
		cacheScope = []any{metricIdentifier(args["op"]), metricString(args["topic"], "loop"), metricString(args["view"], "compact")}
		guideLayer = 1
		if _, ok := args["op"].(string); ok {
			guideLayer = 2
		} else if args["view"] == "full" {
			guideLayer = 3
		}
	case "dispatch_policy":
		cacheScope = []any{metricIdentifier(args["agent"]), metricIdentifier(args["taskId"]), metricString(args["view"], "decision"), args["all"] == true}
	}
	if dispatchMetricOp(op) {
		dispatch = "pending"
	}
	if cacheScope != nil {
		cacheScope = hash([]byte(wire(cacheScope)))
	}
	requestID, exists := obj(envelope)["requestId"]
	if !exists {
		requestID = args["requestId"]
	}
	_, cachedGuide := args["knownGuideHash"].(string)
	_, cachedCriteria := args["knownCriteriaHash"].(string)
	profile := effectiveProfile(source.origin, source.profile, source.local)
	row := object{
		"time": started.UnixMilli(), "callId": id(), "sourceId": metricIdentifier(source.origin["sourceId"]),
		"controlSource": metricIdentifier(source.origin["controlSource"]), "profile": profile["name"], "transport": profile["transport"],
		"guideLayer": guideLayer, "dispatchOutcome": dispatch, "op": op, "via": tool,
		"requestBytes": len(wire(object{"name": tool, "arguments": envelope})), "requestId": metricIdentifier(requestID),
		"threadId": metricIdentifier(args["threadId"]), "taskId": metricIdentifier(args["taskId"]), "agent": metricIdentifier(args["agent"]),
		"cacheScope": cacheScope, "cacheRequested": cachedGuide || cachedCriteria || obj(args["knownCriteriaHash"]) != nil, "arcVersion": arcVersion(),
	}
	return controlCallMetric{started, row}
}

func (m controlCallMetric) finish(ctx context.Context, response object) {
	row := m.row
	row["durationMs"], row["completedAt"] = time.Since(m.started).Milliseconds(), time.Now().UnixMilli()
	switch {
	case ctx.Err() != nil:
		row["errorCode"] = "CANCELLED"
		if row["dispatchOutcome"] != nil {
			row["dispatchOutcome"] = "unconfirmed"
		}
	case response == nil:
		row["errorCode"] = "TRANSPORT_ERROR"
		if row["dispatchOutcome"] != nil {
			row["dispatchOutcome"] = "unconfirmed"
		}
	default:
		var result object
		textBytes := 0
		for _, block := range arr(response["content"]) {
			data := text(block, "text")
			textBytes += len(data)
			if result == nil && field(block, "type") == "text" {
				_ = decodeObject([]byte(data), &result)
			}
		}
		row["responseBytes"], row["textBytes"], row["structuredContentBytes"] = len(wire(response)), textBytes, 0
		for _, name := range []string{"threadId", "taskId", "requestId", "agent"} {
			if value, exists := result[name]; exists {
				row[name] = metricIdentifier(value)
			}
		}
		failure, exists := result["error"]
		if !exists {
			failure = field(result["result"], "error")
		}
		row["errorCode"] = metricIdentifier(field(failure, "code"))
		if row["errorCode"] == nil && response["isError"] == true {
			row["errorCode"] = "TOOL_ERROR"
		}
		row["cacheHash"] = controlMetricHash(result)
		if row["dispatchOutcome"] != nil || dispatchReceipt(result) {
			switch {
			case row["errorCode"] != nil:
				row["dispatchOutcome"] = "failed"
			case result["state"] == "completed" && result["turnId"] != nil && (result["threadId"] != nil || result["taskId"] != nil):
				row["dispatchOutcome"] = "submitted"
			default:
				row["dispatchOutcome"] = "pending"
			}
		}
	}
	if err := appendControlMetric(row); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot persist control-call metrics")
	}
}

func controlMetricHash(value object) any {
	if digest, ok := value["guideHash"].(string); ok {
		return digest
	}
	criteria := []string{}
	for _, agent := range arr(value["agents"]) {
		value, exists := obj(agent)["criteriaHash"]
		if !exists {
			value = field(field(agent, "policy"), "criteriaHash")
		}
		if digest, ok := value.(string); ok {
			criteria = append(criteria, wire([]any{metricIdentifier(field(agent, "agent")), digest}))
		}
	}
	if global, ok := value["criteriaHash"].(string); ok {
		criteria = append(criteria, wire([]string{"global", global}))
	}
	if len(criteria) == 0 {
		return nil
	}
	slices.Sort(criteria)
	return hash([]byte("[" + strings.Join(criteria, ",") + "]"))
}

func controlMetricDirectory() string { return filepath.Join(root(), "control-metrics") }

func pruneControlMetrics() ([]string, error) {
	dir := controlMetricDirectory()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	type metricFile struct {
		name  string
		bytes int64
	}
	var files []metricFile
	var total int64
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || len(name) < 16 || filepath.Ext(name) != ".jsonl" {
			continue
		}
		if _, err := time.Parse(time.DateOnly, name[:10]); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		files = append(files, metricFile{name, info.Size()})
		total += info.Size()
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -controlMetricsDays).Format(time.DateOnly)
	paths := []string{}
	for _, file := range files {
		path := filepath.Join(dir, file.name)
		if file.name[:10] < cutoff || total > controlMetricsBytes {
			if err := os.Remove(path); err != nil {
				return nil, err
			}
			total -= file.bytes
		} else {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

func appendControlMetric(row object) error {
	controlMetricsMu.Lock()
	defer controlMetricsMu.Unlock()
	dir := controlMetricDirectory()
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	today := time.Now().UTC().Format(time.DateOnly)
	path := filepath.Join(dir, today+".jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() >= 2<<20 {
		if err := os.Rename(path, filepath.Join(dir, today+"."+id()+".jsonl")); err != nil {
			return err
		}
	}
	if _, err := pruneControlMetrics(); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = file.WriteString(wire(row) + "\n")
	return errors.Join(err, file.Close())
}

func metricDuration(value string) (time.Duration, error) {
	if len(value) < 2 {
		return 0, errors.New("Expected duration such as 1h or 7d")
	}
	count, err := strconv.ParseInt(value[:len(value)-1], 10, 64)
	if err != nil {
		return 0, errors.New("Expected duration such as 1h or 7d")
	}
	scale := map[byte]time.Duration{'m': time.Minute, 'h': time.Hour, 'd': 24 * time.Hour}[value[len(value)-1]]
	if scale == 0 {
		return 0, errors.New("Expected duration using m, h, or d")
	}
	if count <= 0 || count > int64((controlMetricsDays*24*time.Hour)/scale) {
		return 0, errors.New("Duration must be positive and at most 30d")
	}
	return time.Duration(count) * scale, nil
}

func metricMillis(row object, key string) int64 {
	n, _ := strconv.ParseInt(wire(row[key]), 10, 64)
	return n
}

func controlMetricsReport(since string) (object, error) {
	duration, err := metricDuration(since)
	if err != nil {
		return nil, err
	}
	controlMetricsMu.Lock()
	defer controlMetricsMu.Unlock()
	paths, err := pruneControlMetrics()
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().Add(-duration).UnixMilli()
	var rows []object
	malformed := 0
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		lines := bufio.NewScanner(file)
		lines.Buffer(make([]byte, 8192), 2<<20)
		for lines.Scan() {
			var row object
			if err := decodeObject(lines.Bytes(), &row); err != nil {
				malformed++
			} else if metricMillis(row, "time") >= cutoff {
				rows = append(rows, row)
			}
		}
		if lines.Err() != nil {
			malformed++
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
	}
	slices.SortStableFunc(rows, func(a, b object) int { return int(metricMillis(a, "time") - metricMillis(b, "time")) })
	return summarizeControlMetrics(rows, since, malformed), nil
}

func addMetric(total object, name string, amount uint64) {
	total[name] = uintOr(total[name], 0) + amount
}

func addCallMetrics(total, row object) {
	for _, key := range []string{"requestBytes", "responseBytes", "textBytes", "structuredContentBytes", "durationMs"} {
		addMetric(total, key, uintOr(row[key], 0))
	}
	addMetric(total, "calls", 1)
	amount := uint64(0)
	if _, ok := row["errorCode"].(string); ok {
		amount = 1
	}
	addMetric(total, "errors", amount)
}

func metricValues(values map[string]object) []object {
	result := make([]object, 0, len(values))
	for _, key := range slices.Sorted(maps.Keys(values)) {
		result = append(result, values[key])
	}
	return result
}

func summarizeControlMetrics(rows []object, since string, malformed int) object {
	total := object{"calls": 0, "errors": 0, "requestBytes": 0, "responseBytes": 0, "textBytes": 0, "structuredContentBytes": 0, "durationMs": 0}
	sources, ops, days, previous, requests, tasks := map[string]object{}, map[string]object{}, map[string]object{}, map[string]object{}, map[string]object{}, map[string]object{}
	type retryKey struct{ source, op string }
	type cacheKey struct{ source, op, scope string }
	argumentErrors, cached := map[retryKey]int64{}, map[cacheKey]string{}
	patterns := object{"sequences": 0, "lookupThenAct": 0, "unchangedReads": 0, "uncachedUnchangedReads": 0, "argumentErrorRetries": 0}
	for _, row := range rows {
		if row["requestId"] != nil && (row["threadId"] != nil || row["taskId"] != nil) {
			requests[text(row, "sourceId")+":"+text(row, "requestId")] = row
		}
	}
	bucket := func(items map[string]object, key string, initial object) object {
		if items[key] == nil {
			items[key] = initial
		}
		return items[key]
	}
	gap := sequenceGap.Milliseconds()
	for _, row := range rows {
		addCallMetrics(total, row)
		at := metricMillis(row, "time")
		source, op := text(row, "sourceId"), text(row, "op")
		day := time.UnixMilli(at).UTC().Format(time.DateOnly)
		addCallMetrics(bucket(sources, source, object{"sourceId": source, "controlSource": row["controlSource"]}), row)
		addCallMetrics(bucket(ops, op, object{"op": op}), row)
		addCallMetrics(bucket(days, day, object{"day": day}), row)
		last := previous[source]
		if last != nil && at-metricMillis(last, "completedAt") <= gap {
			if last["op"] == "projects" && row["via"] == "act" {
				addMetric(patterns, "lookupThenAct", 1)
			}
		} else {
			addMetric(patterns, "sequences", 1)
			maps.DeleteFunc(argumentErrors, func(k retryKey, _ int64) bool { return source == k.source })
			maps.DeleteFunc(cached, func(k cacheKey, _ string) bool { return source == k.source })
		}
		retry := retryKey{source, op}
		if prev, ok := argumentErrors[retry]; ok {
			delete(argumentErrors, retry)
			if at-prev <= gap {
				addMetric(patterns, "argumentErrorRetries", 1)
			}
		}
		if row["errorCode"] == "INVALID_ARGUMENTS" {
			argumentErrors[retry] = at
		}
		if digest, ok := row["cacheHash"].(string); ok {
			key := cacheKey{source, op, text(row, "cacheScope")}
			if prior, exists := cached[key]; exists && prior == digest {
				addMetric(patterns, "unchangedReads", 1)
				if row["cacheRequested"] != true {
					addMetric(patterns, "uncachedUnchangedReads", 1)
				}
			}
			cached[key] = digest
		}
		association := requests[source+":"+text(row, "requestId")]
		if association == nil {
			association = row
		}
		task := metricString(association["threadId"], text(association, "taskId"))
		if task != "" {
			key := source + ":" + task
			if op == "codex_create" || op == "agent_create" {
				bucket(tasks, key, object{"sourceId": source, "taskId": task, "createdAt": row["time"], "reviewed": false})
			}
			if tracked := tasks[key]; tracked != nil && tracked["reviewed"] != true {
				addCallMetrics(tracked, row)
				if (op == "codex_review" || op == "agent_review") && row["errorCode"] == nil {
					tracked["reviewed"], tracked["reviewedAt"] = true, row["completedAt"]
				}
			}
		}
		previous[source] = row
	}
	return object{"profileSequences": metricProfileSequences(rows), "since": since, "retentionDays": controlMetricsDays,
		"maxBytes": controlMetricsBytes, "sequenceGapSeconds": int(sequenceGap.Seconds()), "metadataOnly": true,
		"malformedRows": malformed, "totals": total, "bySource": metricValues(sources), "byOp": metricValues(ops),
		"byDay": metricValues(days), "wasteCandidates": patterns, "tasks": metricValues(tasks)}
}

func metricProfileSequences(rows []object) object {
	sequences := []object{}
	latest := map[string]int{}
	type sequenceOp struct {
		index int
		op    string
	}
	previousError := map[sequenceOp]int64{}
	gap := sequenceGap.Milliseconds()
	for _, row := range rows {
		source, op := text(row, "sourceId"), text(row, "op")
		profile, transport := metricString(row["profile"], "legacy"), metricString(row["transport"], "unknown")
		at := metricMillis(row, "time")
		index, exists := latest[source]
		if !exists || at-metricMillis(sequences[index], "completedAt") > gap || sequences[index]["profile"] != profile || sequences[index]["transport"] != transport {
			index = len(sequences)
			latest[source] = index
			sequences = append(sequences, object{"sourceId": source, "profile": profile, "transport": transport, "startedAt": at, "calls": 0,
				"guideResponseBytes": 0, "guideTextBytes": 0, "guideStructuredContentBytes": 0, "guideCalls": 0, "cachedGuideCalls": 0,
				"invalidArguments": 0, "argumentErrorRetries": 0, "dispatchAttempts": 0, "dispatchErrors": 0, "callsBeforeFirstDispatch": nil})
		}
		sequence := sequences[index]
		if sequence["callsBeforeFirstDispatch"] == nil && row["dispatchOutcome"] == "submitted" {
			sequence["callsBeforeFirstDispatch"] = sequence["calls"]
		}
		addMetric(sequence, "calls", 1)
		sequence["completedAt"] = row["completedAt"]
		if op == "guide" {
			for output, input := range map[string]string{"guideResponseBytes": "responseBytes", "guideTextBytes": "textBytes", "guideStructuredContentBytes": "structuredContentBytes"} {
				addMetric(sequence, output, uintOr(row[input], 0))
			}
			addMetric(sequence, "guideCalls", 1)
			if row["cacheRequested"] == true {
				addMetric(sequence, "cachedGuideCalls", 1)
			}
		}
		key := sequenceOp{index, op}
		if prev, ok := previousError[key]; ok {
			delete(previousError, key)
			if at-prev <= gap {
				addMetric(sequence, "argumentErrorRetries", 1)
			}
		}
		if row["errorCode"] == "INVALID_ARGUMENTS" {
			addMetric(sequence, "invalidArguments", 1)
			previousError[key] = at
		}
		if dispatchMetricOp(op) {
			addMetric(sequence, "dispatchAttempts", 1)
			if _, ok := row["errorCode"].(string); ok {
				addMetric(sequence, "dispatchErrors", 1)
			}
		}
	}
	grouped := map[string][]object{}
	for _, sequence := range sequences {
		key := text(sequence, "profile") + ":" + text(sequence, "transport")
		grouped[key] = append(grouped[key], sequence)
	}
	cohorts := []object{}
	for _, key := range slices.Sorted(maps.Keys(grouped)) {
		rows := grouped[key]
		cohort := object{"profile": rows[0]["profile"], "transport": rows[0]["transport"], "sequences": len(rows),
			"withoutSuccessfulDispatch": 0, "argumentErrorRetriesPer100DispatchAttempts": nil}
		for _, row := range rows {
			if row["callsBeforeFirstDispatch"] == nil {
				addMetric(cohort, "withoutSuccessfulDispatch", 1)
			}
			for _, field := range []string{"dispatchAttempts", "dispatchErrors", "invalidArguments", "argumentErrorRetries"} {
				addMetric(cohort, field, uintOr(row[field], 0))
			}
		}
		for _, field := range []string{"guideResponseBytes", "guideTextBytes", "guideStructuredContentBytes", "callsBeforeFirstDispatch"} {
			var values []uint64
			for _, row := range rows {
				if value, ok := uintValue(row[field]); ok {
					values = append(values, value)
				}
			}
			slices.Sort(values)
			var median, p95 any
			if len(values) != 0 {
				median, p95 = values[(len(values)*50+99)/100-1], values[(len(values)*95+99)/100-1]
			}
			cohort[field] = object{"median": median, "p95": p95, "samples": len(values)}
		}
		if attempts := uintOr(cohort["dispatchAttempts"], 0); attempts != 0 {
			cohort["argumentErrorRetriesPer100DispatchAttempts"] = float64(uintOr(cohort["argumentErrorRetries"], 0)) * 100 / float64(attempts)
		}
		cohorts = append(cohorts, cohort)
	}
	return object{"sessionProxy": true, "gapSeconds": int(sequenceGap.Seconds()), "sequences": sequences, "cohorts": cohorts}
}
