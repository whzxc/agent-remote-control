package core

import (
	"context"
	"errors"
	"fmt"
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

func deviceBindingArguments(op string, args object) (any, error) {
	if !deviceDispatchOp(op) {
		return nil, nil
	}
	if notify, exists := args["notify"]; exists {
		schema := obj(field(field(operation(op), "inputSchema"), "properties"))["notify"]
		if obj(schema) == nil {
			return nil, fmt.Errorf("INVALID_ARGUMENT: %s does not accept notify; query guide for this op.", op)
		}
		if invalid := checkSchema("device-notify", op, "notify", schema, notify); invalid != nil {
			return nil, errors.New(wire(invalid))
		}
	}
	args = clone(args)
	if err := normalizeNotification(args); err != nil {
		return nil, err
	}
	binding := object{"agent": args["agent"], "title": dispatchTitle(args), "purpose": args["purpose"], "previousTurnId": args["turnId"]}
	if notify, exists := args["notify"]; exists {
		binding["notify"] = notify
	}
	return binding, nil
}

func (c *deviceController) bindForwardResult(ctx context.Context, m *deviceMember, request string, value any) error {
	c.recordsMu.Lock()
	row := c.records.forward(request)
	var ticket deviceForwardRecord
	if row != nil {
		ticket = *row
	}
	c.recordsMu.Unlock()
	if ticket.DeviceID != m.peer.DeviceID || ticket.Notification == nil {
		return nil
	}
	result := clone(obj(value))
	if result == nil {
		return nil
	}
	result["requestId"] = request
	bound, err := bindNotificationDevice(ctx, ticket.DeviceID, m.peer.Name, ticket.SourceID, ticket.Op, obj(ticket.Notification), result)
	if err != nil || !bound {
		return err
	}
	return c.changeRecords(func(records *deviceRecords) {
		if row := records.forward(request); row != nil && row.DeviceID == ticket.DeviceID {
			row.Notification = nil
		}
	})
}

func (c *deviceController) peerEventRequest(ctx context.Context, m *deviceMember, op string, args object) (any, error) {
	m.mu.RLock()
	online, path := m.status.online, m.status.path
	m.mu.RUnlock()
	if !online {
		return nil, deviceOffline()
	}
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	default:
		return nil, errors.New("DEVICE_BUSY: Member request capacity reached; wait for an active request.")
	}
	wait, cancel := context.WithTimeout(ctx, 23*time.Second)
	defer cancel()
	prepared, err := c.prepare(wait, m, path)
	if err != nil {
		return nil, err
	}
	payload := object{"version": deviceProtocolVersion, "tool": "query", "body": object{"op": op, "args": args}, "origin": object{}}
	response, err := prepared.send(wait, payload, 23*time.Second)
	if err != nil {
		return nil, err
	}
	value, err := egressToolValue(response)
	if err != nil {
		return nil, err
	}
	if field(response, "isError") == true {
		return nil, errors.New(wire(value))
	}
	return value, nil
}

func (c *deviceController) receivePeerEvent(ctx context.Context, member *deviceMember, event object) error {
	device := member.peer.DeviceID
	task := text(event, "threadId")
	if task == "" {
		task = text(event, "taskId")
	}
	exists, err := hasNotificationDeviceBinding(device, task, text(event, "turnId"))
	if err != nil {
		return err
	}
	if !exists {
		request := text(event["causedBy"], "requestId")
		if err := c.changeRecords(func(records *deviceRecords) {
			records.associateReceipt(device, request, event)
		}); err != nil {
			return err
		}
		if err := c.bindForwardResult(ctx, member, request, event); err != nil {
			return err
		}
	}
	c.recordsMu.Lock()
	source, known := c.records.taskSource(device, task)
	c.recordsMu.Unlock()
	if known {
		return receiveNotificationDeviceEvent(ctx, c.service, device, source, event)
	}
	return nil
}

func (c *deviceController) reconcilePeerEvents(ctx context.Context, member *deviceMember) error {
	device := member.peer.DeviceID
	bindings, err := openNotificationDeviceBindings(device)
	if err != nil {
		return err
	}
	for _, value := range bindings {
		member.mu.RLock()
		online := member.status.online
		member.mu.RUnlock()
		if !online {
			break
		}
		row := obj(value)
		c.recordsMu.Lock()
		source, known := c.records.taskSource(device, text(row, "taskId"))
		c.recordsMu.Unlock()
		if !known || source != row["sourceId"] {
			continue
		}
		status, err := c.peerEventRequest(ctx, member, text(row, "op"), obj(row["args"]))
		if err != nil {
			if err := markNotificationDeviceUnavailable(device, row); err != nil {
				return err
			}
			continue
		}
		if err := reconcileNotificationDevice(ctx, c.service, device, source, row, obj(status)); err != nil {
			return err
		}
	}
	return nil
}

func (c *deviceController) pollPeerEvents(ctx context.Context, member *deviceMember) {
	var epoch, cursor any
	unavailable := false
	device := member.peer.DeviceID
	unavailableStatus := func() {
		if !unavailable {
			_ = markNotificationDeviceUnavailable(device, nil)
			unavailable = true
		}
	}
	for ctx.Err() == nil {
		member.mu.RLock()
		online, changed := member.status.online, member.changed
		member.mu.RUnlock()
		if !online {
			unavailableStatus()
			cursor = nil
			select {
			case <-ctx.Done():
				return
			case <-changed:
				continue
			}
		}
		wait := 0
		if cursor != nil {
			wait = devicePeerEventWaitMS
		}
		result, err := c.peerEventRequest(ctx, member, devicePeerTaskEvents, object{"cursor": cursor, "epoch": epoch, "waitMs": wait})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			recordLog("WARN", "Member events: "+err.Error(), nil)
			unavailableStatus()
			cursor = nil
			timer := time.NewTimer(2 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				continue
			}
		}
		unavailable = false
		if cursor == nil || field(result, "gap") == true || field(result, "epoch") != epoch {
			if err := c.reconcilePeerEvents(ctx, member); err != nil {
				recordLog("WARN", err.Error(), nil)
			}
		}
		failed := false
		for _, row := range arr(field(result, "events")) {
			if err := c.receivePeerEvent(ctx, member, obj(field(row, "event"))); err != nil {
				recordLog("WARN", err.Error(), nil)
				failed = true
			}
		}
		epoch, cursor = field(result, "epoch"), field(result, "cursor")
		if failed {
			cursor = nil
		}
	}
}

func init() {
	notificationObservePeer = func(source string, event object) { peerEvents.publish(source, event) }
	deviceNotificationBinding = deviceBindingArguments
	deviceAcknowledgeRead = func(_ context.Context, device, source, op string, args object, value any) error {
		return acknowledgeNotificationDeviceRead(device, source, op, args, obj(value))
	}
}
