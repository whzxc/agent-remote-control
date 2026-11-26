package core

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

var buildVersion = "0.0.0"

func buildID(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", digest.Sum(nil)), nil
}

var processBuildID = sync.OnceValues(func() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return buildID(path)
})

func lockCore() (*os.File, error) {
	if err := platform.PrivateDir(root()); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(root(), "core.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	locked, err := platform.TryLock(lock)
	if err != nil || !locked {
		lock.Close()
		return nil, err
	}
	return lock, nil
}

type lease struct {
	kind         string
	pid          uint64
	processStart string
	seen         time.Time
	desktop      object
}

type runtimeState struct {
	sync.Mutex
	leases   map[string]lease
	closing  bool
	stop     context.CancelFunc
	launches launches
}

func (r *runtimeState) expire(at time.Time) {
	for key, l := range r.leases {
		if at.Sub(l.seen) >= 10*time.Second && (l.kind != "desktop" || l.processStart == "" || platform.ProcessStart(int(l.pid)) != l.processStart) {
			delete(r.leases, key)
		}
	}
}

func (r *runtimeState) clients() []object {
	r.Lock()
	defer r.Unlock()
	r.expire(time.Now())
	ids := make([]string, 0, len(r.leases))
	for id := range r.leases {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	clients := make([]object, 0, len(ids))
	for _, id := range ids {
		client := r.leases[id]
		clients = append(clients, object{"id": id, "kind": client.kind, "pid": client.pid})
	}
	return clients
}

func (r *runtimeState) request(route string, body object) (object, error) {
	key := text(body, "id")
	if _, err := uuid.Parse(key); err != nil {
		return nil, errors.New("invalid client id")
	}
	r.Lock()
	defer r.Unlock()
	at := time.Now()
	r.expire(at)
	switch route {
	case "runtime/lease":
		if proof, exists := body["isolatedOwner"]; exists {
			instance, owner := os.Getenv("ARC_DEV_INSTANCE_ID"), os.Getenv("ARC_DEV_OWNER_ID")
			if instance == "" || owner == "" || field(proof, "instance") != instance || field(proof, "id") != owner {
				return nil, errors.New("Core ownership changed. No Core was stopped.")
			}
		}
		if r.closing {
			return nil, errors.New("core shutting down")
		}
		kind := text(body, "kind")
		pid, ok := uintValue(body["pid"])
		if !ok || kind != "cli" && kind != "desktop" {
			return nil, errors.New("invalid local entrypoint")
		}
		if _, found := r.leases[key]; len(r.leases) >= 128 && !found {
			return nil, errors.New("too many local clients")
		}
		var start string
		if kind == "desktop" {
			for id, l := range r.leases {
				if id != key && l.kind == "desktop" {
					return nil, errors.New("A Desktop entry point is already using this data. Use another state directory.")
				}
			}
			if existing := r.leases[key]; existing.pid == pid && existing.processStart != "" {
				start = existing.processStart
			} else {
				start = platform.ProcessStart(int(pid))
			}
		}
		desktop := obj(body["desktop"])
		if desktop != nil && (uintOr(desktop["port"], 0) == 0 || uintOr(desktop["port"], 0) > 65535 || len(text(desktop, "token")) < 32) {
			return nil, errors.New("invalid desktop endpoint")
		}
		r.leases[key] = lease{kind, pid, start, at, desktop}
		return object{"instance": key, "version": buildVersion}, nil
	case "runtime/release":
		delete(r.leases, key)
		return object{"released": true}, nil
	case "runtime/shutdown":
		isolated := os.Getenv("ARC_DEV_INSTANCE_ID") != "" && os.Getenv("ARC_DEV_OWNER_ID") == key
		if !isolated && r.leases[key].kind != "desktop" {
			return nil, errors.New("Only the registered Desktop can stop Core.")
		}
		r.closing = true
		r.launches.close()
		r.stop()
		return object{"closing": true}, nil
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}
