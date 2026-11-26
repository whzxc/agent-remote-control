package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"strings"
)

// The source owner revalidates the active peer credential and touches its origin.
var deviceCorePeerSource func(context.Context, string, string, bool) (requestSource, error)

// The Agent and dispatch owners supply the native task projection and membership.
var deviceCoreTaskVisible func(context.Context, string, string, string) bool
var deviceCoreAgentAvailable func(context.Context, *service, string) bool
var deviceCoreTaskRead func(context.Context, *service, requestSource, string, object) (any, error)

func authorizedDeviceController(ctx context.Context, id string, touch bool) (requestSource, error) {
	if !deviceEnabled() {
		return requestSource{}, errors.New(deviceUnavailableMessage)
	}
	state, err := loadDeviceStored(filepath.Join(root(), "device-link"))
	if err != nil {
		return requestSource{}, err
	}
	peer := state.Controller
	if peer == nil || peer.DeviceID != id {
		return requestSource{}, errors.New("DEVICE_UNPAIRED: Pair and approve this controller locally; read cli guide.")
	}
	if deviceCorePeerSource == nil {
		return requestSource{}, errors.New(PortPending)
	}
	source, err := deviceCorePeerSource(ctx, id, peer.PublicKey, touch)
	if err != nil {
		return requestSource{}, err
	}
	if !deviceOwnsOrigin(source.origin, id) {
		return requestSource{}, errors.New("DEVICE_UNPAIRED: Pair and approve this controller locally; read cli guide.")
	}
	return source, nil
}

func deviceOwnsOrigin(origin object, id string) bool {
	owner := text(origin, "deviceId")
	if owner == "" {
		owner, _ = strings.CutPrefix(text(origin, "ingressId"), "peer:")
		if owner == text(origin, "ingressId") {
			return false
		}
	}
	return id != "" && text(origin, "authType") == "peer" && owner == id
}

func dispatchDeviceControl(ctx context.Context, s *service, id string, body object) (any, error) {
	request, err := decodeDeviceRequest(body, "INVALID_ARGUMENT: expected peer request envelope")
	if err != nil {
		return nil, err
	}
	source, err := authorizedDeviceController(ctx, id, true)
	if err != nil {
		return nil, err
	}
	source.local = true
	allowed := []any{}
	for _, value := range arr(catalog()["ops"]) {
		name := text(value, "name")
		if !devicePeerForbidden(name) && (name != "screen" || operatingSystem == "darwin") {
			allowed = append(allowed, name)
		}
	}
	source.policy = object{"allowlist": allowed}
	source.origin = maps.Clone(source.origin)
	source.origin["controlTransport"], source.origin["peerOrigin"], source.origin["deviceId"] = "peer", request.Origin, id
	ctx = withOrigin(ctx, source.origin)
	op := text(request.Body, "op")
	args := obj(field(request.Body, "args"))
	if err := deviceAuthorizeVisible(ctx, s, id, op, args); err != nil {
		return egressTool(object{"error": controlFailure(err)}, true), nil
	}
	agent := text(args, "agent")
	if strings.HasPrefix(op, "codex_") {
		agent = "codex"
	}
	if agent != "" && (deviceCoreAgentAvailable == nil || !deviceCoreAgentAvailable(ctx, s, agent)) {
		return egressTool(object{"error": object{
			"code":    "DEVICE_AGENT_UNAVAILABLE",
			"message": "This member does not expose the requested Agent. Query agents or codex_capabilities on this member and choose an enabled available Agent; query guide with topic:device.",
			"next":    object{"via": "query", "op": "guide", "args": object{"topic": "device"}},
		}}, true), nil
	}
	switch op {
	case devicePeerTaskEvents:
		if request.Tool != "query" {
			return nil, errors.New("INVALID_ARGUMENT: peer_task_events is a peer query")
		}
		reply, err := peerEvents.read(ctx, text(source.origin, "sourceId"), args)
		if err != nil {
			return nil, err
		}
		return egressTool(reply, false), nil
	case "codex_tasks", "agent_tasks", "task_activity":
		if deviceCoreTaskRead == nil {
			return nil, errors.New(PortPending)
		}
		return deviceCoreTaskRead(ctx, s, source, op, args)
	}
	spec := operation(op)
	if request.Tool == "act" && op != "receipt" && spec != nil && via(spec) == "act" && retryContract(spec)["mode"] != "receipt" {
		return deviceRecordPeerWrite(ctx, s, source, request)
	}
	return callTool(ctx, s, source, request.Tool, request.Body, nil), nil
}

