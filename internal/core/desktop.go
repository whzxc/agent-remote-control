package core

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const desktopFrameBytes = 256 << 20
const desktopSnapshotBytes = 32 << 20
const desktopSnapshotTTL = 4 * time.Second

type desktopNativeSnapshot struct {
	at       time.Time
	owner    string
	revision uint64
	state    object
	err      error
	bytes    int
}

type desktopPending struct {
	result chan rpcResult
	target string
	method string
	at     time.Time
}

type nativeDesktopIPC struct {
	stream           net.Conn
	events           *nativeEvents
	session, client  string
	alive            atomic.Bool
	writeMu          sync.Mutex
	mu               sync.Mutex
	owners           map[string]string
	pending          map[string]desktopPending
	snapshots        map[string]desktopNativeSnapshot
	revisions        map[string]desktopNativeSnapshot
	evictions, bytes int
	wake             chan struct{}
	done             chan struct{}
	maintenanceDone  chan struct{}
}

func newDesktopIPC(ctx context.Context, home, session string, events *nativeEvents) (*nativeDesktopIPC, error) {
	dial, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	stream, err := connectNativeDesktop(dial, home)
	if err != nil {
		return nil, err
	}
	return initializeDesktopIPC(ctx, stream, session, events)
}

func initializeDesktopIPC(ctx context.Context, stream net.Conn, session string, events *nativeEvents) (*nativeDesktopIPC, error) {
	d := &nativeDesktopIPC{stream: stream, events: events, session: session,
		owners: map[string]string{}, pending: map[string]desktopPending{}, snapshots: map[string]desktopNativeSnapshot{},
		revisions: map[string]desktopNativeSnapshot{}, wake: make(chan struct{}), done: make(chan struct{}), maintenanceDone: make(chan struct{})}
	d.alive.Store(true)
	go d.run()
	go d.maintainSnapshots()
	response, err := d.request(ctx, "initialize", object{"clientType": "agent-remote-control"}, "")
	if err != nil {
		d.close()
		return nil, err
	}
	d.client = text(response["result"], "clientId")
	return d, nil
}

func (d *nativeDesktopIPC) signal() {
	close(d.wake)
	d.wake = make(chan struct{})
}

func (d *nativeDesktopIPC) close() {
	_ = d.stream.Close()
	<-d.done
	<-d.maintenanceDone
}

func (d *nativeDesktopIPC) write(ctx context.Context, value object) error {
	data := []byte(wire(value))
	if len(data) > desktopFrameBytes {
		return errors.New("FRAME_TOO_LARGE")
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if !d.alive.Load() {
		return errors.New("DESKTOP_DISCONNECTED")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline, exists := ctx.Deadline()
	if !exists {
		deadline = time.Now().Add(30 * time.Second)
	}
	_ = d.stream.SetWriteDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = d.stream.Close() })
	defer stop()
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(data)))
	if _, err := d.stream.Write(header[:]); err != nil {
		_ = d.stream.Close()
		return err
	}
	if _, err := d.stream.Write(data); err != nil {
		_ = d.stream.Close()
		return err
	}
	return nil
}

func (d *nativeDesktopIPC) run() {
	defer close(d.done)
	defer d.stream.Close()
	defer func() {
		d.alive.Store(false)
		d.mu.Lock()
		for _, pending := range d.pending {
			pending.result <- rpcResult{err: errors.New("DESKTOP_DISCONNECTED")}
		}
		clear(d.pending)
		clear(d.owners)
		clear(d.snapshots)
		d.bytes = 0
		d.signal()
		d.mu.Unlock()
		d.events.Lock()
		for key, request := range d.events.pending {
			if request["owner"] == "desktop" && request["backendSession"] == d.session {
				delete(d.events.pending, key)
			}
		}
		d.events.signal()
		d.events.Unlock()
	}()
	for {
		var header [4]byte
		if _, err := io.ReadFull(d.stream, header[:]); err != nil {
			return
		}
		length := binary.LittleEndian.Uint32(header[:])
		if length == 0 || length > desktopFrameBytes {
			return
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(d.stream, body); err != nil {
			return
		}
		finish := beginRuntimeWork("desktopFrame")
		var msg object
		if decodeObject(body, &msg) == nil {
			switch msg["type"] {
			case "client-discovery-request":
				if err := d.write(context.Background(), object{"type": "client-discovery-response", "requestId": msg["requestId"],
					"response": object{"canHandle": false}}); err != nil {
					finish()
					return
				}
			case "response":
				d.response(msg)
			case "broadcast":
				if msg["method"] == "ipc-connection-reset" {
					finish()
					return
				}
				if msg["method"] == "thread-stream-state-changed" {
					d.observe(msg, int(length))
				}
			}
		}
		finish()
	}
}

func (d *nativeDesktopIPC) response(message object) {
	d.mu.Lock()
	key := text(message, "requestId")
	pending, ok := d.pending[key]
	delete(d.pending, key)
	d.mu.Unlock()
	if !ok {
		return
	}
	response := rpcResult{value: message}
	switch {
	case message["resultType"] == "error":
		response.err = errors.New("DESKTOP_REJECTED:" + wire(message["error"]))
	case pending.target != "" && pending.target != text(message, "handledByClientId"):
		response.err = errors.New("DESKTOP_RESPONSE_OWNER_MISMATCH")
	}
	pending.result <- response
}

func (d *nativeDesktopIPC) removeSnapshot(thread string) {
	d.bytes -= d.snapshots[thread].bytes
	delete(d.snapshots, thread)
}

func (d *nativeDesktopIPC) maintainSnapshots() {
	defer close(d.maintenanceDone)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-d.done:
			return
		case <-tick.C:
			d.mu.Lock()
			d.pruneSnapshots()
			d.mu.Unlock()
		}
	}
}

