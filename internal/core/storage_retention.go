package core

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const (
	storageReceiptHotDays        = 14
	storageReceiptHotLimit       = 2000
	storageCoordinationHotDays   = 14
	storageCoordinationHighWater = 6144 // 75% of 8192 observer storage limit
	storageCoordinationCapacity  = 8192
	storageDispatchHotDays       = 30
	storageNotificationHotDays   = 30
	storageMetricsRawDays        = 14
	storageOutputsMaxAgeDays     = 7
	storageAutoBatchLimit        = 500
	storageManualBatchLimit      = 20000
	storageInitialDelay          = 2 * time.Minute
	storageMaintenanceInterval   = 24 * time.Hour
	storageDefaultPruneOlderDays = 90
)

var storageLegacyDirs = []string{"usage", "verification", "acceptance"}

var storageMaintenanceMu sync.Mutex

type storageFileItem struct {
	path  string
	rel   string
	mtime time.Time
	size  int64
}

func storageRetentionDays() int {
	raw := str(readPreferences()["archive-retention-days"])
	days, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || days < 0 {
		return 0
	}
	return days
}

func storageNow() time.Time { return time.Now().UTC() }

func isRootReceiptFile(name string) bool {
	if !strings.HasSuffix(name, ".json") {
		return false
	}
	_, err := uuid.Parse(strings.TrimSuffix(name, ".json"))
	return err == nil
}

func receiptTerminalForArchive(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var row object
	if unmarshalJSON(data, &row) != nil {
		return false
	}
	state := receiptState(text(row, "state"))
	return state == receiptCompleted || state == receiptFailed || state == receiptCancelled
}

func notificationTerminalForArchive(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var row object
	if unmarshalJSON(data, &row) != nil {
		return false
	}
	for _, item := range arr(row["deliveries"]) {
		status := text(item, "status")
		if status == "pending" || status == "sending" {
			return false
		}
	}
	return true
}

func collectReceiptArchiveCandidates(base string, nowAt time.Time) (totalCount int, totalBytes int64, candidates []storageFileItem) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return 0, 0, nil
	}
	cutoff := nowAt.AddDate(0, 0, -storageReceiptHotDays)
	var all []storageFileItem
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !isRootReceiptFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		totalCount++
		totalBytes += info.Size()
		all = append(all, storageFileItem{
			path:  filepath.Join(base, entry.Name()),
			rel:   entry.Name(),
			mtime: info.ModTime().UTC(),
			size:  info.Size(),
		})
	}
	slices.SortFunc(all, func(a, b storageFileItem) int { return a.mtime.Compare(b.mtime) })
	overflow := max(0, len(all)-storageReceiptHotLimit)
	for index, item := range all {
		if item.mtime.Before(cutoff) || index < overflow {
			if receiptTerminalForArchive(item.path) {
				candidates = append(candidates, item)
			}
		}
	}
	return totalCount, totalBytes, candidates
}

func collectCoordinationArchiveCandidates(base string, nowAt time.Time) (totalCount int, totalBytes int64, candidates []storageFileItem) {
	coordBase := filepath.Join(base, "coordination")
	cutoff := nowAt.AddDate(0, 0, -storageCoordinationHotDays)
	var all []storageFileItem
	for _, sub := range []string{"observations", "checkpoints", "tooling", "ref-watch"} {
		dir := filepath.Join(coordBase, sub)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			totalCount++
			totalBytes += info.Size()
			all = append(all, storageFileItem{
				path:  filepath.Join(dir, entry.Name()),
				rel:   filepath.ToSlash(filepath.Join("coordination", sub, entry.Name())),
				mtime: info.ModTime().UTC(),
				size:  info.Size(),
			})
		}
	}
	slices.SortFunc(all, func(a, b storageFileItem) int { return a.mtime.Compare(b.mtime) })
	overflow := max(0, len(all)-storageCoordinationHighWater)
	for index, item := range all {
		if item.mtime.Before(cutoff) || index < overflow {
			candidates = append(candidates, item)
		}
	}
	return totalCount, totalBytes, candidates
}

