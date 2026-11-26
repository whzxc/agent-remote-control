package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
	assets "github.com/whzxc/agent-remote-control/shared/core"
)

func stoppedCorePath() string { return filepath.Join(root(), "app/core-stopped.json") }

func coreStopped() bool {
	_, err := os.Stat(stoppedCorePath())
	return err == nil
}

func clearCoreStopped() error {
	err := os.Remove(stoppedCorePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type runtimeClient struct {
	id, kind, binary, build string
	desktop                 object
	active                  bool
	access                  sync.RWMutex
	startup                 sync.Mutex
	heartbeat               context.CancelFunc
	done                    chan struct{}
}

func newRuntimeClient(binary, kind string, desktop object) (*runtimeClient, error) {
	build, err := buildID(binary)
	if err != nil {
		return nil, err
	}
	return &runtimeClient{id: id(), kind: kind, binary: binary, build: build, desktop: clone(desktop), active: true}, nil
}

func connectRuntimeClient(ctx context.Context, binary, kind string) (*runtimeClient, error) {
	client, err := newRuntimeClient(binary, kind, nil)
	if err != nil {
		return nil, err
	}
	wait, cancel := context.WithTimeout(ctx, 18*time.Second)
	defer cancel()
	for {
		err := client.ensureCore(wait)
		if err == nil {
			client.resume()
			return client, nil
		}
		if err.Error() != "core shutting down" && !strings.HasPrefix(err.Error(), "CORE_BUILD_MISMATCH") &&
			!strings.HasPrefix(err.Error(), "CORE_UNAVAILABLE") {
			return nil, err
		}
		select {
		case <-wait.Done():
			return nil, err
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func newDesktopRuntimeClient(binary string, endpoint object) (*runtimeClient, error) {
	client, err := newRuntimeClient(binary, "desktop", endpoint)
	if err != nil {
		return nil, err
	}
	client.resume()
	return client, nil
}

func (c *runtimeClient) resume() {
	c.access.Lock()
	defer c.access.Unlock()
	c.active = true
	c.startHeartbeat()
}

func (c *runtimeClient) startHeartbeat() {
	if c.heartbeat != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.heartbeat, c.done = cancel, done
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if coreStopped() {
				continue
			}
			// Do not wait behind a Desktop shutdown or a replacement holding the gate.
			if !c.access.TryRLock() {
				continue
			}
			if c.active {
				if err := c.ensureCore(ctx); err != nil && ctx.Err() == nil {
					fmt.Fprintln(os.Stderr, "Core heartbeat:", err)
				}
			}
			c.access.RUnlock()
		}
	}()
}

func (c *runtimeClient) stopHeartbeat() {
	if c.heartbeat != nil {
		c.heartbeat()
		<-c.done
		c.heartbeat, c.done = nil, nil
	}
}

func runtimeOwner(ctx context.Context, build string) (object, error) {
	info, health, err := discoverLocal(ctx)
	if err != nil {
		return nil, nil
	}
	if health["owner"] != "core" || health["version"] != buildVersion ||
		health["build"] != build || health["build"] != info["build"] {
		return nil, errors.New(coreBuildMismatch)
	}
	return info, nil
}

func runtimeOwnerForStartup(ctx context.Context, build string) (object, error) {
	if operatingSystem == "windows" {
		wait, cancel := context.WithTimeout(ctx, windowsCoreShutdownLimit+time.Second)
		defer cancel()
		ctx = wait
	}
	const unavailable = "CORE_UNAVAILABLE: The existing Core still owns the state directory but did not answer its health check. Retry after it becomes responsive; inspect core.log if this persists."
	for {
		if info, err := runtimeOwner(ctx, build); info != nil || err != nil {
			return info, err
		}
		if unlocked, err := coreUnlocked(); unlocked || err != nil {
			return nil, err
		}
		if operatingSystem != "windows" {
			return nil, errors.New(unavailable)
		}
		// A draining Core stops answering health checks before releasing its lock.
		select {
		case <-ctx.Done():
			return nil, errors.New(unavailable)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *runtimeClient) subscriptions(ctx context.Context) (any, error) {
	return c.request(ctx, "subscriptions", http.MethodGet, nil)
}

func (c *runtimeClient) networkPreferences(ctx context.Context) (any, error) {
	return c.request(ctx, "network", http.MethodGet, nil)
}

func launchLeasedCore(ctx context.Context, binary, build string) error {
	replacement, err := prepareFrontDoorInstall(ctx)
	if err != nil {
		return err
	}
	defer replacement.Close()
	if err := platform.PrivateDir(root()); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(root(), "core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	child := exec.Command(binary, "serve")
	child.Stderr = log
	platform.Detach(child)
	_ = replacement.Close()
	if err := child.Start(); err != nil {
		return fmt.Errorf("Core start failed: %w", err)
	}
	exiting := make(chan error, 1)
	go func() { exiting <- child.Wait() }()
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		if info, err := runtimeOwner(wait, build); info != nil || err != nil {
			return err
		}
		select {
		case err := <-exiting:
			if err == nil {
				return errors.New("core shutting down")
			}
			return fmt.Errorf("Core exited during startup (%v); check core.log", err)
		case <-wait.Done():
			return errors.New("Core startup timed out. Check core.log in the state directory.")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *runtimeClient) lease() object {
	return object{"id": c.id, "kind": c.kind, "pid": os.Getpid(), "desktop": c.desktop}
}

func (c *runtimeClient) ensureCore(ctx context.Context) error {
	c.startup.Lock()
	defer c.startup.Unlock()
	if coreStopped() {
		return errors.New("CORE_STOPPED: Start Core from ARC Desktop.")
	}
	info, err := runtimeOwnerForStartup(ctx, c.build)
	if err != nil {
		return err
	}
	if info == nil {
		if err := launchLeasedCore(ctx, c.binary, c.build); err != nil {
			return err
		}
		info, err = runtimeOwner(ctx, c.build)
		if err != nil {
			return err
		}
		if info == nil {
			return errors.New("core shutting down")
		}
	}
	_, err = forwardToCore(ctx, info, "runtime/lease", http.MethodPost, c.lease())
	if err != nil {
		if _, ownershipErr := runtimeOwner(ctx, c.build); ownershipErr != nil {
			return ownershipErr
		}
		if now, _ := runtimeOwner(ctx, c.build); now == nil {
			return errors.New("core shutting down")
		}
	}
	return err
}

func (c *runtimeClient) request(ctx context.Context, route, method string, body object) (any, error) {
	c.access.RLock()
	defer c.access.RUnlock()
	if !c.active {
		return nil, errors.New("Core is paused for shutdown or update installation.")
	}
	if err := c.ensureCore(ctx); err != nil {
		return nil, err
	}
	info, err := runtimeOwner(ctx, c.build)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, errors.New(appUnavailable)
	}
	return forwardToCore(ctx, info, route, method, body)
}

func (c *runtimeClient) close(ctx context.Context) {
	c.access.Lock()
	defer c.access.Unlock()
	c.active = false
	c.stopHeartbeat()
	if info, err := runtimeOwner(ctx, c.build); err == nil && info != nil {
		_, _ = forwardToCore(ctx, info, "runtime/release", http.MethodPost, object{"id": c.id})
	}
}

func (c *runtimeClient) shutdown(ctx context.Context) error {
	c.access.Lock()
	defer c.access.Unlock()
	if coreStopped() {
		if err := c.stopCurrent(ctx, false); err != nil {
			return err
		}
	} else {
		if !c.active {
			return errors.New("Core is paused for shutdown or update installation.")
		}
		if err := c.ensureCore(ctx); err != nil {
			return err
		}
		info, err := runtimeOwner(ctx, c.build)
		if err != nil {
			return err
		}
		if info == nil {
			return errors.New(appUnavailable)
		}
		if _, err := forwardToCore(ctx, info, "runtime/shutdown", http.MethodPost, object{"id": c.id}); err != nil {
			return err
		}
	}
	c.active = false
	c.stopHeartbeat()
	return waitCoreExit(ctx)
}

func (c *runtimeClient) controlCore(ctx context.Context, action string) error {
	if c.kind != "desktop" || action != "start" && action != "stop" && action != "restart" {
		return errors.New("Invalid Desktop Core action.")
	}
	c.access.Lock()
	defer c.access.Unlock()
	if action != "start" {
		previouslyStopped := coreStopped()
		if err := save(stoppedCorePath(), true); err != nil {
			return err
		}
		c.active = false
		c.stopHeartbeat()
		if err := c.stopCurrent(ctx, action == "restart"); err != nil {
			if action == "restart" && !previouslyStopped {
				if markerErr := clearCoreStopped(); markerErr != nil {
					return errors.Join(err, markerErr)
				}
				c.active = true
				c.startHeartbeat()
			}
			return err
		}
	}
	if action == "stop" {
		return nil
	}
	if err := clearCoreStopped(); err != nil {
		return err
	}
	c.active = true
	c.startHeartbeat()
	return c.ensureCore(ctx)
}

func (c *runtimeClient) stopCurrent(ctx context.Context, recover bool) error {
	if unlocked, err := coreUnlocked(); unlocked || err != nil {
		return err
	}
	info, err := runtimeOwner(ctx, c.build)
	if err != nil {
		return err
	}
	if info != nil {
		wait, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err = forwardToCore(wait, info, "runtime/lease", http.MethodPost, c.lease())
		if err == nil {
			_, err = forwardToCore(wait, info, "runtime/shutdown", http.MethodPost, object{"id": c.id})
		}
		cancel()
		if err == nil {
			err = waitCoreExit(ctx)
		}
		if err == nil || !recover {
			return err
		}
	}
	if !recover {
		return errors.New("Core did not respond. Use Core recovery to restart it.")
	}
	if unlocked, err := coreUnlocked(); unlocked || err != nil {
		return err
	}
	if err := terminateVerifiedCore(c.build); err != nil {
		return err
	}
	return waitCoreExit(ctx)
}

func terminateVerifiedCore(build string) error {
	value, err := load(filepath.Join(root(), "app/native.json"))
	if err != nil {
		return err
	}
	pid := uintOr(field(value, "pid"), 0)
	start := text(value, "processStart")
	if pid <= 1 || pid > 1<<31-1 || start == "" || field(value, "owner") != "core" ||
		field(value, "build") != build || platform.ProcessStart(int(pid)) != start {
		return errors.New("Could not verify the running Core process. No process was stopped.")
	}
	process, err := os.FindProcess(int(pid))
	if err != nil {
		return err
	}
	defer process.Release()
	if platform.ProcessStart(int(pid)) != start {
		return errors.New("Could not stop the verified Core process.")
	}
	return process.Kill()
}

func stopCoreForUninstall(ctx context.Context) error {
	build, err := processBuildID()
	if err != nil {
		return err
	}
	info, err := runtimeOwner(ctx, build)
	if err != nil || info == nil {
		return err
	}
	pid := uintOr(info["pid"], 0)
	if pid <= 1 || pid > 1<<31-1 {
		return errors.New("CORE_PID_MISSING")
	}
	start := platform.ProcessStart(int(pid))
	if start == "" || info["processStart"] != start {
		return errors.New("CORE_IDENTITY_UNAVAILABLE")
	}
	path := filepath.Join(root(), "uninstall-core.json")
	token := id()
	if err := save(path, object{"token": token, "pid": pid, "processStart": start}); err != nil {
		return err
	}
	defer os.Remove(path)
	if _, err := forwardToCore(ctx, info, "runtime/uninstall", http.MethodPost, object{"token": token}); err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		if unlocked, err := coreUnlocked(); unlocked || err != nil {
			return err
		}
		select {
		case <-wait.Done():
			return errors.New("Core shutdown timed out; uninstall stopped")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *runtimeClient) hubHealth(ctx context.Context) (object, error) {
	expected, expectedErr := expectedRemote()
	info, ownerErr := runtimeOwner(ctx, c.build)
	state, unavailable := "unavailable", false
	if ownerErr == nil {
		if info != nil {
			state = "ready"
		} else if unlocked, err := coreUnlocked(); coreStopped() && err == nil && unlocked {
			state = "stopped"
		}
	}
	var faults any = expected
	if expectedErr != nil {
		faults, unavailable = []object{}, true
	} else if len(expected) != 0 && info != nil {
		wait, cancel := context.WithTimeout(ctx, 5*time.Second)
		actual, err := forwardToCore(wait, info, "runtime/remote", http.MethodGet, nil)
		cancel()
		if err == nil {
			faults = actual
		} else {
			unavailable = true
		}
	}
	return object{"core": state, "remoteFaults": faults, "remoteUnavailable": unavailable}, nil
}

func desktopRelaunchCommand() (*exec.Cmd, io.Closer, error) {
	if operatingSystem != "darwin" {
		return nil, nil, errors.New("APP_RESTART_UNAVAILABLE")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	macos := filepath.Dir(executable)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
		return nil, nil, errors.New("APP_RESTART_UNAVAILABLE: Restart requires an application bundle. Quit and start the development entry point again.")
	}
	script, err := assets.Files.ReadFile("relaunch-macos.sh")
	if err != nil {
		return nil, nil, err
	}
	args := []string{"-c", string(script), "arc-app-relaunch", strconv.Itoa(os.Getpid()), "/usr/bin/open", "-a", bundle, "--args"}
	cmd := exec.Command("/bin/sh", append(args, os.Args[1:]...)...)
	log, err := os.OpenFile(filepath.Join(root(), "core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, err
	}
	cmd.Stderr = log
	platform.Detach(cmd)
	return cmd, log, nil
}