func (d *nativeDesktopIPC) diagnostics() object {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.pruneSnapshots()
	aggregated := map[string]struct {
		count  int
		key    string
		oldest time.Time
	}{}
	for key, pending := range d.pending {
		row := aggregated[pending.method]
		row.count++
		if row.oldest.IsZero() || pending.at.Before(row.oldest) {
			row.key, row.oldest = key, pending.at
		}
		aggregated[pending.method] = row
	}
	requests := []object{}
	for _, method := range slices.Sorted(maps.Keys(aggregated)) {
		row := aggregated[method]
		requests = append(requests, object{"method": method, "count": row.count, "oldestRequestId": row.key, "oldestAgeMs": time.Since(row.oldest).Milliseconds()})
	}
	return object{"connected": d.alive.Load(), "pendingRequests": len(d.pending), "requests": requests, "owners": len(d.owners),
		"snapshots": object{"entries": len(d.snapshots), "wireBytes": d.bytes, "budgetWireBytes": desktopSnapshotBytes,
			"maxEntries": 64, "ttlMs": desktopSnapshotTTL.Milliseconds(), "evictions": d.evictions, "oversizedEntry": d.bytes > desktopSnapshotBytes}}
}

func (d *nativeDesktopIPC) pruneSnapshots() {
	cost := runtimeCosts.counter("desktopSnapshots")
	cost.rows.Add(uint64(len(d.snapshots)))
	cost.scanSet.Add(uint64(len(d.snapshots)))
	for thread, snapshot := range d.snapshots {
		if time.Since(snapshot.at) >= desktopSnapshotTTL {
			d.removeSnapshot(thread)
			d.evictions++
		}
	}
}

func (d *nativeDesktopIPC) rememberSnapshot(thread string, snapshot desktopNativeSnapshot) {
	d.pruneSnapshots()
	d.removeSnapshot(thread)
	for len(d.snapshots) > 0 && (d.bytes+snapshot.bytes > desktopSnapshotBytes || len(d.snapshots) >= 64) {
		oldest := time.Now()
		var key string
		for thread, prior := range d.snapshots {
			if !prior.at.After(oldest) {
				oldest, key = prior.at, thread
			}
		}
		d.removeSnapshot(key)
		d.evictions++
	}
	d.snapshots[thread] = snapshot
	d.bytes += snapshot.bytes
}

