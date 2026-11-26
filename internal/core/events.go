package core

import (
	"context"
	"maps"
	"slices"
	"sync"
)

type nativeEvent struct {
	row   object
	bytes int
}

type nativeEvents struct {
	sync.Mutex
	rows           []nativeEvent
	taskTimelines  map[string]*taskTimeline
	codexProgress  codexProgressStates
	bytes          int
	sequence       uint64
	threadSequence map[string]uint64
	forgotten      uint64
	pending        map[string]object
	desktopStates  map[[2]string]string
	changed        chan struct{}
	durable        bool
	storageError   error
}

var nativeEventObserved []func(*nativeEvents, string, string, any, string)
var nativeTerminalObserved []func(string, any)
var nativeEventEvicted []func(*nativeEvents, string, object)
var nativeThreadChanged []func(string)
var nativeTurnStatus func(thread, turn string) string
var nativeRPCDisconnected []func(*rpcConnection)
var nativeInteractionObserved []func(*rpcConnection, object)

func (e *nativeEvents) signal() {
	if e.changed != nil {
		close(e.changed)
		e.changed = nil
	}
}

func (e *nativeEvents) observe(session, method string, params any) {
	e.Lock()
	if method == "desktop/thread-stream-state-changed" {
		key := [2]string{text(params, "conversationId"), text(params, "ownerClientId")}
		digest := hash([]byte(wire(field(params, "change"))))
		if e.desktopStates[key] == digest {
			e.Unlock()
			return
		}
		if e.desktopStates == nil {
			e.desktopStates = make(map[[2]string]string)
		}
		if _, exists := e.desktopStates[key]; !exists && len(e.desktopStates) >= 2000 {
			for old := range e.desktopStates {
				delete(e.desktopStates, old)
				break
			}
		}
		e.desktopStates[key] = digest
	}
	at := now()
	for _, observer := range nativeEventObserved {
		observer(e, session, method, params, at)
	}
	e.sequence++
	if e.threadSequence == nil {
		e.threadSequence = make(map[string]uint64)
	}
	for _, key := range []string{"threadId", "conversationId"} {
		if thread, ok := field(params, key).(string); ok {
			e.threadSequence[thread] = e.sequence
			for _, listener := range nativeThreadChanged {
				listener(thread)
			}
		}
	}
	for len(e.threadSequence) > 4096 {
		var selected string
		earliest := e.sequence + 1
		for thread, sequence := range e.threadSequence {
			if sequence < earliest {
				selected, earliest = thread, sequence
			}
		}
		delete(e.threadSequence, selected)
		e.forgotten = max(e.forgotten, earliest)
	}
	row := object{"cursor": e.sequence, "backendSession": session, "method": method, "params": params, "time": at}
	wireRow := wire(row)
	e.rows = append(e.rows, nativeEvent{row, len(wireRow)})
	e.bytes += len(wireRow)
	e.signal()
	for len(e.rows) > 2000 || e.bytes > 8<<20 {
		removed := e.rows[0]
		e.rows[0] = nativeEvent{}
		e.rows = e.rows[1:]
		e.bytes -= removed.bytes
		for _, observer := range nativeEventEvicted {
			observer(e, session, removed.row)
		}
	}
	if e.durable {
		if err := appendEventArchive(session, wireRow+"\n"); err != nil {
			e.storageError = err
		}
	}
	durable := e.durable
	e.Unlock()
	if !durable {
		for _, observer := range nativeTerminalObserved {
			observer(method, params)
		}
	}
}

func (e *nativeEvents) pendingInteractions() []object {
	e.Lock()
	defer e.Unlock()
	requests := make([]object, 0, len(e.pending))
	for _, key := range slices.Sorted(maps.Keys(e.pending)) {
		row := clone(e.pending[key])
		settled := func(value string) bool {
			return slices.Contains([]string{"completed", "failed", "cancelled", "interrupted"}, value)
		}
		if timeline := e.taskTimelines[text(row["params"], "threadId")]; timeline != nil && !settled(text(row, "turnStatus")) {
			if status := timeline.turnStatus(text(row["params"], "turnId")); status != "" {
				row["turnStatus"] = status
			}
		}
		if nativeTurnStatus != nil && !settled(text(row, "turnStatus")) {
			if next := nativeTurnStatus(text(row["params"], "threadId"), text(row["params"], "turnId")); next != "" {
				row["turnStatus"] = next
			}
		}
		row["stale"] = settled(text(row, "turnStatus"))
		if row["stale"] == true && row["method"] == "request_user_input_async" {
			if next := obj(row["next"]); next != nil {
				next["hint"] = "The originating turn has ended. Supply result: {answer: <chosen option or free text>} only to deliver a late answer to the active turn or start a new turn."
			}
		}
		requests = append(requests, row)
	}
	return requests
}

func (e *nativeEvents) feed(session string, args object) object {
	e.Lock()
	defer e.Unlock()
	after := uintOr(args["after"], 0)
	limit := min(uintOr(args["limit"], 100), 2000)
	since := e.sequence + 1
	if len(e.rows) > 0 {
		since = uintOr(e.rows[0].row["cursor"], 0)
	}
	rows := make([]object, 0, limit)
	for _, event := range e.rows {
		if uint64(len(rows)) < limit && uintOr(event.row["cursor"], 0) > after {
			rows = append(rows, clone(event.row))
		}
	}
	provided, hasSession := args["backendSession"]
	return object{"backendSession": session, "reset": hasSession && provided != session, "gap": since > 0 && after < since-1,
		"events": rows, "latestCursor": e.sequence, "retention": "memory-window", "historyOp": "codex_read"}
}

func (e *nativeEvents) countPending() int {
	e.Lock()
	defer e.Unlock()
	return len(e.pending)
}

func (e *nativeEvents) rpcObserver() rpcObserver {
	return rpcObserver{
		event: func(c *rpcConnection, method string, params any) { e.observe(c.session, method, params) },
		pending: func(c *rpcConnection, key string, row object) {
			for _, observer := range nativeInteractionObserved {
				observer(c, row)
			}
			e.Lock()
			defer e.Unlock()
			if e.pending == nil {
				e.pending = make(map[string]object)
			}
			e.pending[key] = row
		},
		resolved: func(_ *rpcConnection, key string) {
			e.Lock()
			defer e.Unlock()
			delete(e.pending, key)
		},
		subscription: func(_ *rpcConnection, thread string, resumed bool) {
			if thread == "" {
				return
			}
			e.Lock()
			defer e.Unlock()
			timeline := e.taskTrackingTimeline(thread)
			timeline.Unsubscribed = !resumed
			if resumed {
				timeline.ObservationLost = false
				timeline.HistoryLoaded = false
			} else {
				timeline.loseObservation()
			}
			e.signal()
		},
		disconnected: func(c *rpcConnection) {
			e.Lock()
			maps.DeleteFunc(e.pending, func(_ string, row object) bool {
				return row["owner"] != "desktop" && row["connection"] == c.connection
			})
			for _, timeline := range e.taskTimelines {
				timeline.loseObservation()
			}
			e.signal()
			e.Unlock()
			for _, observe := range nativeRPCDisconnected {
				observe(c)
			}
		},
	}
}

func init() {
	registerOperation("codex_events", func(_ context.Context, r operationRequest) (any, error) {
		return r.service.events.feed(text(r.service.metadata, "instance"), r.args), nil
	}, nil)
}
