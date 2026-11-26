package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const logMaxBytes = 16 * 1024 * 1024

var logLock sync.Mutex
var logPruned time.Time

func appendLogLocked(row any) error {
	dir := filepath.Join(root(), "logs")
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	at := time.Now().UTC()
	day := at.Format("2006-01-02")
	active := filepath.Join(dir, day+".jsonl")
	if info, err := os.Stat(active); err == nil && info.Size() >= 2*1024*1024 {
		if err := os.Rename(active, filepath.Join(dir, fmt.Sprintf("%s.%d.jsonl", day, at.UnixMilli()))); err != nil {
			return err
		}
	}
	if time.Since(logPruned) >= time.Minute {
		if err := pruneLogs(dir, active, at); err != nil {
			return err
		}
		logPruned = time.Now()
	}
	file, err := os.OpenFile(active, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = io.WriteString(file, wire(row)+"\n")
	return errors.Join(err, file.Close())
}

func pruneLogs(dir, active string, at time.Time) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type logFile struct {
		name string
		size int64
	}
	var files []logFile
	var total int64
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".jsonl") || len(name) < 10 {
			continue
		}
		if _, err := time.Parse("2006-01-02", name[:10]); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files = append(files, logFile{name, info.Size()})
		total += info.Size()
	}
	cutoff := at.AddDate(0, 0, -7).Format("2006-01-02")
	for _, file := range files {
		path := filepath.Join(dir, file.name)
		if path != active && (file.name[:10] < cutoff || total > logMaxBytes) {
			if os.Remove(path) == nil {
				total -= file.size
			}
		}
	}
	return nil
}

func appendLog(row object) error {
	logLock.Lock()
	defer logLock.Unlock()
	return appendLogLocked(row)
}

func recordLog(level, message string, ingress any) {
	logLock.Lock()
	err := appendLogLocked(object{"time": now(), "level": level, "msg": message, "ingressId": ingress})
	logLock.Unlock()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot persist diagnostics:", err)
	}
}

func migrateLogs(dir, ingress string) error {
	logLock.Lock()
	defer logLock.Unlock()
	path := filepath.Join(dir, "logs.json")
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	rows, ok := value.([]any)
	if !ok {
		return errors.New("invalid connection logs")
	}
	for _, line := range rows {
		s, ok := line.(string)
		if !ok {
			return errors.New("invalid log line")
		}
		var row object
		if err := canonjson.Unmarshal([]byte(s), &row); err != nil {
			return err
		}
		if row == nil {
			return errors.New("invalid log line")
		}
		row["ingressId"] = ingress
		if err := appendLogLocked(row); err != nil {
			return err
		}
	}
	return os.Remove(path)
}

func skipLogRow(row object) bool {
	switch text(row, "msg") {
	case "POST runtime/lease: started", "POST runtime/lease: succeeded":
		return row["level"] == "INFO"
	}
	return false
}

func recentLogs(ingress *string) []string {
	logLock.Lock()
	defer logLock.Unlock()
	dir := filepath.Join(root(), "logs")
	entries, _ := os.ReadDir(dir)
	rows := []string{}
	for index := len(entries) - 1; index >= 0 && len(rows) < 200; index-- {
		name := entries[index].Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		file, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			continue
		}
		_, seekErr := file.Seek(max(info.Size()-256*1024, 0), io.SeekStart)
		data, readErr := io.ReadAll(file)
		file.Close()
		if seekErr != nil || readErr != nil {
			continue
		}
		lines := bytes.Split(data, []byte{'\n'})
		for index := len(lines) - 1; index >= 0 && len(rows) < 200; index-- {
			var row object
			if canonjson.Unmarshal(lines[index], &row) != nil || row == nil || skipLogRow(row) {
				continue
			}
			if ingress == nil || row["ingressId"] == *ingress {
				rows = append(rows, wire(row))
			}
		}
	}
	slices.Reverse(rows)
	return rows
}

