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
	"time"
)

func notificationDirectory() string { return filepath.Join(root(), "notifications") }

func notificationBindingPath(thread, turn string) string {
	digest := hash([]byte(wire([]string{thread, turn})))
	return filepath.Join(notificationDirectory(), "tasks", digest+".json")
}

type notificationIndex struct {
	collection *fileCollection[object]
	pending    map[string]bool
	active     map[string]bool
	threads    map[string]map[string]bool
}

var notificationIndexes struct {
	sync.Mutex
	owners map[string]*notificationIndex
}

func notificationIndexProjection(value any) (any, error) {
	row := clone(obj(value))
	if row == nil || text(row, "threadId") == "" || text(row, "turnId") == "" {
		return nil, nil
	}
	for _, item := range arr(row["deliveries"]) {
		d := obj(item)
		for _, key := range []string{"finalResponse", "externalUserInputs", "changes", "dispatches", "taskError", "reconciliation", "continuation", "recovery"} {
			delete(d, key)
		}
	}
	return object{"binding": row, "scheduled": false}, nil
}

func (i *notificationIndex) put(path string, row object) {
	old := i.collection.rows[path]
	if old != nil {
		thread := text(old, "threadId")
		delete(i.threads[thread], path)
		if len(i.threads[thread]) == 0 {
			delete(i.threads, thread)
		}
	}
	delete(i.pending, path)
	delete(i.active, path)
	if row == nil {
		delete(i.collection.rows, path)
		return
	}
	i.collection.rows[path] = row
	thread := text(row, "threadId")
	if i.threads[thread] == nil {
		i.threads[thread] = map[string]bool{}
	}
	i.threads[thread][path] = true
	if find(row["deliveries"], "status", "pending") != nil || find(row["deliveries"], "status", "sending") != nil {
		i.pending[path] = true
	}
	if text(row, "sourceId") != "" && row["scopeEnd"] == nil && row["device"] == nil && !notificationObservationReusable(row) {
		i.active[path] = true
	}
}

func persistNotificationBinding(binding object) error {
	path := notificationBindingPath(text(binding, "threadId"), text(binding, "turnId"))
	old, _ := readNotificationBinding(text(binding, "threadId"), text(binding, "turnId"))
	if wire(old) == wire(binding) {
		return nil
	}
	key := physicalPath(filepath.Dir(path))
	notificationIndexes.Lock()
	index := notificationIndexes.owners[key]
	notificationIndexes.Unlock()
	if index == nil {
		return save(path, binding)
	}
	projection, err := notificationIndexProjection(binding)
	if err != nil {
		return err
	}
	if err = indexChange(context.Background(), path, func() (any, error) { return projection, save(path, binding) }); err != nil {
		return err
	}
	stamp, err := readStamp(path)
	if err != nil {
		return err
	}
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	if index = notificationIndexes.owners[key]; index != nil {
		path = filepath.Join(key, filepath.Base(path))
		index.put(path, obj(field(projection, "binding")))
		index.collection.stamps[path] = stamp
	}
	return nil
}

