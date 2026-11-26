package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

type ownedChildren struct {
	dir   string
	owner object
}

var childRegistry struct {
	sync.RWMutex
	current *ownedChildren
}

func reclaimableChild(record object, childStart, ownerStart string) bool {
	return childStart != "" && record["processStart"] == childStart && (ownerStart == "" || field(record["owner"], "processStart") != ownerStart)
}

func recoverOwnedChildren(ctx context.Context, name string) error {
	dir := filepath.Join(root(), name)
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	rows, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range rows {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		raw, err := load(path)
		if err != nil {
			return err
		}
		record := obj(raw)
		pid, ok := uintValue(record["pid"])
		owner, ownerOK := uintValue(field(record["owner"], "pid"))
		if !ok || !ownerOK || pid == 0 || pid > 1<<31-1 || owner == 0 || owner > 1<<31-1 {
			return errors.New("CORE_CHILD_INDEX_INVALID")
		}
		childStart := platform.ProcessStart(int(pid))
		if reclaimableChild(record, childStart, platform.ProcessStart(int(owner))) {
			recordLog("WARN", fmt.Sprintf("Reclaiming process %d left by the previous %s owner", pid, name), nil)
			if err := reclaimChild(ctx, int(pid), childStart); err != nil {
				return err
			}
		} else if childStart != "" && record["processStart"] == childStart {
			return errors.New("CORE_CHILD_OWNER_ACTIVE: another Core still owns a recorded process")
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	start := platform.ProcessStart(os.Getpid())
	if start == "" {
		return errors.New("CORE_IDENTITY_UNAVAILABLE")
	}
	childRegistry.Lock()
	childRegistry.current = &ownedChildren{dir: dir, owner: object{"pid": os.Getpid(), "processStart": start}}
	childRegistry.Unlock()
	return nil
}

func reclaimChild(ctx context.Context, pid int, start string) error {
	if platform.ProcessStart(pid) != start {
		return nil
	}
	platform.SignalTree(pid, false)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for platform.ProcessStart(pid) == start {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		case <-deadline.C:
			if platform.ProcessStart(pid) != start {
				return nil
			}
			platform.SignalTree(pid, true)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
			if platform.ProcessStart(pid) == start {
				return fmt.Errorf("CORE_CHILD_RECLAIM_FAILED: process %d is still alive; replacement startup stopped", pid)
			}
			return nil
		}
	}
	return nil
}

func startOwnedChild(command *exec.Cmd) error {
	childRegistry.RLock()
	owner := childRegistry.current
	childRegistry.RUnlock()
	if owner == nil {
		return command.Start()
	}
	platform.OwnChild(command)
	if err := command.Start(); err != nil {
		return err
	}
	pid := command.Process.Pid
	start := platform.ProcessStart(pid)
	var err error
	if start == "" {
		return nil
	}
	err = save(filepath.Join(owner.dir, fmt.Sprintf("%d.json", pid)), object{"pid": pid, "processStart": start, "owner": owner.owner})
	if err != nil {
		platform.SignalTree(pid, true)
		_ = command.Wait()
	}
	return err
}
