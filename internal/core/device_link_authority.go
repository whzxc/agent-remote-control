package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
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
	source.local = false
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
	case "peer_task_events", "codex_tasks", "agent_tasks", "activity":
		if deviceCoreTaskRead == nil {
			return nil, errors.New(PortPending)
		}
		return deviceCoreTaskRead(ctx, s, source, op, args)
	}
	spec := operation(op)
	if request.Tool == "act" && op != "receipt" && spec != nil && via(spec) == "act" && retryContract(spec)["mode"] != "receipt" {
		return nil, errors.New(PortPending)
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

func init() {
	authorizePeerDevice = func(ctx context.Context, id string) error {
		_, err := authorizedDeviceController(ctx, id, false)
		return err
	}
	peerControlRequest = dispatchDeviceControl
}
