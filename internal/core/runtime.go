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

var processBuildID = cachedExecutableBuildID(os.Executable)

func cachedExecutableBuildID(executable func() (string, error)) func() (string, error) {
	return sync.OnceValues(func() (string, error) {
		path, err := executable()
		if err != nil {
			return "", err
		}
		return buildID(path)
	})
}

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
	recordRuntimeWork(context.Background(), runtimeWorkCost{Owner: "runtime-lease", Reason: "poll", Rows: len(r.leases), ScanSet: len(r.leases)})
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

func (r *runtimeState) desktopRequest(ctx context.Context, route, method string, body object) (any, error) {
	if operatingSystem == "linux" && route != "app/snapshot" {
		return nil, errors.New("DESKTOP_UNSUPPORTED: this operation requires a desktop UI; Linux runs headless.")
	}
	r.Lock()
	r.expire(time.Now())
	var endpoint object
	for _, lease := range r.leases {
		if lease.desktop != nil {
			endpoint = lease.desktop
			break
		}
	}
	r.Unlock()
	if endpoint == nil {
		return nil, errors.New("Desktop is not running. This operation requires the Desktop entry point.")
	}
	select {
	case desktopForwards <- struct{}{}:
		defer func() { <-desktopForwards }()
	default:
		return nil, errors.New(desktopBusy)
	}
	return forwardDesktop(ctx, endpoint, route, method, body)
}

var desktopForwards = make(chan struct{}, 16)

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

func (r *runtimeState) uninstall(token string, proof any) (object, error) {
	if token == "" || !secureToken(token, text(proof, "token")) || uintOr(field(proof, "pid"), 0) != uint64(os.Getpid()) ||
		text(proof, "processStart") == "" || text(proof, "processStart") != platform.ProcessStart(os.Getpid()) {
		return nil, errors.New("UNINSTALL_AUTH_REQUIRED: run the local uninstall command")
	}
	r.Lock()
	r.closing = true
	r.Unlock()
	r.launches.close()
	r.stop()
	return object{"closing": true}, nil
}

func init() {
	registerRoute("GET", "runtime/clients", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		return s.runtime.clients(), nil
	})
	registerRoute("POST", "runtime/uninstall", func(_ context.Context, s *service, args object, _ []string) (any, error) {
		proof, _ := load(filepath.Join(root(), "uninstall-core.json"))
		return s.runtime.uninstall(text(args, "token"), proof)
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
	if configureRuntimeFixture != nil {
		configureRuntimeFixture(s)
	}
	startIndexes := prepareRuntimeIndexes(s)
	defer s.close()
	core := newInProcess(s)
	ipc, err := listenPrivate(ipcContext, "core", secret, core, nil)
	if err != nil {
		return err
	}
	defer ipc.Close()
	attachment, err := ensureFrontDoor(ctx, build)
	if err != nil {
		return err
	}
	published := maps.Clone(metadata)
	published["port"], published["token"] = attachment.info["port"], attachment.info["token"]
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
	startIndexes(ctx)
	if err := s.start(ctx); err != nil {
		return err
	}
	supervisor, stopSupervisor := context.WithCancel(ctx)
	supervised := make(chan struct{})
	go func() {
		defer close(supervised)
		superviseFrontDoor(supervisor, s, core, path, published)
	}()
	defer func() {
		stopSupervisor()
		<-supervised
	}()
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
	drain, cancelDrain := context.WithTimeout(context.WithoutCancel(ctx), drainTimeout)
	defer cancelDrain()
	if _, err := core.drainRequests(drain); err != nil {
		recordLog("WARN", "FRONT_DOOR_CORE_DRAIN_TIMEOUT", nil)
	}
	s.runtime.launches.close()
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
	r.launches.close()
	return true
}

var runtimeFixture bool
var configureRuntimeFixture func(*service)

func runtimeBinary() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	name := "arc"
	if operatingSystem == "windows" {
		name += ".exe"
	}
	base := filepath.Base(executable)
	if base == name || runtimeFixture && (base == "contract-fixture" || base == "contract-fixture.exe") {
		return executable, nil
	}
	parent := filepath.Dir(executable)
	for _, path := range []string{filepath.Join(parent, "../Resources/bin", name), filepath.Join(parent, "bin", name)} {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, nil
		}
	}
	return "", errors.New("The installation is missing the standalone Core executable.")
}

func coreUnlocked() (bool, error) {
	lock, err := os.OpenFile(filepath.Join(root(), "core.lock"), os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer lock.Close()
	return platform.TryLock(lock)
}

func waitCoreExit(ctx context.Context) error {
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if unlocked, err := coreUnlocked(); unlocked || err != nil {
			return err
		}
		select {
		case <-wait.Done():
			return errors.New("Core shutdown timed out")
		case <-tick.C:
		}
	}
}
