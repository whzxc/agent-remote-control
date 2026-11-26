package core

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"maps"
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

func init() {
	registerRoute("GET", "runtime/clients", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		return s.runtime.clients(), nil
	})
	registerRoute("POST", "runtime/uninstall", func(_ context.Context, s *service, args object, _ []string) (any, error) {
		proof, _ := load(filepath.Join(root(), "uninstall-core.json"))
		token := text(args, "token")
		if token == "" || !secureToken(token, text(proof, "token")) || uintOr(field(proof, "pid"), 0) != uint64(os.Getpid()) ||
			text(proof, "processStart") != platform.ProcessStart(os.Getpid()) {
			return nil, errors.New("UNINSTALL_AUTH_REQUIRED: Run the local uninstall command.")
		}
		s.runtime.Lock()
		s.runtime.closing = true
		s.runtime.Unlock()
		s.runtime.stop()
		return object{"closing": true}, nil
	})
	for _, route := range []string{"runtime/lease", "runtime/release", "runtime/shutdown"} {
		registerRoute("POST", route, func(_ context.Context, s *service, body object, _ []string) (any, error) {
			return s.runtime.request(route, body)
		})
	}
}

const coreBuildMismatch = "CORE_BUILD_MISMATCH: Close other local entry points. Reload Desktop and CLI from the same build."

func serveRuntime(parent context.Context, daemon bool) error {
	guard, err := frontDoorStartupGuard()
	if err != nil {
		return err
	}
	defer guard.Close()
	lock, err := lockCore()
	if err != nil || lock == nil {
		return err
	}
	defer lock.Close()
	if _, err := os.Stat(filepath.Join(root(), "app/core-stopped.json")); err == nil {
		return errors.New("CORE_STOPPED: Start Core from ARC Desktop.")
	}
	build, err := processBuildID()
	if err != nil {
		return err
	}
	if _, health, err := discoverLocal(parent); err == nil {
		if text(health, "build") != build || health["owner"] != "core" || health["version"] != buildVersion {
			return errors.New(coreBuildMismatch)
		}
		return nil
	}
	initializeResourceLimits()
	if err := recoverOwnedChildren(parent, "core-children"); err != nil {
		return err
	}
	secret, err := ensureFrontDoorSecret()
	if err != nil {
		return err
	}
	ctx, stop := context.WithCancel(parent)
	defer stop()
	ipcContext, endIPC := context.WithCancel(context.WithoutCancel(parent))
	defer endIPC()
	metadata := object{"pid": os.Getpid(), "processStart": platform.ProcessStart(os.Getpid()), "instance": id(),
		"runtime": "rust", "version": buildVersion, "owner": "core", "daemon": daemon, "build": build}
	s := &service{metadata: metadata, runtime: &runtimeState{leases: make(map[string]lease), stop: stop},
		source: requestSource{origin: object{"controlSource": "custom"}, profile: object{"product": "custom"}, policy: "all"}}
	core := newInProcess(s)
	ipc, err := listenPrivate(ipcContext, "core", secret, core, nil)
	if err != nil {
		return err
	}
	defer ipc.Close()
	info, err := ensureFrontDoor(ctx, build)
	if err != nil {
		return err
	}
	published := maps.Clone(metadata)
	published["port"], published["token"] = info["port"], info["token"]
	path := filepath.Join(root(), "app/native.json")
	if err := save(path, published); err != nil {
		return err
	}
	defer func() {
		if existing, err := load(path); err == nil && text(existing, "instance") == text(metadata, "instance") {
			_ = os.Remove(path)
		}
	}()
	guard.Close()
	recordLog("INFO", "Service starting", nil)
	for _, start := range serviceStartup {
		if err := start(ctx, s); err != nil {
			return err
		}
	}
	started := time.Now()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var empty time.Time
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case now := <-ticker.C:
			if daemon || len(s.runtime.clients()) != 0 {
				empty = time.Time{}
				continue
			}
			if empty.IsZero() {
				empty = now
			}
			if now.Sub(started) > 15*time.Second && now.Sub(empty) > 2*time.Second && s.runtime.closeIfIdle() {
				break loop
			}
		}
	}
	core.drain()
	drained := make(chan struct{})
	go func() { core.active.Wait(); close(drained) }()
	timer := time.NewTimer(drainTimeout)
	defer timer.Stop()
	select {
	case <-drained:
	case <-timer.C:
		recordLog("WARN", "FRONT_DOOR_CORE_DRAIN_TIMEOUT", nil)
	}
	s.runtime.launches.close()
	for _, name := range s.hub.names() {
		s.hub.forget(name)
	}
	return nil
}

func (r *runtimeState) closeIfIdle() bool {
	r.Lock()
	defer r.Unlock()
	r.expire(time.Now())
	if len(r.leases) != 0 {
		return false
	}
	r.closing = true
	return true
}