func collectNestedJSONCandidates(base, subdir string, cutoff time.Time) (totalCount int, totalBytes int64, candidates []storageFileItem) {
	dir := filepath.Join(base, subdir)
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() || filepath.Ext(d.Name()) != ".json" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return nil
		}
		totalCount++
		totalBytes += info.Size()
		if info.ModTime().UTC().Before(cutoff) {
			candidates = append(candidates, storageFileItem{
				path:  path,
				rel:   filepath.ToSlash(rel),
				mtime: info.ModTime().UTC(),
				size:  info.Size(),
			})
		}
		return nil
	})
	slices.SortFunc(candidates, func(a, b storageFileItem) int { return a.mtime.Compare(b.mtime) })
	return totalCount, totalBytes, candidates
}

func collectNotificationArchiveCandidates(base string, nowAt time.Time) (totalCount int, totalBytes int64, candidates []storageFileItem) {
	dir := filepath.Join(base, "notifications", "tasks")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0, nil
	}
	cutoff := nowAt.AddDate(0, 0, -storageNotificationHotDays)
	for _, entry := range entries {
		if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		totalCount++
		totalBytes += info.Size()
		if info.ModTime().UTC().Before(cutoff) {
			path := filepath.Join(dir, entry.Name())
			if notificationTerminalForArchive(path) {
				candidates = append(candidates, storageFileItem{
					path:  path,
					rel:   filepath.ToSlash(filepath.Join("notifications", "tasks", entry.Name())),
					mtime: info.ModTime().UTC(),
					size:  info.Size(),
				})
			}
		}
	}
	slices.SortFunc(candidates, func(a, b storageFileItem) int { return a.mtime.Compare(b.mtime) })
	return totalCount, totalBytes, candidates
}

func collectOldFilesInDir(dir string, cutoff time.Time, match func(string) bool) (totalCount int, totalBytes int64, candidates []storageFileItem) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0, nil
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || (match != nil && !match(entry.Name())) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		totalCount++
		totalBytes += info.Size()
		if info.ModTime().UTC().Before(cutoff) {
			candidates = append(candidates, storageFileItem{
				path:  filepath.Join(dir, entry.Name()),
				rel:   entry.Name(),
				mtime: info.ModTime().UTC(),
				size:  info.Size(),
			})
		}
	}
	slices.SortFunc(candidates, func(a, b storageFileItem) int { return a.mtime.Compare(b.mtime) })
	return totalCount, totalBytes, candidates
}

func dirStats(dir string) (count int, bytes int64) {
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			count++
			bytes += info.Size()
		}
		return nil
	})
	return count, bytes
}

func appendGzipArchiveBatch(archivePath string, items []storageFileItem, nowAt time.Time) (int, int64, error) {
	if len(items) == 0 {
		return 0, 0, nil
	}
	if err := platform.PrivateDir(filepath.Dir(archivePath)); err != nil {
		return 0, 0, err
	}
	tmpPath := archivePath + "." + id() + ".tmp"
	outFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return 0, 0, err
	}
	cleanupTmp := func() {
		_ = outFile.Close()
		_ = os.Remove(tmpPath)
	}
	gzOut := gzip.NewWriter(outFile)
	// Preserve existing monthly archive records before appending new ones.
	if existing, err := os.Open(archivePath); err == nil {
		gzIn, gzErr := gzip.NewReader(existing)
		if gzErr != nil {
			_ = existing.Close()
			cleanupTmp()
			return 0, 0, gzErr
		}
		if _, copyErr := io.Copy(gzOut, gzIn); copyErr != nil {
			_ = gzIn.Close()
			_ = existing.Close()
			cleanupTmp()
			return 0, 0, copyErr
		}
		_ = gzIn.Close()
		_ = existing.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		cleanupTmp()
		return 0, 0, err
	}
	buf := bufio.NewWriter(gzOut)
	archivedAt := nowAt.Format(time.RFC3339)
	writtenCount := 0
	var writtenBytes int64
	for _, item := range items {
		raw, err := os.ReadFile(item.path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			cleanupTmp()
			return 0, 0, err
		}
		var dataField any
		if json.Valid(raw) {
			dataField = json.RawMessage(raw)
		} else {
			dataField = string(raw)
		}
		record := map[string]any{
			"path":       item.rel,
			"archivedAt": archivedAt,
			"mtime":      item.mtime.Format(time.RFC3339),
			"data":       dataField,
		}
		line, err := json.Marshal(record)
		if err != nil {
			cleanupTmp()
			return 0, 0, err
		}
		if _, err := buf.Write(line); err != nil {
			cleanupTmp()
			return 0, 0, err
		}
		if err := buf.WriteByte('\n'); err != nil {
			cleanupTmp()
			return 0, 0, err
		}
		writtenCount++
		writtenBytes += int64(len(raw))
	}
	if err := buf.Flush(); err != nil {
		cleanupTmp()
		return 0, 0, err
	}
	if err := gzOut.Close(); err != nil {
		cleanupTmp()
		return 0, 0, err
	}
	if err := outFile.Sync(); err != nil {
		cleanupTmp()
		return 0, 0, err
	}
	if err := outFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return 0, 0, err
	}
	if err := os.Rename(tmpPath, archivePath); err != nil {
		_ = os.Remove(tmpPath)
		return 0, 0, err
	}
	return writtenCount, writtenBytes, nil
}