func (d *nativeDesktopIPC) observe(msg object, length int) {
	params := obj(msg["params"])
	thread, owner := text(params, "conversationId"), text(msg, "sourceClientId")
	if params["hostId"] != "local" || thread == "" || owner == "" {
		return
	}
	d.mu.Lock()
	if d.owners[thread] != owner {
		d.mu.Unlock()
		return
	}
	change := obj(params["change"])
	state := obj(change["conversationState"])
	revision, revisionOK := uintValue(change["revision"])
	version, versionOK := uintValue(msg["version"])
	isSnapshot := change["type"] == "snapshot"
	captured := desktopNativeSnapshot{at: time.Now(), owner: owner, revision: revision, state: state, bytes: length}
	switch {
	case !versionOK || version != 11 && version != 13:
		var reported any
		label := "unknown"
		if versionOK {
			reported, label = version, fmt.Sprint(version)
		}
		captured.err = dispatchObjectError(object{"code": "DESKTOP_SNAPSHOT_VERSION_UNSUPPORTED",
			"message": "Codex Desktop sent snapshot protocol version " + label + ". This ARC build supports versions 11 and 13. Update ARC to a build that supports your Codex Desktop version.",
			"version": reported, "supportedVersions": []int{11, 13}, "retryable": false})
	case !revisionOK || isSnapshot && state["id"] != thread:
		captured.err = dispatchObjectError(object{"code": "DESKTOP_SNAPSHOT_INVALID", "message": "Codex Desktop sent an invalid thread state update. Check that ARC supports this Codex Desktop build.", "retryable": false})
	}
	if captured.err != nil {
		captured.state, captured.bytes = nil, len(captured.err.Error())
		delete(d.revisions, thread)
		d.rememberSnapshot(thread, captured)
		d.signal()
		d.mu.Unlock()
		return
	}
	previous := d.revisions[thread]
	repeated := isSnapshot && previous.owner == owner && previous.revision == revision && previous.bytes != 0
	if isSnapshot {
		if existing := d.snapshots[thread]; repeated && existing.state != nil {
			existing.at = captured.at
			d.snapshots[thread] = existing
		} else {
			d.syncInteractions(state)
			d.rememberSnapshot(thread, captured)
		}
	} else {
		d.removeSnapshot(thread)
	}
	if len(d.revisions) >= 2000 {
		clear(d.revisions)
	}
	captured.state, captured.err = nil, nil
	if !isSnapshot {
		captured.bytes = 0
	}
	d.revisions[thread] = captured
	d.signal()
	d.mu.Unlock()
	if repeated {
		return
	}
	params["ownerClientId"] = owner
	d.events.observe(d.session, "desktop/thread-stream-state-changed", params)
}

func desktopVersion(method string, targeted bool) int {
	base := 0
	switch method {
	case "thread-owner-discovery", "thread-stream-following-changed", "thread-follower-steer-turn",
		"thread-follower-load-complete-history", "thread-follower-command-approval-decision",
		"thread-follower-file-approval-decision", "thread-follower-permissions-request-approval-response",
		"thread-follower-submit-user-input", "thread-follower-submit-mcp-server-elicitation-response":
		base = 1
	case "thread-follower-start-turn", "thread-follower-update-thread-settings":
		base = 2
	case "thread-follower-interrupt-turn":
		base = 4
	}
	if targeted && strings.HasPrefix(method, "thread-follower-") {
		base++
	}
	return base
}

func (d *nativeDesktopIPC) request(ctx context.Context, method string, params object, target string) (object, error) {
	duration := 30 * time.Second
	if method == "thread-owner-discovery" {
		duration = time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	key := id()
	result := make(chan rpcResult, 1)
	d.mu.Lock()
	if !d.alive.Load() {
		d.mu.Unlock()
		return nil, errors.New("DESKTOP_DISCONNECTED")
	}
	d.pending[key] = desktopPending{result, target, method, time.Now()}
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.pending, key)
		d.mu.Unlock()
	}()
	msg := object{"type": "request", "requestId": key, "sourceClientId": d.client, "method": method, "version": desktopVersion(method, target != ""), "params": params}
	if target != "" {
		msg["targetClientId"], msg["hostId"] = target, "local"
	}
	err := d.write(ctx, msg)
	var value object
	if err == nil {
		select {
		case reply := <-result:
			value, err = obj(reply.value), reply.err
		case <-ctx.Done():
			err = ctx.Err()
		}
	}
	if err == nil {
		return value, nil
	}
	if ctx.Err() != nil {
		err = errors.New("DESKTOP_REQUEST_TIMEOUT: " + method)
	}
	sentMutation := slices.Contains([]string{"thread-follower-start-turn", "thread-follower-steer-turn", "thread-follower-interrupt-turn",
		"thread-follower-command-approval-decision", "thread-follower-file-approval-decision", "thread-follower-permissions-request-approval-response",
		"thread-follower-submit-user-input", "thread-follower-submit-mcp-server-elicitation-response"}, method)
	if sentMutation && !strings.HasPrefix(err.Error(), "DESKTOP_REJECTED") && err.Error() != "DESKTOP_RESPONSE_OWNER_MISMATCH" {
		return nil, fmt.Errorf("SUBMISSION_UNCONFIRMED: %w", err)
	}
	return nil, err
}

func (d *nativeDesktopIPC) owner(ctx context.Context, thread string) (string, error) {
	response, err := d.request(ctx, "thread-owner-discovery", object{"hostId": "local", "conversationId": thread}, "")
	if err != nil {
		return "", err
	}
	owner := text(response, "handledByClientId")
	if owner == "" {
		return "", errors.New("DESKTOP_OWNER_NOT_FOUND")
	}
	d.mu.Lock()
	if previous := d.owners[thread]; previous != "" && previous != owner {
		d.removeSnapshot(thread)
		delete(d.revisions, thread)
	}
	d.owners[thread] = owner
	d.mu.Unlock()
	return owner, nil
}

