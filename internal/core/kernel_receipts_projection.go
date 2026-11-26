package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/google/uuid"
)

func selectFields(value any, names ...string) object {
	result := object{}
	for _, key := range names {
		if v, present := obj(value)[key]; present {
			result[key] = v
		}
	}
	return result
}

func receiptSummary(value any) (any, error) {
	row := obj(value)
	if row == nil {
		return nil, errors.New("INVALID_RECEIPT")
	}
	row = maps.Clone(row)
	result := row["result"]
	summary := selectFields(result, "error", "threadId")
	for _, key := range []string{"thread", "resolved"} {
		if data, exists := obj(result)[key]; exists {
			if key == "thread" {
				summary[key] = selectFields(data, "id", "name", "cwd")
			} else {
				resolved := selectFields(data, "cwd")
				if thread, exists := obj(data)["thread"]; exists {
					resolved["thread"] = selectFields(thread, "id", "name", "cwd")
				}
				summary[key] = resolved
			}
		}
	}
	row["result"] = summary
	if strings.HasPrefix(text(row, "operation"), "agent_") {
		row["arguments"] = selectFields(row["arguments"], "approval", "title", "prompt", "cwd", "model")
	} else {
		delete(row, "arguments")
	}
	delete(row, "coordinationPending")
	return row, nil
}
func isReceiptPath(path string) bool {
	if filepath.Ext(path) != ".json" {
		return false
	}
	_, err := uuid.Parse(strings.TrimSuffix(filepath.Base(path), ".json"))
	return err == nil
}

type receiptIndex struct {
	sync.Mutex
	owner    string
	rows     map[string]indexEntry
	changes  []receiptChange
	revision uint64
	watch    *fileChanges
	repair   repairCursor
	after    string
}
type receiptChange struct {
	revision uint64
	path     string
}

var receiptIndexes sync.Map

func findReceiptIndex(ctx context.Context, owner string) (*receiptIndex, error) {
	owner = physicalPath(owner)
	if err := indexAvailable(ctx, owner); err != nil {
		return nil, err
	}
	value, _ := receiptIndexes.LoadOrStore(owner, &receiptIndex{owner: owner})
	return value.(*receiptIndex), nil
}
func (i *receiptIndex) initialize(ctx context.Context) error {
	if i.rows != nil {
		return nil
	}
	var loaded map[string]indexEntry
	watch := newFileChanges()
	watch.add(filepath.Join(i.owner, ".index-watch"))
	installed := false
	defer func() {
		if !installed {
			watch.close()
		}
	}()
	err := openIndex(ctx, i.owner, "receipts", isReceiptPath, func(value any) bool { return obj(value) != nil }, receiptSummary, func(rows map[string]indexEntry) error {
		loaded = make(map[string]indexEntry, len(rows))
		for key, entry := range rows {
			loaded[filepath.Join(i.owner, key)] = entry
		}
		return nil
	})
	if err != nil {
		return err
	}
	i.rows, i.watch = loaded, watch
	installed = true
	return nil
}
func (i *receiptIndex) refresh(ctx context.Context, path string) error {
	stamp, err := readStamp(path)
	if err != nil {
		return err
	}
	if stampSame(stamp, i.rows[path].Stamp) {
		return nil
	}
	var candidate *indexEntry
	if stamp != nil {
		candidate, err = indexCanonical(path, receiptSummary, &indexProfile{})
		if err != nil {
			return err
		}
	}
	var summary any
	if candidate != nil {
		summary = candidate.Row
	}
	if err := indexUpdate(ctx, path, summary); err != nil {
		return err
	}
	if candidate != nil {
		i.rows[path] = *candidate
	} else {
		delete(i.rows, path)
	}
	i.revision++
	i.changes = append(i.changes, receiptChange{i.revision, path})
	if len(i.changes) > 8192 {
		i.changes = append([]receiptChange(nil), i.changes[len(i.changes)-8192:]...)
	}
	return nil
}
func (i *receiptIndex) drain(ctx context.Context) error {
	if err := i.initialize(ctx); err != nil {
		return err
	}
	paths, failed := i.watch.drain()
	for at, path := range paths {
		if filepath.Dir(path) == i.owner && isReceiptPath(path) {
			if err := i.refresh(ctx, path); err != nil {
				for _, pending := range paths[at:] {
					i.watch.changed(pending)
				}
				return err
			}
		}
	}
	if !failed {
		return nil
	}
	keys := slices.Sorted(maps.Keys(i.rows))
	begin, _ := slices.BinarySearch(keys, i.after)
	if begin < len(keys) && keys[begin] == i.after {
		begin++
	}
	batch := keys[begin:min(len(keys), begin+32)]
	i.after = ""
	if len(batch) > 0 {
		i.after = batch[len(batch)-1]
	}
	for _, path := range batch {
		if err := i.refresh(ctx, path); err != nil {
			return err
		}
	}
	next, err := repairPaths(i.owner, &i.repair, 32)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, path := range next {
		if isReceiptPath(path) {
			if err := i.refresh(ctx, path); err != nil {
				return err
			}
		}
	}
	return nil
}
func readReceiptProjection(ctx context.Context, path string) (object, error) {
	index, err := findReceiptIndex(ctx, filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	index.Lock()
	defer index.Unlock()
	if err := index.drain(ctx); err != nil {
		return nil, err
	}
	path = filepath.Join(index.owner, filepath.Base(path))
	if err := index.refresh(ctx, path); err != nil {
		return nil, err
	}
	row := obj(index.rows[path].Row)
	if row == nil {
		return nil, errors.New("INVALID_RECEIPT")
	}
	return clone(row), nil
}

type receiptProjectionUpdate struct {
	key string
	row object
}

func receiptProjectionUpdates(ctx context.Context, owner string, revision *uint64) (uint64, bool, []receiptProjectionUpdate, error) {
	index, err := findReceiptIndex(ctx, owner)
	if err != nil {
		return 0, false, nil, err
	}
	index.Lock()
	defer index.Unlock()
	if err := index.drain(ctx); err != nil {
		return 0, false, nil, err
	}
	var minRevision uint64
	if len(index.changes) > 0 {
		minRevision = index.changes[0].revision - 1
	}
	reset := revision == nil || *revision < minRevision
	selected := map[string]bool{}
	if reset {
		for path := range index.rows {
			selected[path] = true
		}
	} else {
		for _, change := range index.changes {
			if change.revision > *revision {
				selected[change.path] = true
			}
		}
	}
	updates := []receiptProjectionUpdate{}
	for _, path := range slices.Sorted(maps.Keys(selected)) {
		key := strings.TrimSuffix(filepath.Base(path), ".json")
		updates = append(updates, receiptProjectionUpdate{key, clone(obj(index.rows[path].Row))})
	}
	return index.revision, reset, updates, nil
}
func seedReceiptIndex(ctx context.Context, owner string) error {
	index, err := findReceiptIndex(ctx, owner)
	if err != nil {
		return err
	}
	index.Lock()
	defer index.Unlock()
	return index.drain(ctx)
}
func closeReceiptIndex(directory string) {
	key := physicalPath(directory)
	if value, ok := receiptIndexes.LoadAndDelete(key); ok {
		index := value.(*receiptIndex)
		index.Lock()
		defer index.Unlock()
		if index.watch != nil {
			index.watch.close()
		}
		if index.repair.dir != nil {
			_ = index.repair.dir.Close()
		}
	}
}