func compressFileGzip(path string) (int64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	target := path + ".gz"
	tmp := target + "." + id() + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return 0, err
	}
	gz := gzip.NewWriter(file)
	if _, err := gz.Write(raw); err != nil {
		_ = gz.Close()
		_ = file.Close()
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := gz.Close(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	return int64(len(raw)), nil
}

func removeEmptySubdirs(rootDir string) {
	var dirs []string
	_ = filepath.WalkDir(rootDir, func(path string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() && path != rootDir {
			dirs = append(dirs, path)
		}
		return nil
	})
	for i := len(dirs) - 1; i >= 0; i-- {
		entries, err := os.ReadDir(dirs[i])
		if err == nil && len(entries) == 0 {
			_ = os.Remove(dirs[i])
		}
	}
}

func resetCoordinationStorageInventory() {
	coordinationStorage.Lock()
	coordinationStorage.root = ""
	coordinationStorage.files = nil
	coordinationStorage.bytes = 0
	coordinationStorage.full = false
	coordinationStorage.Unlock()
}

func archiveCategoryItems(base, category string, items []storageFileItem, limit int, nowAt time.Time, apply bool) (object, error) {
	if len(items) > limit {
		items = items[:limit]
	}
	var bytesTotal int64
	for _, item := range items {
		bytesTotal += item.size
	}
	if !apply || len(items) == 0 {
		return object{"eligible": len(items), "bytes": bytesTotal, "archived": 0}, nil
	}
	byMonth := map[string][]storageFileItem{}
	for _, item := range items {
		month := item.mtime.Format("2006-01")
		byMonth[month] = append(byMonth[month], item)
	}
	archivedCount := 0
	var archivedBytes int64
	for _, month := range slices.Sorted(maps.Keys(byMonth)) {
		group := byMonth[month]
		archivePath := filepath.Join(base, "archives", category, month+".jsonl.gz")
		n, b, err := appendGzipArchiveBatch(archivePath, group, nowAt)
		if err != nil {
			return nil, err
		}
		for _, item := range group {
			before, _ := readStamp(filepath.Dir(item.path))
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			markCachedFileChanged(item.path, before)
		}
		archivedCount += n
		archivedBytes += b
	}
	if category == "coordination" && archivedCount > 0 {
		resetCoordinationStorageInventory()
	}
	if (category == "dispatches" || category == "changes") && archivedCount > 0 {
		removeEmptySubdirs(filepath.Join(base, category))
	}
	return object{"eligible": len(items), "bytes": archivedBytes, "archived": archivedCount}, nil
}

func storageStatus(ctx context.Context) (object, error) {
	return storageStatusIn(ctx, root())
}

func storageStatusIn(_ context.Context, base string) (object, error) {
	nowAt := storageNow()
	rcCount, rcBytes, rcCand := collectReceiptArchiveCandidates(base, nowAt)
	coCount, coBytes, coCand := collectCoordinationArchiveCandidates(base, nowAt)
	dCount, dBytes, dCand := collectNestedJSONCandidates(base, "dispatches", nowAt.AddDate(0, 0, -storageDispatchHotDays))
	chCount, chBytes, chCand := collectNestedJSONCandidates(base, "changes", nowAt.AddDate(0, 0, -storageDispatchHotDays))
	nCount, nBytes, nCand := collectNotificationArchiveCandidates(base, nowAt)
	mCount, mBytes, mCand := collectOldFilesInDir(filepath.Join(base, "control-metrics"), nowAt.AddDate(0, 0, -storageMetricsRawDays), func(name string) bool {
		return strings.HasSuffix(name, ".jsonl")
	})
	oCount, oBytes, oCand := collectOldFilesInDir(filepath.Join(base, "outputs"), nowAt.AddDate(0, 0, -storageOutputsMaxAgeDays), nil)
	var oPrunableBytes int64
	for _, item := range oCand {
		oPrunableBytes += item.size
	}
	archCount, archBytes := dirStats(filepath.Join(base, "archives"))

	legacy := object{}
	legacyFiles := 0
	var legacyBytes int64
	for _, name := range storageLegacyDirs {
		c, b := dirStats(filepath.Join(base, name))
		if c > 0 {
			legacy[name] = object{"files": c, "bytes": b}
			legacyFiles += c
			legacyBytes += b
		}
	}
	warnings := []string{}
	if coCount >= storageCoordinationHighWater {
		warnings = append(warnings, "coordination-high-water")
	}
	return object{
		"stateDirectory": base,
		"policy": object{
			"receiptHotDays":        storageReceiptHotDays,
			"receiptHotLimit":       storageReceiptHotLimit,
			"coordinationHotDays":   storageCoordinationHotDays,
			"coordinationHighWater": storageCoordinationHighWater,
			"coordinationCapacity":  storageCoordinationCapacity,
			"dispatchHotDays":       storageDispatchHotDays,
			"notificationHotDays":   storageNotificationHotDays,
			"metricsRawDays":        storageMetricsRawDays,
			"outputsMaxAgeDays":     storageOutputsMaxAgeDays,
			"archiveRetentionDays":  storageRetentionDays(),
		},
		"hot": object{
			"receipts":       object{"files": rcCount, "bytes": rcBytes, "archivable": len(rcCand)},
			"coordination":   object{"files": coCount, "bytes": coBytes, "archivable": len(coCand), "capacity": storageCoordinationCapacity},
			"dispatches":     object{"files": dCount, "bytes": dBytes, "archivable": len(dCand)},
			"changes":        object{"files": chCount, "bytes": chBytes, "archivable": len(chCand)},
			"notifications":  object{"files": nCount, "bytes": nBytes, "archivable": len(nCand)},
			"controlMetrics": object{"files": mCount, "bytes": mBytes, "compressible": len(mCand)},
			"outputs":        object{"files": oCount, "bytes": oBytes, "prunable": len(oCand), "prunableBytes": oPrunableBytes},
		},
		"archives": object{"files": archCount, "bytes": archBytes},
		"legacy":   object{"files": legacyFiles, "bytes": legacyBytes, "directories": legacy},
		"warnings": warnings,
	}, nil
}

func runStorageArchive(ctx context.Context, apply bool, batchLimit int) (object, error) {
	return runStorageArchiveIn(ctx, root(), apply, batchLimit)
}

func runStorageArchiveIn(_ context.Context, base string, apply bool, batchLimit int) (object, error) {
	storageMaintenanceMu.Lock()
	defer storageMaintenanceMu.Unlock()
	nowAt := storageNow()

	_, _, rcCand := collectReceiptArchiveCandidates(base, nowAt)
	_, _, coCand := collectCoordinationArchiveCandidates(base, nowAt)
	_, _, dCand := collectNestedJSONCandidates(base, "dispatches", nowAt.AddDate(0, 0, -storageDispatchHotDays))
	_, _, chCand := collectNestedJSONCandidates(base, "changes", nowAt.AddDate(0, 0, -storageDispatchHotDays))
	_, _, nCand := collectNotificationArchiveCandidates(base, nowAt)
	_, _, mCand := collectOldFilesInDir(filepath.Join(base, "control-metrics"), nowAt.AddDate(0, 0, -storageMetricsRawDays), func(name string) bool {
		return strings.HasSuffix(name, ".jsonl")
	})

	results := object{}
	eligibleArchive := 0
	archivedTotal := 0
	for _, spec := range []struct {
		name  string
		items []storageFileItem
	}{
		{"receipts", rcCand},
		{"coordination", coCand},
		{"dispatches", dCand},
		{"changes", chCand},
		{"notifications", nCand},
	} {
		row, err := archiveCategoryItems(base, spec.name, spec.items, batchLimit, nowAt, apply)
		if err != nil {
			return nil, err
		}
		results[spec.name] = row
		eligibleArchive += int(uintOr(row["eligible"], 0))
		archivedTotal += int(uintOr(row["archived"], 0))
	}

	if len(mCand) > batchLimit {
		mCand = mCand[:batchLimit]
	}
	metricsCompressed := 0
	var metricsBytes int64
	for _, item := range mCand {
		if apply {
			n, err := compressFileGzip(item.path)
			if err != nil {
				return nil, err
			}
			metricsCompressed++
			metricsBytes += n
		} else {
			metricsBytes += item.size
		}
	}
	results["controlMetrics"] = object{"eligible": len(mCand), "compressed": metricsCompressed, "bytes": metricsBytes}

	return object{
		"applied":    apply,
		"dryRun":     !apply,
		"categories": results,
		"summary": object{
			"eligibleArchive":  eligibleArchive,
			"archived":         archivedTotal,
			"eligibleCompress": len(mCand),
			"compressed":       metricsCompressed,
		},
	}, nil
}

func pruneExpiredOutputsUnlocked(base string, nowAt time.Time, apply bool, limit int) (object, error) {
	_, _, oCand := collectOldFilesInDir(filepath.Join(base, "outputs"), nowAt.AddDate(0, 0, -storageOutputsMaxAgeDays), nil)
	if limit > 0 && len(oCand) > limit {
		oCand = oCand[:limit]
	}
	outputsRemoved := 0
	var outputsBytes int64
	for _, item := range oCand {
		outputsBytes += item.size
		if apply {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			outputsRemoved++
		}
	}
	return object{"eligible": len(oCand), "removed": outputsRemoved, "bytes": outputsBytes}, nil
}

func runStoragePrune(ctx context.Context, apply bool, olderThanDays int, includeLegacy, includeOutputs bool) (object, error) {
	return runStoragePruneIn(ctx, root(), apply, olderThanDays, includeLegacy, includeOutputs)
}

func runStoragePruneIn(_ context.Context, base string, apply bool, olderThanDays int, includeLegacy, includeOutputs bool) (object, error) {
	storageMaintenanceMu.Lock()
	defer storageMaintenanceMu.Unlock()
	nowAt := storageNow()
	if olderThanDays <= 0 {
		olderThanDays = storageDefaultPruneOlderDays
	}
	cutoff := nowAt.AddDate(0, 0, -olderThanDays)
	archiveRoot := filepath.Join(base, "archives")

	var expired []storageFileItem
	_ = filepath.WalkDir(archiveRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() || !strings.HasSuffix(d.Name(), ".jsonl.gz") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.ModTime().UTC().Before(cutoff) {
			rel, _ := filepath.Rel(base, path)
			expired = append(expired, storageFileItem{path: path, rel: filepath.ToSlash(rel), mtime: info.ModTime().UTC(), size: info.Size()})
		}
		return nil
	})

	archivesRemoved := 0
	var archivesBytes int64
	for _, item := range expired {
		archivesBytes += item.size
		if apply {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			archivesRemoved++
		}
	}
	if apply && archivesRemoved > 0 {
		removeEmptySubdirs(archiveRoot)
	}

	outputsResult := object{"eligible": 0, "removed": 0, "bytes": int64(0)}
	if includeOutputs {
		var err error
		outputsResult, err = pruneExpiredOutputsUnlocked(base, nowAt, apply, storageManualBatchLimit)
		if err != nil {
			return nil, err
		}
	}

	legacyRemoved := 0
	var legacyBytes int64
	legacyTargets := []string{}
	if includeLegacy {
		for _, name := range storageLegacyDirs {
			dir := filepath.Join(base, name)
			c, b := dirStats(dir)
			if c == 0 {
				continue
			}
			legacyTargets = append(legacyTargets, name)
			legacyBytes += b
			if apply {
				if err := os.RemoveAll(dir); err != nil {
					return nil, err
				}
				legacyRemoved += c
			}
		}
	}

	return object{
		"applied":        apply,
		"dryRun":         !apply,
		"olderThanDays":  olderThanDays,
		"includeLegacy":  includeLegacy,
		"includeOutputs": includeOutputs,
		"archives":       object{"eligible": len(expired), "removed": archivesRemoved, "bytes": archivesBytes},
		"outputs":        outputsResult,
		"legacy":         object{"directories": legacyTargets, "removed": legacyRemoved, "bytes": legacyBytes},
	}, nil
}

