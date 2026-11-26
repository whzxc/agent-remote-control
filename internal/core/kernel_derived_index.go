package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const derivedVersion = 2
const indexPending = "INDEX_NOT_READY: Background index initialization is pending; retry this owner read."

type indexEntry struct {
	Stamp *fileStamp `json:"stamp"`
	Row   any        `json:"row"`
}
type indexManifest struct {
	Version    int    `json:"version"`
	Generation string `json:"generation"`
	Count      int    `json:"count"`
}
type indexOwnerLock struct {
	sync.Mutex
	users int
}

var indexOwners struct {
	sync.Mutex
	writers   map[string]*indexOwnerLock
	preparing map[string]bool
}

type indexInitializer struct{}

var indexFixtureGate func(context.Context) error

type startupIndex struct {
	owner func() string
	order int
	open  func(context.Context, *service) error
	close func(string)
}

var startupIndexes []startupIndex

// registerStartupIndex supplies a durable owner to the Core's startup worker.
// Owners are gated before the listener and are published independently.
func registerStartupIndex(owner func() string, order int, open func(context.Context, *service) error, close func(string)) {
	startupIndexes = append(startupIndexes, startupIndex{owner, order, open, close})
}

type indexPreparation struct {
	order int
	run   func(context.Context, *service) error
}

var startupIndexPreparations []indexPreparation

// registerIndexPreparation runs owner migrations before any derived index is opened.
func registerIndexPreparation(order int, run func(context.Context, *service) error) {
	startupIndexPreparations = append(startupIndexPreparations, indexPreparation{order, run})
}

func prepareRuntimeIndexes(s *service) func(context.Context) {
	registered := slices.Clone(startupIndexes)
	slices.SortStableFunc(registered, func(a, b startupIndex) int { return a.order - b.order })
	owners := make([]string, len(registered))
	for i, index := range registered {
		owners[i] = physicalPath(index.owner())
	}
	prepareIndexes(owners)
	var cancel context.CancelFunc
	var stopped chan struct{}
	s.cleanup = append(s.cleanup, func() {
		if cancel != nil {
			cancel()
			<-stopped
		}
		for i, index := range registered {
			if index.close != nil {
				index.close(owners[i])
			}
		}
		indexOwners.Lock()
		for _, owner := range owners {
			delete(indexOwners.preparing, owner)
		}
		indexOwners.Unlock()
	})
	return func(parent context.Context) {
		var work context.Context
		work, cancel = context.WithCancel(parent)
		work = context.WithValue(work, indexInitializer{}, true)
		stopped = make(chan struct{})
		go func() {
			defer close(stopped)
			if err := initializeRuntimeIndexes(work, s, registered, owners); err != nil && work.Err() == nil {
				recordLog("ERROR", "Index startup failed: "+err.Error(), nil)
			}
		}()
	}
}

func initializeRuntimeIndexes(ctx context.Context, s *service, registered []startupIndex, owners []string) error {
	defer func() {
		for _, owner := range owners {
			if err := reclaimObsoleteIndexes(owner); err != nil {
				recordLog("WARN", "Cannot reclaim obsolete index generation: "+err.Error(), nil)
			}
		}
	}()
	if indexFixtureGate != nil {
		if err := indexFixtureGate(ctx); err != nil {
			return err
		}
	}
	if err := pruneOutputs(); err != nil {
		recordLog("WARN", "Cannot prune temporary outputs: "+err.Error(), nil)
	}
	preparations := slices.Clone(startupIndexPreparations)
	slices.SortStableFunc(preparations, func(a, b indexPreparation) int { return a.order - b.order })
	for _, preparation := range preparations {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := preparation.run(ctx, s); err != nil {
			return err
		}
	}
	for _, index := range registered {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := index.open(ctx, s); err != nil {
			return err
		}
	}
	return nil
}

func reclaimObsoleteIndexes(owner string) error {
	defer lockIndex(owner)()
	manifest, err := indexCurrent(owner)
	if err != nil {
		// Keep the last durable generation until a replacement can be published.
		return nil
	}
	return cleanIndexes(owner, manifest.Generation)
}