func (d *nativeDesktopIPC) follow(ctx context.Context, thread, owner string) error {
	return d.write(ctx, object{"type": "broadcast", "sourceClientId": d.client, "targetClientIds": []string{owner},
		"method": "thread-stream-following-changed", "version": 1, "params": object{"hostId": "local", "conversationId": thread, "following": true}})
}

func (d *nativeDesktopIPC) wait(ctx context.Context, thread string, minRevision uint64) (object, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		d.mu.Lock()
		if !d.alive.Load() {
			d.mu.Unlock()
			return nil, errors.New("DESKTOP_DISCONNECTED")
		}
		snapshot, ok := d.snapshots[thread]
		wake := d.wake
		d.mu.Unlock()
		if ok && time.Since(snapshot.at) < desktopSnapshotTTL && (snapshot.err != nil || snapshot.revision >= minRevision) {
			return snapshot.state, snapshot.err
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return nil, errors.New("DESKTOP_SNAPSHOT_TIMEOUT")
		}
	}
}

func (d *nativeDesktopIPC) snapshot(thread string) object {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.pruneSnapshots()
	return d.snapshots[thread].state
}

func (d *nativeDesktopIPC) readOwned(ctx context.Context, thread string, complete bool, owner string) (object, error) {
	state := d.snapshot(thread)
	if state == nil {
		if err := d.follow(ctx, thread, owner); err != nil {
			return nil, err
		}
		var err error
		state, err = d.wait(ctx, thread, 0)
		if err != nil {
			return nil, err
		}
	}
	if complete && field(field(state["turnHistory"], "history"), "isComplete") != true {
		reply, err := d.request(ctx, "thread-follower-load-complete-history", object{"conversationId": thread}, owner)
		if err != nil {
			return nil, err
		}
		revision, ok := uintValue(field(reply["result"], "revision"))
		if !ok {
			return nil, errors.New("DESKTOP_HISTORY_INCOMPLETE")
		}
		state, err = d.wait(ctx, thread, revision)
		if err != nil {
			return nil, err
		}
	}
	state = clone(state)
	if applyAcceptanceSnapshot != nil {
		state = applyAcceptanceSnapshot(thread, state)
	}
	return state, nil
}

func (d *nativeDesktopIPC) read(ctx context.Context, thread string, complete bool) (object, error) {
	if state := d.snapshot(thread); state != nil && (!complete || field(field(state["turnHistory"], "history"), "isComplete") == true) {
		state = clone(state)
		if applyAcceptanceSnapshot != nil {
			state = applyAcceptanceSnapshot(thread, state)
		}
		return state, nil
	}
	owner, err := d.owner(ctx, thread)
	if err != nil {
		return nil, err
	}
	return d.readOwned(ctx, thread, complete, owner)
}

func nativeDesktopTurns(state object) ([]any, error) {
	history := obj(field(state["turnHistory"], "history"))
	if field(state["turnHistory"], "kind") != "canonical" || history["isComplete"] != true {
		return nil, errors.New("DESKTOP_HISTORY_INCOMPLETE")
	}
	turns := []any{}
	seen := map[string]bool{}
	for _, island := range arr(history["islands"]) {
		for _, entry := range arr(field(island, "entries")) {
			turn := obj(field(history["entitiesByKey"], text(entry, "value")))
			if id, ok := turn["turnId"].(string); ok && !seen[id] {
				seen[id] = true
				turn = maps.Clone(turn)
				turn["id"] = id
				turns = append(turns, turn)
			}
		}
	}
	return turns, nil
}

func nativeDesktopEndpointError(endpoint string, err error) error {
	code := "DESKTOP_IPC_CONNECT_FAILED"
	if errors.Is(err, os.ErrNotExist) {
		code = "DESKTOP_IPC_ENDPOINT_MISSING"
	}
	return dispatchObjectError(object{"code": code, "message": "Codex Desktop IPC endpoint " + endpoint + ": " + err.Error(),
		"endpoint": endpoint, "retryable": false, "next": object{"via": "query", "op": "guide", "args": object{"op": "codex_send"},
			"hint": "Read the current Desktop/App Server routing contract. Inspect the original receipt before retrying; ARC falls back only before submission when no Desktop owner is confirmed."}})
}

func desktopMissingEndpoint(err error) bool {
	return err != nil && controlFailure(err)["code"] == "DESKTOP_IPC_ENDPOINT_MISSING"
}

func desktopMissingOwner(err error) bool {
	return err != nil && (err.Error() == "DESKTOP_OWNER_NOT_FOUND" || err.Error() == "DESKTOP_REJECTED:\"no-client-found\"")
}

func desktopDiscoveryPending(err error) bool {
	return desktopMissingOwner(err) || err != nil && err.Error() == "DESKTOP_REQUEST_TIMEOUT: thread-owner-discovery"
}
