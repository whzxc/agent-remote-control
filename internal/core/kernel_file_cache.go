package core

import (
	"container/list"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const cacheBytes = 32 * 1024 * 1024
const cacheFiles = 8192

type indexTime struct {
	Seconds int64 `json:"secs_since_epoch"`
	Nanos   int   `json:"nanos_since_epoch"`
}
type fileStamp struct {
	Modified *indexTime `json:"modified"`
	Created  *indexTime `json:"created"`
	Length   uint64     `json:"len"`
	Identity *[4]int64  `json:"identity,omitempty"`
}

func stampTime(raw time.Time) *indexTime {
	if raw.IsZero() {
		return nil
	}
	return &indexTime{raw.Unix(), raw.Nanosecond()}
}
func readStamp(path string) (*fileStamp, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	identity, birth := platform.FileIdentity(path, info)
	return &fileStamp{stampTime(info.ModTime()), stampTime(birth), uint64(info.Size()), identity}, nil
}

func samePointer[T comparable](a, b *T) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func stampSame(a, b *fileStamp) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Length == b.Length && samePointer(a.Modified, b.Modified) && samePointer(a.Created, b.Created) && samePointer(a.Identity, b.Identity)
}
func (s *fileStamp) appendsTo(previous *fileStamp) bool {
	if s == nil || previous == nil || s.Length <= previous.Length {
		return false
	}
	if s.Identity != nil && previous.Identity != nil {
		return s.Identity[0] == previous.Identity[0] && s.Identity[1] == previous.Identity[1]
	}
	return samePointer(s.Created, previous.Created)
}

type cacheEntry[T any] struct {
	stamp fileStamp
	path  string
	value T
}
type directoryEntry struct {
	path string
	kind os.FileMode
}
type cachedDirectory struct {
	stamp   *fileStamp
	entries []directoryEntry
}
type cacheIO struct{ fileOpens, directoryReads uint64 }
type fileCache[T any] struct {
	files                               map[string]*list.Element
	recency                             list.List
	dirs                                map[string]cachedDirectory
	size, hits, evictions, evictedBytes uint64
	io                                  cacheIO
}