func deviceAuthorizeVisible(ctx context.Context, s *service, id, op string, args object) error {
	denied := func() error {
		return errors.New(wire(object{"code": "DEVICE_TASK_NOT_VISIBLE",
			"message": "Only tasks dispatched by this controller are visible. List codex_tasks or agent_tasks on the paired member; query guide with topic:device.",
			"next":    object{"via": "query", "op": "guide", "args": object{"topic": "device"}},
		}))
	}
	switch op {
	case "codex_query", "codex_call", "codex_thread", "codex_events":
		return denied()
	case "codex_pending", "codex_respond":
		if _, ok := args["threadId"].(string); !ok {
			return denied()
		}
	case "receipt":
		return deviceAuthorizeReceipt(s, id, text(args, "requestId"), denied)
	}
	task := text(args, "threadId")
	if task == "" {
		task = text(args, "taskId")
	}
	agent := text(args, "agent")
	if strings.HasPrefix(op, "codex_") {
		agent = "codex"
	}
	if task != "" && (deviceCoreTaskVisible == nil || !deviceCoreTaskVisible(ctx, agent, task, id)) {
		return denied()
	}
	return nil
}

func deviceAuthorizeReceipt(s *service, id, name string, denied func() error) error {
	found := false
	for _, store := range []receiptStore{coreReceiptStore(), agentReceiptStore()} {
		row, err := store.read(name, text(s.metadata, "instance"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !deviceOwnsOrigin(obj(row["origin"]), id) {
			return denied()
		}
		found = true
	}
	if !found {
		return denied()
	}
	return nil
}

func linkedPeerSource(_ context.Context, device, key string, touch bool) (requestSource, error) {
	row, err := pairedSourceAuthority(device, key)
	if err != nil {
		return requestSource{}, err
	}
	if row["connectionRemoved"] == true {
		return requestSource{}, sourceAuthorizationError(row)
	}
	origin := object{"deviceId": device, "authType": "peer", "sourceId": row["id"]}
	if touch {
		origin, err = touchControlSource(row, "peer")
		if err != nil {
			return requestSource{}, err
		}
		origin["deviceId"] = device
	}
	return requestSource{local: true, origin: origin, profile: row, policy: "all"}, nil
}

func peerVisibleTask(_ context.Context, agent, task, peer string) bool {
	records, _ := dispatchRecords(task)
	for _, row := range records {
		if deviceOwnsOrigin(obj(row["origin"]), peer) {
			return true
		}
	}
	if agent == "codex" {
		return false
	}
	if _, err := uuid.Parse(task); err != nil {
		return false
	}
	row, err := cachedJSON(filepath.Join(root(), "agents/tasks", task+".json"))
	return err == nil && field(row, "agent") == agent && deviceOwnsOrigin(obj(field(row, "origin")), peer)
}

func init() {
	deviceCorePeerSource = linkedPeerSource
	deviceCoreTaskVisible = peerVisibleTask
	authorizePeerDevice = func(ctx context.Context, id string) error {
		_, err := authorizedDeviceController(ctx, id, false)
		return err
	}
	peerControlRequest = dispatchDeviceControl
}

func deviceRecordPeerWrite(ctx context.Context, s *service, source requestSource, request devicePeerRequest) (any, error) {
	store := coreReceiptStore()
	requestID := text(request.Body, "requestId")
	if requestID == "" {
		requestID = id()
	}
	digest := hash([]byte(wire(request.Body)))
	session := text(s.metadata, "instance")
	release := lockReceipt(requestID)
	defer release()
	row, err := store.replay(ctx, requestID, digest, session)
	if err != nil {
		return nil, err
	}
	if row != nil {
		if reply := row["peerResponse"]; reply != nil {
			return reply, nil
		}
		return egressTool(row, false), nil
	}
	row = object{"requestId": requestID, "digest": digest, "operation": field(request.Body, "op"),
		"origin": source.origin, "backendSession": session, "state": "reserved", "createdAt": now()}
	if err := store.reserve(ctx, row); err != nil {
		return nil, err
	}
	owner, err := store.begin(ctx, row)
	if err != nil {
		return nil, err
	}
	defer owner.close()
	reply := callTool(ctx, s, source, request.Tool, request.Body, nil)
	value, err := egressToolValue(reply)
	if err != nil {
		return nil, err
	}
	row["result"], row["peerResponse"], row["state"] = value, reply, "completed"
	if reply["isError"] == true {
		row["state"] = "failed"
	}
	if err := store.checkpoint(context.WithoutCancel(ctx), row); err != nil {
		return nil, err
	}
	return reply, nil
}