func runStorageMaintenancePassIn(ctx context.Context, base string, retentionDays, batchLimit int) (object, error) {
	archiveResult, err := runStorageArchiveIn(ctx, base, true, batchLimit)
	if err != nil {
		return nil, err
	}
	summary := obj(archiveResult["summary"])
	archived := int(uintOr(field(summary, "archived"), 0))
	compressed := int(uintOr(field(summary, "compressed"), 0))

	storageMaintenanceMu.Lock()
	outputsResult, outErr := pruneExpiredOutputsUnlocked(base, storageNow(), true, batchLimit)
	storageMaintenanceMu.Unlock()
	if outErr != nil {
		return nil, outErr
	}
	deletedOutputs := int(uintOr(outputsResult["removed"], 0))

	deletedArchives := 0
	if retentionDays > 0 && ctx.Err() == nil {
		pruneResult, pruneErr := runStoragePruneIn(ctx, base, true, retentionDays, false, false)
		if pruneErr != nil {
			return nil, pruneErr
		}
		deletedArchives = int(uintOr(field(pruneResult["archives"], "removed"), 0))
	}

	return object{
		"archived":        archived,
		"compressed":      compressed,
		"deletedOutputs":  deletedOutputs,
		"deletedArchives": deletedArchives,
	}, nil
}