func parseLogSince(value string, at time.Time) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC(), nil
	}
	for _, unit := range []struct {
		suffix string
		millis int64
	}{{"ms", 1}, {"s", 1000}, {"m", 60000}, {"h", 3600000}, {"d", 86400000}} {
		number, ok := strings.CutSuffix(value, unit.suffix)
		if !ok {
			continue
		}
		count, err := strconv.ParseUint(number, 10, 63)
		if err != nil || count > uint64(math.MaxInt64/unit.millis) {
			break
		}
		millis := int64(count) * unit.millis
		result := time.Unix(at.Unix()-millis/1000, int64(at.Nanosecond())-millis%1000*1e6).UTC()
		if result.Year() < -262143 {
			break
		}
		return result, nil
	}
	return time.Time{}, errors.New("INVALID_ARGUMENT: since requires RFC3339 or an integer duration with ms, s, m, h, or d (for example 2m)")
}

func queryLogs(options object) (object, error) {
	logLock.Lock()
	defer logLock.Unlock()
	dir := filepath.Join(root(), "logs")
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var rows []object
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if filepath.Ext(path) != ".jsonl" {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		for index, line := range bytes.Split(data, []byte{'\n'}) {
			var row object
			if canonjson.Unmarshal(line, &row) != nil || row == nil || skipLogRow(row) {
				continue
			}
			row["recordId"] = hash([]byte(fmt.Sprintf("%s:%d", path, index)))
			rows = append(rows, row)
		}
	}
	slices.SortFunc(rows, func(a, b object) int {
		if byTime := strings.Compare(text(a, "time"), text(b, "time")); byTime != 0 {
			return byTime
		}
		return strings.Compare(text(a, "recordId"), text(b, "recordId"))
	})
	var oldest, newest any
	if len(rows) != 0 {
		oldest, newest = rows[0]["time"], rows[len(rows)-1]["time"]
	}
	descending := options["descending"] == true
	if descending {
		slices.Reverse(rows)
	}
	var since time.Time
	if value, ok := options["since"].(string); ok {
		since, err = parseLogSince(value, time.Now().UTC())
		if err != nil {
			return nil, err
		}
	}
	cursor := text(options, "cursor")
	cursorFor := func(row object) string { return hash([]byte(wire(row))) }
	position := -1
	if cursor != "" {
		position = slices.IndexFunc(rows, func(row object) bool { return cursorFor(row) == cursor })
	}
	selected := []object{}
	for _, row := range rows[position+1:] {
		matches := true
		for _, key := range []string{"ingressId", "level", "traceId", "requestId", "cfRay", "event"} {
			if filter := text(options, key); filter != "" && row[key] != filter {
				matches = false
				break
			}
		}
		if !matches || !strings.Contains(text(row, "msg"), text(options, "grep")) {
			continue
		}
		at := text(row, "time")
		if parsed, err := time.Parse(time.RFC3339Nano, at); !since.IsZero() && err == nil && parsed.Before(since) {
			continue
		}
		if until, ok := options["until"].(string); ok && at > until {
			continue
		}
		selected = append(selected, row)
	}
	limit := int(min(max(uintOr(options["limit"], 200), 1), 2000))
	_, hasSince := options["since"]
	_, hasUntil := options["until"]
	if !descending && cursor == "" && !hasSince && !hasUntil && len(selected) > limit {
		selected = selected[len(selected)-limit:]
	}
	more := len(selected) > limit
	next := cursor
	if more {
		selected = selected[:limit]
		next = cursorFor(selected[len(selected)-1])
	} else if len(rows) > 0 {
		next = cursorFor(rows[len(rows)-1])
	}
	return object{"rows": selected, "cursor": next, "hasMore": more, "gap": cursor != "" && position == -1, "retention": object{"days": 7, "maxBytes": logMaxBytes}, "oldestAt": oldest, "newestAt": newest}, nil
}

func init() {

	handler := func(_ context.Context, _ *service, body object, _ []string) (any, error) { return queryLogs(body) }
	registerRoute("GET", "logs", handler)
	registerRoute("POST", "logs/query", handler)
}
