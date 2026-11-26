package core

import (
	"context"
	"errors"
	"sync"
	"time"
)

const devicePeerTaskEvents = "peer_task_events"
const devicePeerEventCap = 256
const devicePeerEventBatch = 60
const devicePeerEventBytes = 65536
const devicePeerEventWaitMS = 15000

type deviceEventQueue struct {
	mu              sync.Mutex
	source, epoch   string
	cursor, dropped uint64
	rows            []object
	wake            chan struct{}
}

var peerEvents deviceEventQueue

func (queue *deviceEventQueue) selectSource(source string) {
	if queue.epoch == "" {
		queue.epoch = id()
		queue.wake = make(chan struct{})
	}
	if queue.source != source {
		queue.source = source
		queue.cursor, queue.dropped = 0, 0
		queue.rows = nil
	}
}

func (queue *deviceEventQueue) publish(source string, event any) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	queue.selectSource(source)
	queue.cursor++
	if len(wire(event)) > devicePeerEventBytes {
		queue.rows = nil
		queue.dropped = queue.cursor
	} else {
		if len(queue.rows) == devicePeerEventCap {
			queue.dropped = uintOr(queue.rows[0]["cursor"], 0)
			queue.rows = queue.rows[1:]
		}
		queue.rows = append(queue.rows, object{"cursor": queue.cursor, "event": event})
	}
	close(queue.wake)
	queue.wake = make(chan struct{})
}

func (queue *deviceEventQueue) read(ctx context.Context, source string, args object) (object, error) {
	cursor, hasCursor := uintValue(args["cursor"])
	epoch, hasEpoch := args["epoch"].(string)
	wait, hasWait := uintValue(args["waitMs"])
	_, waitPresent := args["waitMs"]
	if args["cursor"] != nil && !hasCursor || args["epoch"] != nil && !hasEpoch ||
		waitPresent && !hasWait || wait > devicePeerEventWaitMS {
		return nil, errors.New("INVALID_ARGUMENT: peer_task_events expects cursor:uint|null, epoch:string and waitMs <= 15000")
	}
	timer := time.NewTimer(time.Duration(wait) * time.Millisecond)
	defer timer.Stop()
	for {
		queue.mu.Lock()
		queue.selectSource(source)
		wake := queue.wake
		gap := hasCursor && (cursor < queue.dropped || cursor > queue.cursor || epoch != queue.epoch)
		rows := []object{}
		next := queue.cursor
		if hasCursor && !gap {
			for _, row := range queue.rows {
				if current := uintOr(row["cursor"], 0); current > cursor {
					next = current
					rows = append(rows, row)
					if len(rows) == devicePeerEventBatch {
						break
					}
				}
			}
		}
		result := object{"epoch": queue.epoch, "cursor": next, "gap": gap, "events": rows}
		queue.mu.Unlock()
		if gap || !hasCursor || len(rows) != 0 || wait == 0 {
			return result, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return result, nil
		case <-wake:
		}
	}
}

func deviceDispatchOp(op string) bool {
	switch op {
	case "codex_create", "codex_send", "codex_resume", "agent_create", "agent_send":
		return true
	default:
		return false
	}
}