func lockIndex(owner string) func() {
	owner = physicalPath(owner)
	indexOwners.Lock()
	if indexOwners.writers == nil {
		indexOwners.writers = map[string]*indexOwnerLock{}
	}
	writer := indexOwners.writers[owner]
	if writer == nil {
		writer = &indexOwnerLock{}
		indexOwners.writers[owner] = writer
	}
	writer.users++
	indexOwners.Unlock()
	writer.Lock()
	return func() {
		writer.Unlock()
		indexOwners.Lock()
		writer.users--
		if writer.users == 0 {
			delete(indexOwners.writers, owner)
		}
		indexOwners.Unlock()
	}
}
func prepareIndexes(owners []string) {
	indexOwners.Lock()
	defer indexOwners.Unlock()
	if indexOwners.preparing == nil {
		indexOwners.preparing = map[string]bool{}
	}
	for _, owner := range owners {
		indexOwners.preparing[physicalPath(owner)] = true
	}
}
func indexAvailable(ctx context.Context, owner string) error {
	if ctx.Value(indexInitializer{}) != nil {
		return nil
	}
	key := physicalPath(owner)
	indexOwners.Lock()
	pending := indexOwners.preparing[key]
	indexOwners.Unlock()
	if pending {
		return errors.New(indexPending)
	}
	return nil
}