func loadNotificationBinding(path string) (object, error) {
	value, err := cachedLoad(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil && strings.HasPrefix(err.Error(), "INVALID_JSON:") {
		recordLog("WARN", "Ignored malformed notification binding", nil)
		return nil, nil
	}
	return obj(value), err
}

func readNotificationBinding(thread, turn string) (object, error) {
	return loadNotificationBinding(notificationBindingPath(thread, turn))
}

func notificationBindings() ([]object, error) { return notificationIndexedBindings("", nil) }
func selectNotificationBindings(selectRow func(object) bool) ([]object, error) {
	return notificationIndexedBindings("", selectRow)
}
func pendingNotificationBindings() ([]object, error) {
	return notificationIndexedBindings("pending", func(b object) bool {
		return find(b["deliveries"], "status", "pending") != nil || find(b["deliveries"], "status", "sending") != nil
	})
}
func activeNotificationBindings() ([]object, error) {
	return notificationIndexedBindings("active", func(b object) bool {
		return b["scopeEnd"] == nil && b["device"] == nil && !notificationObservationReusable(b)
	})
}

func notificationIndexedBindings(partition string, filter func(object) bool) ([]object, error) {
	dir := physicalPath(filepath.Join(notificationDirectory(), "tasks"))
	if err := indexAvailable(context.Background(), dir); err != nil {
		return nil, err
	}
	notificationIndexes.Lock()
	index := notificationIndexes.owners[dir]
	var paths []string
	if index != nil {
		// Use a separate metadata snapshot when refreshing so the previous
		// projection remains available to remove a changed row's partitions.
		before := maps.Clone(index.collection.rows)
		changed, err := index.collection.refresh(func(path string) (object, error) {
			row, err := loadNotificationBinding(path)
			if err != nil || row == nil {
				return nil, err
			}
			projection, err := notificationIndexProjection(row)
			return obj(field(projection, "binding")), err
		})
		if err != nil {
			notificationIndexes.Unlock()
			return nil, err
		}
		for _, path := range changed {
			row := index.collection.rows[path]
			index.collection.rows[path] = before[path]
			index.put(path, row)
		}
		switch partition {
		case "pending":
			paths = slices.Sorted(maps.Keys(index.pending))
		case "active":
			paths = slices.Sorted(maps.Keys(index.active))
		default:
			for path, row := range index.collection.rows {
				if filter == nil || filter(row) {
					paths = append(paths, path)
				}
			}
			slices.Sort(paths)
		}
	}
	notificationIndexes.Unlock()
	if index == nil {
		files, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			return []object{}, nil
		}
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			if !file.IsDir() && strings.HasSuffix(file.Name(), ".json") {
				paths = append(paths, filepath.Join(dir, file.Name()))
			}
		}
	}
	rows := make([]object, 0, len(paths))
	for _, path := range paths {
		row, err := loadNotificationBinding(path)
		if err != nil {
			return nil, err
		}
		if row != nil && (filter == nil || filter(row)) {
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func wakeNotificationThread(thread string) {
	// RPC observation calls this while holding its native event mutex. A
	// non-blocking signal keeps that lock independent of notification reads.
	notificationIndexes.Lock()
	for _, index := range notificationIndexes.owners {
		for path := range index.threads[thread] {
			index.active[path] = true
		}
	}
	notificationIndexes.Unlock()
	select {
	case notificationNativeWake <- struct{}{}:
	default:
	}
}

var notificationNativeWake = make(chan struct{}, 1)

func startNotificationOwner(parent context.Context, s *service) error {
	dir := physicalPath(filepath.Join(notificationDirectory(), "tasks"))
	prepareIndexes([]string{dir})
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	s.cleanup = append(s.cleanup, func() {
		cancel()
		<-done
		notificationIndexes.Lock()
		index := notificationIndexes.owners[dir]
		delete(notificationIndexes.owners, dir)
		notificationIndexes.Unlock()
		if index != nil {
			index.collection.close()
		}
	})
	go func() {
		defer close(done)
		index := &notificationIndex{pending: map[string]bool{}, active: map[string]bool{}, threads: map[string]map[string]bool{}}
		err := openIndex(context.WithValue(ctx, indexInitializer{}, true), dir, "notification",
			func(path string) bool { return filepath.Ext(path) == ".json" },
			func(row any) bool { return text(field(row, "binding"), "turnId") != "" },
			notificationIndexProjection,
			func(rows map[string]indexEntry) error {
				index.collection = newFileCollection[object](dir)
				index.collection.initialized = true
				for name, row := range rows {
					path := filepath.Join(dir, name)
					index.put(path, obj(field(row.Row, "binding")))
					index.collection.stamps[path] = row.Stamp
				}
				notificationIndexes.Lock()
				if notificationIndexes.owners == nil {
					notificationIndexes.owners = map[string]*notificationIndex{}
				}
				notificationIndexes.owners[dir] = index
				notificationIndexes.Unlock()
				return nil
			})
		if err != nil {
			if ctx.Err() == nil {
				recordLog("WARN", "Notification index initialization: "+err.Error(), nil)
			}
			return
		}
		if observeNotificationTurn != nil && mergeNotificationLifecycle != nil {
			if err := recoverNotificationObservations(ctx, s); err != nil && ctx.Err() == nil {
				recordLog("WARN", "Notification startup observation: "+err.Error(), nil)
			}
		}
		var observed sync.WaitGroup
		if observeNotificationTurn != nil && mergeNotificationLifecycle != nil {
			observed.Go(func() {
				tick := time.NewTicker(time.Second)
				defer tick.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-notificationNativeWake:
					case <-tick.C:
					}
					if err := recoverNotificationObservations(ctx, s); err != nil && ctx.Err() == nil {
						recordLog("WARN", "Notification observation: "+err.Error(), nil)
					}
				}
			})
		}
		if notificationSourceAuthority != nil {
			runNotificationScheduler(ctx, s)
		} else {
			<-ctx.Done()
		}
		observed.Wait()
	}()
	return nil
}

func init() {
	registerServiceStartup(startNotificationOwner)
	nativeThreadChanged = append(nativeThreadChanged, wakeNotificationThread)
}