func (c *fileCache[T]) insert(path string, stamp *fileStamp, value T) {
	if stamp == nil || stamp.Length > cacheBytes {
		return
	}
	if c.files == nil {
		c.files = make(map[string]*list.Element)
	}
	for c.size+stamp.Length > cacheBytes || len(c.files) >= cacheFiles {
		oldest := c.recency.Back()
		entry := oldest.Value.(cacheEntry[T])
		c.remove(entry.path)
		c.evictions++
		c.evictedBytes += entry.stamp.Length
	}
	c.size += stamp.Length
	c.files[path] = c.recency.PushFront(cacheEntry[T]{*stamp, path, value})
}
func (c *fileCache[T]) remove(path string) {
	if old := c.files[path]; old != nil {
		c.size -= old.Value.(cacheEntry[T]).stamp.Length
		c.recency.Remove(old)
		delete(c.files, path)
	}
}
func (c *fileCache[T]) read(path string, decode func([]byte) (T, error)) (T, error) {
	var empty T
	cost := fileCost{Path: path, Rows: 1}
	defer func() { recordFileCost(cost) }()
	stamp, err := readStamp(path)
	if err != nil {
		return empty, err
	}
	if stamp == nil {
		return empty, fmt.Errorf("File not found: %s: %w", path, os.ErrNotExist)
	}
	if cached := c.files[path]; cached != nil {
		row := cached.Value.(cacheEntry[T])
		if stampSame(&row.stamp, stamp) {
			c.recency.MoveToFront(cached)
			c.hits++
			cost.CacheHits = 1
			return row.value, nil
		}
	}
	c.io.fileOpens++
	cost.CacheMisses = 1
	bytes, err := os.ReadFile(path)
	if err != nil {
		return empty, err
	}
	cost.BytesRead, cost.BytesParsed = len(bytes), len(bytes)
	decoded, err := decode(bytes)
	if err != nil {
		return empty, err
	}
	c.remove(path)
	after, err := readStamp(path)
	if err != nil {
		return empty, err
	}
	if stampSame(stamp, after) {
		c.insert(path, stamp, decoded)
	}
	return decoded, nil
}
func (c *fileCache[T]) entries(path string) ([]directoryEntry, error) {
	stamp, err := readStamp(path)
	if err != nil {
		return nil, err
	}
	if cached, ok := c.dirs[path]; ok && stampSame(cached.stamp, stamp) {
		recordFileCost(fileCost{Path: path, CacheHits: 1})
		return slices.Clone(cached.entries), nil
	}
	recordFileCost(fileCost{Path: path, CacheMisses: 1})
	entries := []directoryEntry{}
	if stamp != nil {
		c.io.directoryReads++
		files, err := os.ReadDir(path)
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			entries = append(entries, directoryEntry{filepath.Join(path, file.Name()), file.Type()})
		}
	}
	after, err := readStamp(path)
	if err != nil {
		return nil, err
	}
	if stampSame(stamp, after) {
		if c.dirs == nil {
			c.dirs = make(map[string]cachedDirectory)
		}
		if _, exists := c.dirs[path]; !exists && len(c.dirs) >= 2048 {
			clear(c.dirs)
		}
		c.dirs[path] = cachedDirectory{after, slices.Clone(entries)}
	}
	return entries, nil
}
func (c *fileCache[T]) changed(path string, before *fileStamp) {
	c.remove(path)
	parent := filepath.Dir(path)
	row, present := c.dirs[parent]
	if !present {
		return
	}
	if !stampSame(row.stamp, before) {
		delete(c.dirs, parent)
		return
	}
	row.entries = slices.DeleteFunc(row.entries, func(e directoryEntry) bool { return e.path == path })
	if info, err := os.Lstat(path); err == nil {
		row.entries = append(row.entries, directoryEntry{path, info.Mode().Type()})
		slices.SortFunc(row.entries, func(a, b directoryEntry) int { return strings.Compare(a.path, b.path) })
	}
	stamp, err := readStamp(parent)
	if err != nil {
		delete(c.dirs, parent)
		return
	}
	row.stamp = stamp
	c.dirs[parent] = row
}
func (c *fileCache[T]) written(path string, before *fileStamp, value T) error {
	c.changed(path, before)
	stamp, err := readStamp(path)
	if err == nil {
		c.insert(path, stamp, value)
	}
	return err
}
func cacheGroup(path, base string) string {
	relative, err := filepath.Rel(base, path)
	if err != nil || !belowPath(path, base) {
		return "other"
	}
	first, _, nested := strings.Cut(relative, string(filepath.Separator))
	if !nested {
		if _, err := uuid.Parse(strings.TrimSuffix(first, filepath.Ext(first))); err == nil {
			return "receipts"
		}
		return "settings"
	}
	switch first {
	case "accounts", "agents", "coordination", "dispatches", "execution", "external-inputs", "notifications", "respond-tokens", "send-queue", "tasks":
		return first
	default:
		return "other"
	}
}
func (c *fileCache[T]) diagnostics(base string) object {
	groups := map[string]object{}
	for path, element := range c.files {
		kind := cacheGroup(path, base)
		row := groups[kind]
		if row == nil {
			row = object{"kind": kind}
			groups[kind] = row
		}
		row["files"] = uintOr(row["files"], 0) + 1
		row["sourceBytes"] = uintOr(row["sourceBytes"], 0) + element.Value.(cacheEntry[T]).stamp.Length
	}
	names := slices.Sorted(maps.Keys(groups))
	summary := make([]object, 0, len(names))
	for _, name := range names {
		summary = append(summary, groups[name])
	}
	return object{"files": len(c.files), "directories": len(c.dirs), "sourceBytes": c.size,
		"sourceByteLimit": cacheBytes, "fileLimit": cacheFiles, "fileOpens": c.io.fileOpens, "directoryReads": c.io.directoryReads,
		"hits": c.hits, "evictions": c.evictions, "evictedSourceBytes": c.evictedBytes, "groups": summary}
}

type fileProjection[T any] struct {
	stamps []*fileStamp
	value  T
}

func projectionStamps(paths []string) ([]*fileStamp, error) {
	stamps := make([]*fileStamp, 0, len(paths))
	for _, path := range paths {
		stamp, err := readStamp(path)
		if err != nil {
			return nil, err
		}
		stamps = append(stamps, stamp)
	}
	return stamps, nil
}
func (p *fileProjection[T]) get(stamps []*fileStamp) (T, bool) {
	return p.value, p.stamps != nil && slices.EqualFunc(p.stamps, stamps, stampSame)
}
func (p *fileProjection[T]) set(paths []string, before []*fileStamp, value T) error {
	current, err := projectionStamps(paths)
	if err == nil && slices.EqualFunc(current, before, stampSame) {
		p.stamps, p.value = before, value
	}
	return err
}
func (p *fileProjection[T]) clear() { *p = fileProjection[T]{} }

