package core

import (
	"context"
	"errors"
	"maps"
	"path/filepath"

	"strings"
)

// Segment A supplies Agent availability and native task projections.
var deviceCoreAgentAvailable func(context.Context, *service, string) bool

// deviceCoreTaskRead returns the native operation result before MCP egress.
var deviceCoreTaskRead func(context.Context, *service, requestSource, string, object) (object, error)

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
	source, err := linkedPeerSource(ctx, id, peer.PublicKey, touch)
	if err != nil {
		return requestSource{}, err
	}
	if !deviceOwnsOrigin(source.origin, id) {
		return requestSource{}, errors.New("DEVICE_UNPAIRED: Pair and approve this controller locally; read cli guide.")
	}
	return source, nil
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
		result, err := deviceCoreTaskRead(ctx, s, source, op, args)
		if err != nil {
			return egressTool(object{"error": controlFailure(err)}, true), nil
		}
		return egressTool(result, false), nil
	}
	spec := operation(op)
	if request.Tool == "act" && op != "receipt" && spec != nil && via(spec) == "act" && retryContract(spec)["mode"] != "receipt" {
		return deviceRecordPeerWrite(ctx, s, source, request)
	}
	return callTool(ctx, s, source, request.Tool, request.Body, nil), nil
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

func init() {
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