func indexDirectory(owner string) string { return filepath.Join(owner, ".activity-index") }
func indexSyncDirectory(path string) error {
	if operatingSystem == "windows" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
func indexAtomic(path string, bytes []byte) error {
	parent := filepath.Dir(path)
	if err := platform.PrivateDir(parent); err != nil {
		return fmt.Errorf("File operation failed at prepare-index-directory for %s: %w", parent, err)
	}
	temp := strings.TrimSuffix(path, filepath.Ext(path)) + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("File operation failed at open-index-temporary for %s: %w", temp, err)
	}
	_, err = file.Write(bytes)
	if err == nil {
		err = file.Sync()
	}
	if err := errors.Join(err, file.Close()); err != nil {
		return fmt.Errorf("File operation failed at sync-index-temporary for %s: %w", temp, err)
	}
	if err := platform.ReplaceFile(temp, path); err != nil {
		return fmt.Errorf("File operation failed at replace-index for %s: from %s: %w", path, temp, err)
	}
	return indexSyncDirectory(parent)
}
func indexWrite(path string, value any) error {
	return indexAtomic(path, []byte(wire(value)))
}
func indexRead(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("File operation failed at read-index for %s: %w", path, err)
	}
	recordFileCost(fileCost{Path: path, Rows: 1, BytesRead: len(data), BytesParsed: len(data)})
	return unmarshalJSON(data, value)
}
func indexCurrent(owner string) (indexManifest, error) {
	result := indexManifest{}
	dir := indexDirectory(owner)
	if _, err := os.Stat(filepath.Join(dir, "invalid")); err == nil {
		return result, errors.New("DERIVED_INDEX_INVALIDATED: rebuild required")
	}
	if err := indexRead(filepath.Join(dir, "current.json"), &result); err != nil {
		return result, err
	}
	if _, err := uuid.Parse(result.Generation); result.Version != derivedVersion || err != nil {
		return result, errors.New("DERIVED_INDEX_VERSION: rebuild required")
	}
	return result, nil
}
func indexShard(name string) string {
	s := []rune(name)
	return string(s[:min(2, len(s))]) + ".json"
}
func indexReadShard(generation, name string) (map[string]indexEntry, error) {
	result := map[string]indexEntry{}
	err := indexRead(filepath.Join(generation, indexShard(name)), &result)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return result, err
}
func indexReplace(generation, name string, row *indexEntry) (bool, error) {
	rows, err := indexReadShard(generation, name)
	if err != nil {
		return false, err
	}
	_, existed := rows[name]
	if row == nil {
		delete(rows, name)
	} else {
		rows[name] = *row
	}
	path := filepath.Join(generation, indexShard(name))
	if len(rows) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return existed, err
		}
		return existed, indexSyncDirectory(generation)
	}
	return existed, indexWrite(path, rows)
}
func indexDirty(path string) string {
	return filepath.Join(indexDirectory(filepath.Dir(path)), "dirty", filepath.Base(path))
}
func indexMark(path string) error {
	owner := filepath.Dir(path)
	if err := indexAtomic(indexDirty(path), []byte("dirty")); err != nil {
		return err
	}
	if err := indexSyncDirectory(indexDirectory(owner)); err != nil {
		return err
	}
	return indexSyncDirectory(owner)
}
func indexCommit(path string, row any) error {
	owner := filepath.Dir(path)
	current, err := indexCurrent(owner)
	if err != nil {
		return nil
	}
	generation := filepath.Join(indexDirectory(owner), current.Generation)
	var entry *indexEntry
	if row != nil {
		stamp, err := readStamp(path)
		if err != nil {
			return err
		}
		entry = &indexEntry{stamp, row}
	}
	existed, err := indexReplace(generation, filepath.Base(path), entry)
	if err != nil {
		return err
	}
	if existed != (row != nil) {
		if existed {
			current.Count = max(current.Count-1, 0)
		} else {
			current.Count++
		}
		if err := indexWrite(filepath.Join(indexDirectory(owner), "current.json"), current); err != nil {
			return err
		}
	}
	dirty := indexDirty(path)
	if err := os.Remove(dirty); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return indexSyncDirectory(filepath.Dir(dirty))
}
func indexInvalidate(ctx context.Context, owner string) error {
	if err := indexAvailable(ctx, owner); err != nil {
		return err
	}
	defer lockIndex(owner)()
	if err := indexAtomic(filepath.Join(indexDirectory(owner), "invalid"), []byte("migration")); err != nil {
		return err
	}
	return indexSyncDirectory(owner)
}
func indexChange(ctx context.Context, path string, write func() (any, error)) error {
	owner := filepath.Dir(path)
	if err := indexAvailable(ctx, owner); err != nil {
		return err
	}
	defer lockIndex(owner)()
	_, invalid := os.Stat(filepath.Join(indexDirectory(owner), "invalid"))
	migrating := ctx.Value(indexInitializer{}) != nil && invalid == nil
	if !migrating {
		if err := indexMark(path); err != nil {
			return err
		}
	}
	row, err := write()
	if err != nil {
		return err
	}
	mode := os.O_RDONLY
	if operatingSystem == "windows" {
		mode = os.O_RDWR
	}
	if file, err := os.OpenFile(path, mode, 0); err == nil {
		if err := errors.Join(file.Sync(), file.Close()); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := indexSyncDirectory(owner); err != nil {
		return err
	}
	if migrating {
		return nil
	}
	return indexCommit(path, row)
}
func indexUpdate(ctx context.Context, path string, row any) error {
	owner := filepath.Dir(path)
	if err := indexAvailable(ctx, owner); err != nil {
		return err
	}
	defer lockIndex(owner)()
	if _, err := os.Stat(indexDirty(path)); err == nil {
		return nil
	}
	if current, err := indexCurrent(owner); err == nil {
		name := filepath.Base(path)
		if previous, err := indexReadShard(filepath.Join(indexDirectory(owner), current.Generation), name); err == nil {
			before := previous[name]
			stamp, err := readStamp(path)
			if err != nil {
				return err
			}
			if stampSame(before.Stamp, stamp) && wire(before.Row) == wire(row) {
				return nil
			}
		}
	}
	if err := indexMark(path); err != nil {
		return err
	}
	return indexCommit(path, row)
}

type indexProfile struct{ read, project, write time.Duration }

func indexCanonical(path string, project func(any) (any, error), profile *indexProfile) (*indexEntry, error) {
	before, err := readStamp(path)
	if err != nil || before == nil {
		return nil, err
	}
	at := time.Now()
	data, err := os.ReadFile(path)
	profile.read += time.Since(at)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	at = time.Now()
	var value any
	recordFileCost(fileCost{Path: path, Rows: 1, BytesRead: len(data), BytesParsed: len(data)})
	err = unmarshalJSON(data, &value)
	if err == nil {
		value, err = project(value)
	}
	profile.project += time.Since(at)
	if err != nil {
		recordLog("WARN", "Skipping invalid index source: "+err.Error(), nil)
		return nil, nil
	}
	stamp, err := readStamp(path)
	if err != nil || stamp == nil {
		return nil, err
	}
	if !stampSame(before, stamp) {
		return nil, errors.New("DERIVED_INDEX_SOURCE_CHANGED: retry index read")
	}
	return &indexEntry{stamp, value}, nil
}
func indexReadRows(generation string) (map[string]indexEntry, error) {
	paths, err := os.ReadDir(generation)
	if err != nil {
		return nil, err
	}
	result := map[string]indexEntry{}
	for _, path := range paths {
		if filepath.Ext(path.Name()) != ".json" {
			continue
		}
		var entries map[string]indexEntry
		if err := indexRead(filepath.Join(generation, path.Name()), &entries); err != nil {
			return nil, err
		}
		maps.Copy(result, entries)
	}
	return result, nil
}
func indexAdopt(owner string, dirty bool, selected func(string) bool, valid func(any) bool) (indexManifest, map[string]indexEntry, error) {
	manifest, err := indexCurrent(owner)
	if err != nil {
		return manifest, nil, err
	}
	rows, err := indexReadRows(filepath.Join(indexDirectory(owner), manifest.Generation))
	if err != nil {
		return manifest, nil, err
	}
	if !dirty && len(rows) != manifest.Count {
		return manifest, nil, errors.New("DERIVED_INDEX_INVALID: rebuild required")
	}
	for key, entry := range rows {
		if filepath.Base(key) != key || !selected(filepath.Join(owner, key)) || !valid(entry.Row) {
			return manifest, nil, errors.New("DERIVED_INDEX_INVALID: rebuild required")
		}
	}
	return manifest, rows, nil
}
func indexRebuild(ctx context.Context, owner string, selected func(string) bool, project func(any) (any, error), profile *indexProfile) (indexManifest, map[string]indexEntry, error) {
	manifest := indexManifest{Version: derivedVersion, Generation: id()}
	generation := filepath.Join(indexDirectory(owner), manifest.Generation)
	if err := platform.PrivateDir(generation); err != nil {
		return manifest, nil, err
	}
	rows := map[string]indexEntry{}
	var cursor repairCursor
	defer func() {
		if cursor.dir != nil {
			_ = cursor.dir.Close()
		}
	}()
	for {
		if ctx.Err() != nil {
			return manifest, nil, errors.New("INDEX_STARTUP_CANCELLED")
		}
		paths, err := repairPaths(owner, &cursor, 64)
		if err != nil {
			return manifest, nil, err
		}
		for _, path := range paths {
			if !selected(path) {
				continue
			}
			entry, err := indexCanonical(path, project, profile)
			if err != nil {
				return manifest, nil, err
			}
			if entry != nil {
				rows[filepath.Base(path)] = *entry
			}
		}
		if cursor.dir == nil {
			break
		}
		runtime.Gosched()
	}
	at := time.Now()
	shards := map[string]map[string]indexEntry{}
	for key, entry := range rows {
		name := indexShard(key)
		if shards[name] == nil {
			shards[name] = map[string]indexEntry{}
		}
		shards[name][key] = entry
	}
	for _, name := range slices.Sorted(maps.Keys(shards)) {
		if ctx.Err() != nil {
			return manifest, nil, errors.New("INDEX_STARTUP_CANCELLED")
		}
		if err := indexAtomic(filepath.Join(generation, name), []byte(wire(shards[name]))); err != nil {
			return manifest, nil, err
		}
	}
	profile.write += time.Since(at)
	manifest.Count = len(rows)
	return manifest, rows, indexSyncDirectory(generation)
}
func cleanIndexes(owner, keep string) error {
	dir := indexDirectory(owner)
	rows, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !row.IsDir() || row.Name() == keep {
			continue
		}
		if _, err := uuid.Parse(row.Name()); err == nil || strings.HasPrefix(row.Name(), "retired-") {
			if err := os.RemoveAll(filepath.Join(dir, row.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
func openIndex(ctx context.Context, owner, kind string, selected func(string) bool, valid func(any) bool, project func(any) (any, error), install func(map[string]indexEntry) error) error {
	at := time.Now()
	profile := indexProfile{}
	defer lockIndex(owner)()
	directory := indexDirectory(owner)
	dirty := filepath.Join(directory, "dirty")
	if err := platform.PrivateDir(owner); err != nil {
		return err
	}
	if err := platform.PrivateDir(dirty); err != nil {
		return err
	}
	markers, err := os.ReadDir(dirty)
	if err != nil {
		return err
	}
	adopting := time.Now()
	manifest, rows, err := indexAdopt(owner, len(markers) > 0, selected, valid)
	adopt := time.Since(adopting)
	rebuilt := err != nil
	mode := "adopt"
	if rebuilt {
		mode = "rebuild"
		manifest, rows, err = indexRebuild(ctx, owner, selected, project, &profile)
		if err != nil {
			return err
		}
	}
	generation := filepath.Join(directory, manifest.Generation)
	repairing := time.Now()
	for _, marker := range markers {
		if ctx.Err() != nil {
			return errors.New("INDEX_STARTUP_CANCELLED")
		}
		if rebuilt {
			break
		}
		key := marker.Name()
		path := filepath.Join(owner, key)
		if !selected(path) {
			continue
		}
		current, err := readStamp(path)
		if err != nil {
			return err
		}
		if stampSame(rows[key].Stamp, current) {
			continue
		}
		row, err := indexCanonical(path, project, &profile)
		if err != nil {
			return err
		}
		if _, err := indexReplace(generation, key, row); err != nil {
			return err
		}
		if row == nil {
			delete(rows, key)
		} else {
			rows[key] = *row
		}
	}
	manifest.Count = len(rows)
	repair := time.Since(repairing)
	loading := time.Now()
	if err := install(rows); err != nil {
		return err
	}
	load := time.Since(loading)
	if ctx.Err() != nil {
		return errors.New("INDEX_STARTUP_CANCELLED")
	}
	publishing := time.Now()
	if err := indexWrite(filepath.Join(directory, "current.json"), manifest); err != nil {
		return err
	}
	clearing := time.Now()
	if len(markers) > 0 {
		if err := os.Rename(dirty, filepath.Join(directory, "retired-"+id())); err != nil {
			return err
		}
		if err := platform.PrivateDir(dirty); err != nil {
			return err
		}
	}
	if err := indexSyncDirectory(dirty); err != nil {
		return err
	}
	clearMarkers := time.Since(clearing)
	if err := os.Remove(filepath.Join(directory, "invalid")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := indexSyncDirectory(directory); err != nil {
		return err
	}
	if err := indexSyncDirectory(owner); err != nil {
		return err
	}
	indexOwners.Lock()
	delete(indexOwners.preparing, physicalPath(owner))
	indexOwners.Unlock()
	recordLog("INFO", "Index startup "+wire(object{"owner": kind, "mode": mode, "rows": manifest.Count,
		"readMs": profile.read.Milliseconds(), "projectMs": profile.project.Milliseconds(), "writeMs": profile.write.Milliseconds(),
		"repairMs": repair.Milliseconds(), "loadMs": load.Milliseconds(), "publishMs": time.Since(publishing).Milliseconds(),
		"clearMarkersMs": clearMarkers.Milliseconds(), "adoptMs": adopt.Milliseconds(), "totalMs": time.Since(at).Milliseconds()}), nil)
	if ctx.Value(indexInitializer{}) == nil {
		return cleanIndexes(owner, manifest.Generation)
	}
	return nil
}