type fileCollection[T any] struct {
	directory                 string
	rows                      map[string]T
	stamps                    map[string]*fileStamp
	watch                     *fileChanges
	repair                    repairCursor
	after                     string
	pending, unpublished      map[string]bool
	initialized, repairNeeded bool
}

func newFileCollection[T any](directory string) *fileCollection[T] {
	path := physicalPath(directory)
	watch := newFileChanges()
	watch.add(filepath.Join(path, ".index-watch"))
	return &fileCollection[T]{directory: path, rows: map[string]T{}, stamps: map[string]*fileStamp{}, watch: watch, pending: map[string]bool{}, unpublished: map[string]bool{}}
}
func (c *fileCollection[T]) close() {
	c.watch.close()
	if c.repair.dir != nil {
		_ = c.repair.dir.Close()
	}
}
func (c *fileCollection[T]) refresh(decode func(string) (T, error)) ([]string, error) {
	paths, failed := c.watch.drain()
	c.repairNeeded = failed
	if !c.initialized {
		entries, err := os.ReadDir(c.directory)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		for _, entry := range entries {
			paths = append(paths, filepath.Join(c.directory, entry.Name()))
		}
		c.initialized = true
	}
	if failed {
		keys := slices.Sorted(maps.Keys(c.stamps))
		begin, _ := slices.BinarySearch(keys, c.after)
		if begin < len(keys) && keys[begin] == c.after {
			begin++
		}
		batch := keys[begin:min(begin+32, len(keys))]
		c.after = ""
		if len(batch) > 0 {
			c.after = batch[len(batch)-1]
			paths = append(paths, batch...)
		}
		additional, err := repairPaths(c.directory, &c.repair, 32)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		paths = append(paths, additional...)
	}
	for _, path := range paths {
		c.pending[path] = true
	}
	for _, path := range slices.Sorted(maps.Keys(c.pending)) {
		if filepath.Dir(path) != c.directory || filepath.Ext(path) != ".json" {
			delete(c.pending, path)
			continue
		}
		stamp, err := readStamp(path)
		if err != nil {
			return nil, err
		}
		if old, exists := c.stamps[path]; exists && stampSame(old, stamp) {
			delete(c.pending, path)
			continue
		}
		if stamp != nil {
			row, err := decode(path)
			if err != nil {
				publishChangedFile(path)
				return nil, err
			}
			current, err := readStamp(path)
			if err != nil {
				return nil, err
			}
			if !stampSame(stamp, current) {
				publishChangedFile(path)
				break
			}
			c.rows[path] = row
		} else {
			delete(c.rows, path)
		}
		delete(c.pending, path)
		c.stamps[path] = stamp
		c.unpublished[path] = true
	}
	result := slices.Sorted(maps.Keys(c.unpublished))
	clear(c.unpublished)
	return result, nil
}

var readCache struct {
	sync.Mutex
	values fileCache[any]
}

func cachedJSON(path string) (any, error) {
	readCache.Lock()
	defer readCache.Unlock()
	return readCache.values.read(path, func(data []byte) (any, error) {
		var value any
		if err := unmarshalJSON(data, &value); err != nil {
			return nil, fmt.Errorf("INVALID_JSON: %w", err)
		}
		return value, nil
	})
}
func cachedLoad(path string) (any, error) {
	value, err := cachedJSON(path)
	if err != nil {
		return nil, err
	}
	var copy any
	err = unmarshalJSON([]byte(wire(value)), &copy)
	return copy, err
}
func cachedEntries(path string) ([]directoryEntry, error) {
	readCache.Lock()
	defer readCache.Unlock()
	return readCache.values.entries(path)
}
func cacheDiagnostics() object {
	readCache.Lock()
	defer readCache.Unlock()
	return readCache.values.diagnostics(root())
}
func markCachedFileChanged(path string, before *fileStamp) {
	publishChangedFile(path)
	readCache.Lock()
	readCache.values.changed(path, before)
	readCache.Unlock()
}
