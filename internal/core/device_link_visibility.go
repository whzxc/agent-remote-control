package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/google/uuid"
)

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
	if task != "" && (!peerVisibleTask(ctx, agent, task, id)) {
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

// The Agent activity owner calls this before projecting a peer task overview.
func filterDeviceActivity(ctx context.Context, activity object, peer string) {
	agents := obj(activity["agents"])
	if agents == nil {
		return
	}
	for agent, raw := range agents {
		row := obj(raw)
		sessions := slices.DeleteFunc(arr(row["sessions"]), func(session any) bool {
			return !peerVisibleTask(ctx, agent, text(session, "id"), peer)
		})
		if len(sessions) == 0 {
			delete(agents, agent)
		} else {
			row["sessions"] = sessions
		}
	}
	activity["activeAgents"] = keys(agents)
}
