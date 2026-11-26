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

	"github.com/google/uuid"
)

type deviceMemberStatus struct {
	online            bool
	path              string
	lastSeen, latency any
	hello             object
	failure           any
}

type deviceMember struct {
	peer                devicePeer
	identity            *deviceIdentity
	ctx                 context.Context
	cancel              context.CancelFunc
	done                chan struct{}
	mu                  sync.RWMutex
	changed             chan struct{}
	status              deviceMemberStatus
	business, heartbeat deviceSession
	tunnel              deviceTunnelClient
	slots               chan struct{}
}

func (member *deviceMember) signalStatus() {
	close(member.changed)
	member.changed = make(chan struct{})
}

func (member *deviceMember) stop() {
	member.cancel()
	<-member.done
	member.business.close()
	member.heartbeat.close()
	member.tunnel.clear()
}

type deviceController struct {
	ctx                context.Context
	service            *service
	directory          string
	mu                 sync.Mutex
	members            map[string]*deviceMember
	identity           *deviceIdentity
	transfers          deviceReceiverStore
	discoveryMu        sync.Mutex
	discovered         map[string]deviceResolution
	pairedDiscoveryIDs sync.Map
	transferJobs       sync.Map
	recordsMu          sync.Mutex
	records            deviceRecords
}

var deviceControllers sync.Map // *service -> *deviceController

func startDeviceController(ctx context.Context, s *service) error {
	directory := filepath.Join(root(), "device-link")
	records, err := openDeviceRecords(directory)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	c := &deviceController{ctx: ctx, service: s, directory: directory, members: map[string]*deviceMember{}, records: records, discovered: make(map[string]deviceResolution)}
	deviceControllers.Store(s, c)
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if err := c.sync(); err != nil {
					recordLog("WARN", err.Error(), nil)
				}
			}
		}
	}()
	discoveryDone := make(chan struct{})
	go func() {
		defer close(discoveryDone)
		c.discoveryLoop(ctx)
	}()
	s.cleanup = append(s.cleanup, func() {
		cancel()
		<-done
		<-discoveryDone
		c.mu.Lock()
		c.stopLocked()
		c.mu.Unlock()
		c.transferJobs.Range(func(_, value any) bool {
			job := value.(*deviceTransferJob)
			job.cancel()
			<-job.done
			return true
		})
		c.transfers.close()
		deviceControllers.Delete(s)
	})
	return nil
}

func (c *deviceController) stopLocked() {
	current := c.members
	c.members = make(map[string]*deviceMember)
	c.identity = nil
	c.pairedDiscoveryIDs.Clear()
	c.discoveryMu.Lock()
	clear(c.discovered)
	c.discoveryMu.Unlock()
	for _, member := range current {
		member.stop()
	}
}

func (c *deviceController) sync() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil || !deviceEnabled() {
		c.stopLocked()
		return c.ctx.Err()
	}
	stored, err := loadDeviceStored(c.directory)
	if err != nil {
		return err
	}
	if stored.IdentityID == nil {
		return nil
	}
	if c.identity == nil || c.identity.id != *stored.IdentityID {
		c.stopLocked()
		// The gateway owns identity creation and publishes the ID in peers.json.
		if _, err := os.Stat(filepath.Join(c.directory, "identity.json")); err != nil {
			return err
		}
		identity, err := loadDeviceIdentity(c.directory)
		if err != nil {
			return err
		}
		if identity.id != *stored.IdentityID {
			return errors.New("DEVICE_UNPAIRED: Local device identity changed; query devices.")
		}
		c.identity = identity
	}
	for id, current := range c.members {
		next, exists := stored.Members[id]
		if !exists || next.PublicKey != current.peer.PublicKey || next.Name != current.peer.Name ||
			deviceOptionalString(next.AddressOverride) != deviceOptionalString(current.peer.AddressOverride) {
			current.stop()
			delete(c.members, id)
			c.pairedDiscoveryIDs.Delete(id)
		}
	}
	for id, peer := range stored.Members {
		if c.members[id] != nil {
			continue
		}
		ctx, cancel := context.WithCancel(c.ctx)
		c.recordsMu.Lock()
		status := deviceMemberStatus{hello: c.records.Facts[id]}
		if last := c.records.LastSeen[id]; last != "" {
			status.lastSeen = last
		}
		c.recordsMu.Unlock()
		member := &deviceMember{peer: peer, identity: c.identity, ctx: ctx, cancel: cancel, done: make(chan struct{}), changed: make(chan struct{}), status: status, slots: make(chan struct{}, 64)}
		c.members[id] = member
		c.pairedDiscoveryIDs.Store(id, struct{}{})
		go func() {
			defer close(member.done)
			var workers sync.WaitGroup
			workers.Go(func() { c.monitor(ctx, member) })
			workers.Go(func() { c.pollPeerEvents(ctx, member) })
			workers.Wait()
		}()
	}
	return nil
}

func deviceOptionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (c *deviceController) changeRecords(change func(*deviceRecords)) error {
	c.recordsMu.Lock()
	defer c.recordsMu.Unlock()
	next := c.records.clone()
	change(&next)
	if err := next.save(c.directory); err != nil {
		return err
	}
	c.records = next
	return nil
}

func serviceDeviceController(s *service) (*deviceController, error) {
	if !deviceEnabled() {
		return nil, errors.New(deviceUnavailableMessage)
	}
	state, ok := deviceControllers.Load(s)
	if !ok {
		return nil, errors.New(deviceUnavailableMessage)
	}
	c := state.(*deviceController)
	return c, c.sync()
}

func (c *deviceController) member(selector string) (*deviceMember, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if member := c.members[selector]; member != nil {
		return member, nil
	}
	var match *deviceMember
	for _, member := range c.members {
		if member.peer.Name == selector {
			if match != nil {
				match = nil
				break
			}
			match = member
		}
	}
	if match != nil {
		return match, nil
	}
	state, err := loadDeviceStored(c.directory)
	if err != nil {
		return nil, err
	}
	if ctl := state.Controller; ctl != nil && (ctl.DeviceID == selector || ctl.Name == selector) {
		return nil, deviceError("DEVICE_UNPAIRED", "This device is an upstream controller, not a paired member. Pair a direct member locally; query guide with topic:device.", deviceGuideAction())
	}
	return nil, deviceError("DEVICE_UNKNOWN", "Use a device ID or a unique paired name from query devices.",
		object{"via": "query", "op": "devices", "args": object{"all": true}})
}

func (c *deviceController) list(all bool) object {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows := []object{}
	for _, id := range slices.Sorted(maps.Keys(c.members)) {
		member := c.members[id]
		member.mu.RLock()
		status := member.status
		member.mu.RUnlock()
		if !all && !status.online {
			continue
		}
		state, path := "offline", status.path
		if status.online {
			state = "online"
		}
		if path == "" {
			path = "lan"
		}
		rows = append(rows, object{
			"id": id, "name": member.peer.Name, "platform": status.hello["platform"], "arch": status.hello["arch"],
			"arcVersion": status.hello["arcVersion"], "state": state, "path": path, "lastSeen": status.lastSeen,
			"latency": status.latency, "capabilities": status.hello["capabilities"], "error": status.failure,
		})
	}
	return object{"devices": rows}
}

func deviceGuideAction() object {
	return object{"via": "query", "op": "guide", "args": object{"op": "device"}}
}
func deviceListAction() object { return object{"via": "query", "op": "devices", "args": object{}} }

func deviceError(code, message string, next object) error {
	return errors.New(wire(object{"code": code, "message": message, "next": next}))
}

func deviceOffline() error {
	return deviceError("DEVICE_OFFLINE", "Member is offline. Request was not transmitted.", deviceListAction())
}

func deviceUncertain(request, member, message string) error {
	return errors.New(wire(object{"code": "DEVICE_OUTCOME_UNCERTAIN", "state": "unconfirmed", "requestId": request, "message": message, "next": object{
		"via": "act", "op": "device", "args": object{"device": member, "op": "receipt", "args": object{"requestId": request, "action": "read"}},
	}}))
}

