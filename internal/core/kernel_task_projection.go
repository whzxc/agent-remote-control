package core

import (
	"context"
	"maps"
	"slices"
)

type taskDependency struct {
	stamp    *fileStamp
	requests map[string]bool
}

type taskProjection struct {
	session          string
	revision         *uint64
	watch            *fileChanges
	dependencies     map[string]taskDependency
	requestPaths     map[string][]string
	positions        map[string]int
	retry            map[string]bool
	repairAfter      string
	records, display []object
}

func (p *taskProjection) close() {
	if p.watch != nil {
		p.watch.close()
	}
}

func (p *taskProjection) reset(session string) {
	p.close()
	*p = taskProjection{
		session: session, watch: newFileChanges(), dependencies: make(map[string]taskDependency),
		requestPaths: make(map[string][]string), positions: make(map[string]int), retry: make(map[string]bool),
	}
}

func (p *taskProjection) refreshDependency(path string) error {
	dependency, ok := p.dependencies[path]
	if !ok {
		return nil
	}
	stamp, err := readStamp(path)
	if err != nil {
		return err
	}
	if !stampSame(dependency.stamp, stamp) {
		dependency.stamp = stamp
		p.dependencies[path] = dependency
		maps.Copy(p.retry, dependency.requests)
	}
	return nil
}

func (p *taskProjection) rebind(request string, row object, paths func(object) []string) {
	previous := p.requestPaths[request]
	delete(p.requestPaths, request)
	if row != nil {
		for _, path := range paths(row) {
			path = physicalPath(path)
			dependency, exists := p.dependencies[path]
			if !exists {
				p.watch.add(path)
				stamp, _ := readStamp(path)
				dependency = taskDependency{stamp: stamp, requests: make(map[string]bool)}
				p.dependencies[path] = dependency
			}
			dependency.requests[request] = true
			p.requestPaths[request] = append(p.requestPaths[request], path)
		}
	}
	for _, path := range previous {
		if slices.Contains(p.requestPaths[request], path) {
			continue
		}
		dependency := p.dependencies[path]
		delete(dependency.requests, request)
		if len(dependency.requests) == 0 {
			delete(p.dependencies, path)
			p.watch.remove(path)
		}
	}
}

func (p *taskProjection) update(ctx context.Context, store receiptStore, session string, dependencies func(object) []string, project func(object) (object, error), display func(object) object) ([]object, error) {
	if p.watch == nil || p.session != session {
		p.reset(session)
	}
	revision, reset, updates, err := receiptProjectionUpdates(ctx, store.base, p.revision)
	if err != nil {
		return nil, err
	}
	if reset {
		p.reset(session)
	}

	paths, failed := p.watch.drain()
	for _, path := range paths {
		if err := p.refreshDependency(path); err != nil {
			return nil, err
		}
	}
	if failed {
		keys := slices.Sorted(maps.Keys(p.dependencies))
		begin, equal := slices.BinarySearch(keys, p.repairAfter)
		if equal {
			begin++
		}
		end := min(begin+64, len(keys))
		for _, path := range keys[begin:end] {
			_ = p.refreshDependency(path)
		}
		p.repairAfter = ""
		if end < len(keys) {
			p.repairAfter = keys[end-1]
		}
	}

	changed := make(map[string]object, len(updates)+len(p.retry))
	for _, update := range updates {
		changed[update.key] = update.row
	}
	for request := range p.retry {
		if _, changedNow := changed[request]; !changedNow {
			row, err := store.projected(ctx, request, session)
			if err != nil {
				return nil, err
			}
			changed[request] = row
		}
	}
	clear(p.retry)
	if len(changed) != 0 {
		p.records = slices.Clone(p.records)
		p.display = slices.Clone(p.display)
	}
	for _, request := range slices.Sorted(maps.Keys(changed)) {
		receipt := changed[request]
		var row object
		if receipt != nil {
			receipt, err = normalizeReceipt(receipt, session)
			if err != nil {
				return nil, err
			}
			row, err = project(receipt)
		}
		p.rebind(request, receipt, dependencies)
		if err != nil {
			p.retry[request] = true
			recordLog("WARN", "Task projection deferred: "+err.Error(), nil)
			err = nil
			continue
		}
		p.apply(request, row, display)
	}
	p.revision = &revision
	return p.records, nil
}

func (p *taskProjection) apply(request string, row object, display func(object) object) {
	position, exists := p.positions[request]
	switch {
	case exists && row != nil:
		if wire(p.records[position]) != wire(row) {
			p.records[position], p.display[position] = row, display(row)
		}
	case row != nil:
		at, _ := slices.BinarySearchFunc(p.records, row, func(a, b object) int {
			if text(a, "createdAt") > text(b, "createdAt") {
				return -1
			}
			return 1
		})
		p.records = slices.Insert(p.records, at, row)
		p.display = slices.Insert(p.display, at, display(row))
		for key, pos := range p.positions {
			if pos >= at {
				p.positions[key]++
			}
		}
		p.positions[request] = at
	case exists:
		p.records = slices.Delete(p.records, position, position+1)
		p.display = slices.Delete(p.display, position, position+1)
		delete(p.positions, request)
		for key, pos := range p.positions {
			if pos > position {
				p.positions[key]--
			}
		}
	}
}
