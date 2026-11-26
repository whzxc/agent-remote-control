package core

import (
	"sync"
	"time"
)

const deviceConnectionSlots = 8

type deviceConnections struct {
	mu      sync.Mutex
	next    uint64
	entries map[uint64]*deviceConnectionEntry
}

type deviceConnectionEntry struct {
	controller string
	active     int
	idleSince  time.Time
	cancel     func()
}

type deviceConnection struct {
	pool *deviceConnections
	id   uint64
}

func (pool *deviceConnections) admit(controller string, cancel func()) *deviceConnection {
	pool.mu.Lock()
	if pool.entries == nil {
		pool.entries = make(map[uint64]*deviceConnectionEntry)
	}
	var evict func()
	if len(pool.entries) >= deviceConnectionSlots {
		var oldest *deviceConnectionEntry
		var oldestID uint64
		for id, entry := range pool.entries {
			if entry.controller == controller && entry.active == 0 &&
				(oldest == nil || entry.idleSince.Before(oldest.idleSince) ||
					entry.idleSince.Equal(oldest.idleSince) && id < oldestID) {
				oldest, oldestID = entry, id
			}
		}
		if oldest == nil {
			pool.mu.Unlock()
			return nil
		}
		delete(pool.entries, oldestID)
		evict = oldest.cancel
	}
	id := pool.next
	pool.next++
	pool.entries[id] = &deviceConnectionEntry{controller: controller, idleSince: time.Now(), cancel: cancel}
	pool.mu.Unlock()
	if evict != nil {
		evict()
	}
	return &deviceConnection{pool, id}
}

func (connection *deviceConnection) close() {
	connection.pool.mu.Lock()
	defer connection.pool.mu.Unlock()
	delete(connection.pool.entries, connection.id)
}

func (connection *deviceConnection) request() (func(), bool) {
	pool := connection.pool
	pool.mu.Lock()
	defer pool.mu.Unlock()
	entry := pool.entries[connection.id]
	if entry == nil {
		return nil, false
	}
	entry.active++
	return func() {
		pool.mu.Lock()
		defer pool.mu.Unlock()
		entry.active--
		if entry.active == 0 {
			entry.idleSince = time.Now()
		}
	}, true
}