func (c *deviceController) admitForward(record deviceForwardRecord) error {
	c.recordsMu.Lock()
	defer c.recordsMu.Unlock()
	if previous := c.records.forward(record.RequestID); previous != nil {
		if previous.SourceID != record.SourceID || previous.DeviceID != record.DeviceID || previous.Op != record.Op || previous.Digest != record.Digest {
			return deviceError("REQUEST_ID_CONFLICT", "This request ID belongs to another forward; read its original receipt.", deviceGuideAction())
		}
		return deviceUncertain(record.RequestID, record.DeviceID, "This write was already sent. Read its member receipt.")
	}
	next := c.records.clone()
	next.record(record)
	if err := next.save(c.directory); err != nil {
		return err
	}
	c.records = next
	return nil
}

var deviceNotificationBinding func(string, object) (any, error)
var deviceAcknowledgeRead func(context.Context, string, string, string, object, any) error

func (c *deviceController) forward(ctx context.Context, tool string, args object, callerRequest any, origin object) (object, error) {
	member, err := c.member(text(args, "device"))
	if err != nil {
		return nil, err
	}
	op := text(args, "op")
	if devicePeerForbidden(op) || op == "peer_task_events" {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: A forwarded request cannot reach Device link or local management; query guide for device.")
	}
	inner := maps.Clone(obj(args["args"]))
	if inner == nil {
		inner = object{}
	}
	var notification any
	if tool == "act" && deviceNotificationBinding != nil {
		notification, err = deviceNotificationBinding(op, inner)
		if err != nil {
			return nil, err
		}
	}
	member.mu.RLock()
	status := member.status
	member.mu.RUnlock()
	if !status.online {
		if strings.Contains(str(status.failure), "DEVICE_PROTOCOL_MISMATCH") {
			return nil, deviceError("DEVICE_PROTOCOL_MISMATCH", "Install matching peer protocol versions.", deviceGuideAction())
		}
		return nil, deviceOffline()
	}
	write := tool == "act" && !(op == "receipt" && (inner["action"] == nil || inner["action"] == "read"))
	request := str(callerRequest)
	if request == "" || op == "receipt" {
		request = text(inner, "requestId")
	}
	if request == "" {
		request = id()
	}
	if write && op != "receipt" && text(inner, "requestId") != "" && text(inner, "requestId") != request {
		return nil, deviceError("REQUEST_ID_CONFLICT", "Outer and inner request IDs must match; retain the original member receipt ID.", deviceGuideAction())
	}
	if write {
		if _, err := uuid.Parse(request); err != nil {
			return nil, errors.New("INVALID_ARGUMENT: requestId must be a UUID")
		}
	}
	select {
	case member.slots <- struct{}{}:
		defer func() { <-member.slots }()
	default:
		return nil, errors.New("DEVICE_BUSY: 64 member requests are already active; read the original receipts or wait for a read to finish.")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(member.ctx, cancel)()
	prepare, cancelPrepare := context.WithTimeout(ctx, 5*time.Second)
	path, err := c.prepare(prepare, member, status.path)
	prepared := prepare.Err()
	cancelPrepare()
	switch {
	case errors.Is(prepared, context.DeadlineExceeded):
		return nil, errors.New("DEVICE_RESPONSE_LOST: Preparing a member path timed out; query devices.")
	case err != nil && managementErrorCode(err.Error()) == "DEVICE_CONNECTION_REFUSED":
		member.mu.Lock()
		member.status.online = false
		member.signalStatus()
		member.mu.Unlock()
		return nil, deviceOffline()
	case err != nil:
		return nil, err
	}
	source, device := text(origin, "sourceId"), member.peer.DeviceID
	payload := maps.Clone(inner)
	delete(payload, "requestId")
	delete(payload, "waitMs")
	digest := hash([]byte(wire([]any{tool, op, payload})))
	if deviceDispatchOp(op) {
		delete(inner, "notify")
	}
	body := object{"op": op, "args": inner}
	if write {
		body["requestId"] = request
	}
	envelope := object{"version": deviceProtocolVersion, "tool": tool, "body": body,
		"origin": object{"sourceId": source, "sourceLabel": origin["sourceLabel"], "controlSource": origin["controlSource"]}}
	if path.tunnelURL != "" && len(wire(envelope)) > deviceTunnelRequestCap {
		return nil, errors.New("DEVICE_TUNNEL_LIMIT: Peer request exceeds 1 MiB; use LAN.")
	}
	if write && op != "receipt" {
		if err := c.admitForward(deviceForwardRecord{
			RequestID: request, DeviceID: device, Op: op, SourceID: source, SentAt: now(), Outcome: "sent", Digest: digest, Notification: notification,
		}); err != nil {
			return nil, err
		}
	}
	result, err := path.send(ctx, envelope, deviceRequestBound(op, inner))
	failure := func(err error) (object, error) {
		if write {
			_ = c.changeRecords(func(records *deviceRecords) {
				if row := records.forward(request); row != nil && row.Outcome == "sent" {
					row.Outcome = "uncertain"
				}
			})
			return nil, deviceUncertain(request, device, err.Error())
		}
		return nil, deviceError("DEVICE_RESPONSE_LOST", err.Error(), deviceListAction())
	}
	if err != nil {
		return failure(err)
	}
	value, err := egressToolValue(result)
	if err != nil {
		return failure(err)
	}
	failed := field(result, "isError") == true
	if err := c.changeRecords(func(records *deviceRecords) {
		if row := records.forward(request); write && row != nil {
			row.Outcome = "completed"
			if failed {
				row.Outcome = "failed"
			}
		}
		if op == "receipt" {
			records.associateReceipt(device, request, value)
		} else if write {
			records.associate(device, source, value)
		}
	}); err != nil {
		return failure(err)
	}
	if !failed {
		if err := c.bindForwardResult(ctx, member, request, value); err != nil {
			return failure(err)
		}
	}
	if !failed && deviceAcknowledgeRead != nil {
		if err := deviceAcknowledgeRead(ctx, device, source, op, obj(args["args"]), value); err != nil {
			return nil, err
		}
	}
	deviceQualifyActions(value, device)
	if fields := obj(value); fields != nil {
		return egressTool(fields, failed), nil
	}
	return obj(result), nil
}

func deviceQualifyActions(value any, device string) {
	switch row := value.(type) {
	case []any:
		for _, item := range row {
			deviceQualifyActions(item, device)
		}
	case object:
		if op, ok := row["op"].(string); ok && (row["via"] == "act" || row["via"] == "query") && obj(row["args"]) != nil {
			row["op"], row["args"] = "device", object{"device": device, "op": op, "args": row["args"]}
			return
		}
		for key, item := range row {
			if !slices.Contains([]string{"input", "output", "arguments", "params", "peerOrigin"}, key) {
				deviceQualifyActions(item, device)
			}
		}
	}
}

func init() {
	registerServiceStartup(startDeviceController)
	remoteDeviceControl = func(ctx context.Context, s *service, source requestSource, tool string, args object, request any) (object, error) {
		c, err := serviceDeviceController(s)
		if err != nil {
			return nil, err
		}
		return c.forward(ctx, tool, args, request, source.origin)
	}
	registerOperation("devices", func(_ context.Context, r operationRequest) (any, error) {
		c, err := serviceDeviceController(r.service)
		if err != nil {
			return nil, err
		}
		return c.list(r.args["all"] == true), nil
	}, deviceOpAvailable)
	registerOperation("device", func(context.Context, operationRequest) (any, error) { return nil, errors.New(deviceUnavailableMessage) }, deviceOpAvailable)
	deviceControllerTasks = func(ctx context.Context, s *service, body object) (any, error) {
		c, err := serviceDeviceController(s)
		if err != nil {
			return nil, err
		}
		if panelControlSource == nil {
			return nil, errors.New(PortPending)
		}
		source, err := panelControlSource(ctx)
		if err != nil {
			return nil, err
		}
		device := text(body, "device")
		response, err := c.forward(ctx, "query", object{"device": device, "op": "task_activity", "args": object{}}, nil, source.origin)
		if err != nil {
			return nil, err
		}
		return readDeviceManagementResult(response, func(args object) (any, error) {
			return c.forward(ctx, "query", object{"device": device, "op": "control_output", "args": args}, nil, source.origin)
		})
	}
}

func deviceOpAvailable(source requestSource) bool {
	return deviceEnabled() && source.origin["controlTransport"] != "peer"
}