func startStorageMaintenance(ctx context.Context, _ *service) error {
	go func() {
		timer := time.NewTimer(storageInitialDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			counts, err := runStorageMaintenancePassIn(ctx, root(), storageRetentionDays(), storageAutoBatchLimit)
			if err != nil && ctx.Err() == nil {
				recordLog("WARN", "Storage maintenance: "+err.Error(), nil)
			} else if err == nil {
				archived := int(uintOr(counts["archived"], 0))
				compressed := int(uintOr(counts["compressed"], 0))
				deletedOutputs := int(uintOr(counts["deletedOutputs"], 0))
				deletedArchives := int(uintOr(counts["deletedArchives"], 0))
				if archived > 0 || compressed > 0 || deletedOutputs > 0 || deletedArchives > 0 {
					recordLog("INFO", "Storage maintenance completed", object{
						"archived":        archived,
						"compressed":      compressed,
						"deletedOutputs":  deletedOutputs,
						"deletedArchives": deletedArchives,
					})
				}
			}
			timer.Reset(storageMaintenanceInterval)
		}
	}()
	return nil
}

func init() {
	registerRoute(http.MethodGet, "storage/status", func(ctx context.Context, _ *service, _ object, _ []string) (any, error) {
		return storageStatus(ctx)
	})
	registerRoute(http.MethodPost, "storage/archive", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		apply := body["apply"] == true
		return runStorageArchive(ctx, apply, storageManualBatchLimit)
	})
	registerRoute(http.MethodPost, "storage/prune", func(ctx context.Context, _ *service, body object, _ []string) (any, error) {
		apply := body["apply"] == true
		days := int(uintOr(body["olderThanDays"], storageDefaultPruneOlderDays))
		includeLegacy := body["includeLegacy"] == true
		includeOutputs := body["includeOutputs"] == true
		return runStoragePrune(ctx, apply, days, includeLegacy, includeOutputs)
	})
	registerAfterIndexStartup(50, startStorageMaintenance)
}
