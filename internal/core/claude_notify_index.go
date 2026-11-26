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
	collection        *fileCollection[object]
	pending           map[string]bool
	active            map[string]bool
	threads           map[string]map[string]bool
	projections       map[string]object
	workers           sync.WaitGroup
	deliveryAt        map[string]int64
	statusViews       map[string]notificationStatusView
	statusOwners      *fileChanges
	nativeEvidence    *fileChanges
	evidence          map[string]map[string]bool
	evidenceByBinding map[string]notificationEvidenceWatch
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
	old := i.projections[path]
	clear(i.statusViews)
	delete(i.deliveryAt, path)
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
		delete(i.projections, path)
		i.removeEvidence(path)
		return
	}
	i.collection.rows[path] = row
	i.projections[path] = row
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
		if err := index.refresh(); err != nil {
			notificationIndexes.Unlock()
			return nil, err
		}
		switch partition {
		case "pending":
			paths = slices.Sorted(maps.Keys(index.pending))
		case "delivery-due":
			now := notificationClock().Unix()
			for path := range index.pending {
				if at, exists := index.deliveryAt[path]; !exists || at != 0 && at <= now {
					paths = append(paths, path)
				}
			}
			slices.Sort(paths)
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
	recordRuntimeWork(context.Background(), runtimeWorkCost{Owner: "notification", Reason: partition, Rows: len(paths), ScanSet: len(paths)})
	rows := make([]object, 0, len(paths))
	for _, path := range paths {
		row, err := loadNotificationBinding(path)
		if err != nil {
			return nil, err
		}
		if row != nil && (filter == nil || filter(row) || partition == "active" && index != nil) {
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func (i *notificationIndex) refresh() error {
	changed, err := i.collection.refresh(func(path string) (object, error) {
		row, err := loadNotificationBinding(path)
		if err != nil || row == nil {
			return nil, err
		}
		projection, err := notificationIndexProjection(row)
		return obj(field(projection, "binding")), err
	})
	if err != nil {
		return err
	}
	for _, path := range changed {
		i.put(path, i.collection.rows[path])
	}
	return nil
}

func notificationStatusIndex() (*notificationIndex, error) {
	dir := physicalPath(notificationOwnerPath())
	if err := indexAvailable(context.Background(), dir); err != nil {
		return nil, err
	}
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	index := notificationIndexes.owners[dir]
	if index == nil {
		return nil, nil
	}
	if err := index.refresh(); err != nil {
		return nil, err
	}
	if changed, failed := index.statusOwners.drain(); len(changed) != 0 || failed {
		clear(index.statusViews)
	}
	return index, nil
}

func invalidateNotificationScheduling() {
	notificationIndexes.Lock()
	defer notificationIndexes.Unlock()
	for _, index := range notificationIndexes.owners {
		clear(index.deliveryAt)
	}
}

func persistNotificationSchedule(ctx context.Context, b object, at int64) error {
	path := notificationBindingPath(text(b, "threadId"), text(b, "turnId"))
	dir := physicalPath(filepath.Dir(path))
	key := filepath.Join(dir, filepath.Base(path))
	notificationIndexes.Lock()
	index := notificationIndexes.owners[dir]
	if index == nil {
		notificationIndexes.Unlock()
		return nil
	}
	current, known := index.deliveryAt[key]
	notificationIndexes.Unlock()
	if known && current == at {
		return nil
	}
	row, err := notificationIndexProjection(b)
	if err != nil || row == nil {
		return err
	}
	p := obj(row)
	p["scheduled"], p["deliveryAt"] = true, nil
	if at != 0 {
		p["deliveryAt"] = at
	}
	if err := indexUpdate(ctx, path, p); err != nil {
		return err
	}
	notificationIndexes.Lock()
	index.deliveryAt[key] = at
	notificationIndexes.Unlock()
	return nil
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

func notificationOwnerPath() string {
	return filepath.Join(notificationDirectory(), "tasks")
}

func openNotificationOwner(ctx context.Context, _ *service) error {
	dir := physicalPath(notificationOwnerPath())
	index := &notificationIndex{
		pending: map[string]bool{}, active: map[string]bool{}, threads: map[string]map[string]bool{},
		projections: map[string]object{}, deliveryAt: map[string]int64{}, statusViews: map[string]notificationStatusView{},
		evidence: map[string]map[string]bool{}, evidenceByBinding: map[string]notificationEvidenceWatch{},
	}
	return openIndex(ctx, dir, "notification",
		func(path string) bool { return filepath.Ext(path) == ".json" },
		func(row any) bool { return text(field(row, "binding"), "turnId") != "" },
		notificationIndexProjection,
		func(rows map[string]indexEntry) error {
			index.nativeEvidence = newFileChanges()
			index.statusOwners = newFileChanges()
			index.statusOwners.add(filepath.Join(root(), "execution", "handoffs", ".index-watch"))
			index.collection = newFileCollection[object](dir)
			index.collection.initialized = true
			for name, row := range rows {
				path := filepath.Join(dir, name)
				index.put(path, obj(field(row.Row, "binding")))
				if field(row.Row, "scheduled") == true {
					index.deliveryAt[path] = int64(uintOr(field(row.Row, "deliveryAt"), 0))
				}
				index.collection.stamps[path] = row.Stamp
			}
			notificationIndexes.Lock()
			defer notificationIndexes.Unlock()
			if notificationIndexes.owners == nil {
				notificationIndexes.owners = map[string]*notificationIndex{}
			}
			notificationIndexes.owners[dir] = index
			return nil
		})
}

func closeNotificationOwner(dir string) {
	notificationIndexes.Lock()
	index := notificationIndexes.owners[dir]
	notificationIndexes.Unlock()
	if index != nil {
		index.workers.Wait()
		notificationIndexes.Lock()
		delete(notificationIndexes.owners, dir)
		notificationIndexes.Unlock()
		index.collection.close()
		index.statusOwners.close()
		index.nativeEvidence.close()
	}
}

func startNotificationWorkers(ctx context.Context, s *service) error {
	notificationIndexes.Lock()
	index := notificationIndexes.owners[physicalPath(notificationOwnerPath())]
	notificationIndexes.Unlock()
	if index == nil {
		return errors.New(indexPending)
	}
	index.workers.Go(func() {
		if err := recoverNotificationObservations(ctx, s); err != nil && ctx.Err() == nil {
			recordLog("WARN", "Notification startup observation: "+err.Error(), nil)
		}
		if ctx.Err() != nil {
			return
		}
		if err := pruneNotificationBindings(ctx); err != nil {
			recordLog("WARN", "Notification retention: "+err.Error(), nil)
		}
		if err := recoverNotificationDeliveries(); err != nil {
			recordLog("WARN", "Notification startup delivery: "+err.Error(), nil)
			return
		}
		if notificationSourceAuthority != nil {
			invalidateNotificationScheduling()
			index.workers.Go(func() { runNotificationScheduler(ctx, s) })
		}
		if observeNotificationTurn == nil || mergeNotificationLifecycle == nil {
			return
		}
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		retention := time.NewTicker(time.Hour)
		defer retention.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-notificationNativeWake:
			case <-index.nativeEvidence.wake:
				paths, _ := index.nativeEvidence.drain()
				for _, path := range paths {
					wakeNotificationEvidence(path)
				}
			case <-tick.C:
			case <-retention.C:
				if err := pruneNotificationBindings(ctx); err != nil && ctx.Err() == nil {
					recordLog("WARN", "Notification retention: "+err.Error(), nil)
				}
			}
			if err := recoverNotificationObservations(ctx, s); err != nil && ctx.Err() == nil {
				recordLog("WARN", "Notification observation: "+err.Error(), nil)
			}
		}
	})
	return nil
}

func init() {
	registerStartupIndex(notificationOwnerPath, 30, openNotificationOwner, closeNotificationOwner)
	registerIndexPreparation(30, migrateNotificationState)
	registerAfterIndexStartup(30, startNotificationWorkers)
	nativeThreadChanged = append(nativeThreadChanged, wakeNotificationThread)
	nativeInteractionObserved = append(nativeInteractionObserved, func(_ *rpcConnection, request object) {
		task := text(request["params"], "threadId")
		if task != "" {
			if err := notificationRoutingObserve("codex", task, request); err != nil {
				recordLog("WARN", "Notification request routing: "+err.Error(), nil)
			}
			wakeNotificationThread(task)
		}
	})
	nativeTerminalObserved = append(nativeTerminalObserved, func(method string, params any) {
		if method == "turn/completed" || method == "turn/started" {
			if task := text(params, "threadId"); task != "" {
				wakeNotificationThread(task)
			}
		}
	})
}

func expiredNotificationBinding(b object, now int64, superseded bool) bool {
	return (superseded || b["continuationBound"] == true || b["scopeEnd"] != nil) &&
		notificationTerminal(text(b["observation"], "state")) && find(b["deliveries"], "status", "pending") == nil && find(b["deliveries"], "status", "sending") == nil &&
		now-int64(uintOr(b["createdAt"], 0)) > 7*24*60*60
}

func pruneNotificationBindings(ctx context.Context) error {
	notificationEventOperation.Lock()
	defer notificationEventOperation.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	now := notificationClock().Unix()
	latest := map[[2]string]uint64{}
	dir := physicalPath(notificationOwnerPath())
	notificationIndexes.Lock()
	index := notificationIndexes.owners[dir]
	if index == nil {
		notificationIndexes.Unlock()
		return nil
	}
	for _, b := range index.projections {
		key := [2]string{text(b, "sourceId"), text(b, "threadId")}
		latest[key] = max(latest[key], uintOr(b["createdAt"], 0))
	}
	var expired []object
	for _, b := range index.projections {
		key := [2]string{text(b, "sourceId"), text(b, "threadId")}
		if expiredNotificationBinding(b, now, latest[key] > uintOr(b["createdAt"], 0)) {
			expired = append(expired, b)
		}
	}
	notificationIndexes.Unlock()
	if len(expired) == 0 {
		return nil
	}
	state, err := readNotificationState()
	if err != nil {
		return err
	}
	for _, b := range expired {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		thread, turn := text(b, "threadId"), text(b, "turnId")
		key := [2]string{text(b, "sourceId"), thread}
		path := notificationBindingPath(thread, turn)
		current, err := loadNotificationBinding(path)
		if err != nil {
			return err
		}
		if current == nil || !expiredNotificationBinding(current, now, latest[key] > uintOr(current["createdAt"], 0)) {
			continue
		}
		before, _ := readStamp(filepath.Dir(path))
		if err := indexChange(ctx, path, func() (any, error) {
			err := os.Remove(path)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
			return nil, err
		}); err != nil {
			return err
		}
		markCachedFileChanged(path, before)
		notificationIndexes.Lock()
		index.put(filepath.Join(dir, filepath.Base(path)), nil)
		notificationIndexes.Unlock()
		sub := "sub_" + hash([]byte(wire([]any{current["channel"], current["sourceId"], current["agent"], thread, turn})))
		removeNotificationSubscription(state, sub)
	}
	return saveNotificationState(state)
}
