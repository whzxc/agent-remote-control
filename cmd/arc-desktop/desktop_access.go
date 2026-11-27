package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/core"
)

func (s *DesktopService) checkWrite() error {
	if s.closing.Load() {
		return errors.New("Installing an update. Wait for the app to restart.")
	}
	return nil
}

func (s *DesktopService) request(ctx context.Context, route, method string, body object) (any, error) {
	if method != http.MethodGet {
		if err := s.checkWrite(); err != nil {
			return nil, err
		}
	}
	switch {
	case route == "runtime/health" && method == http.MethodGet:
		return s.core.Health(ctx)
	case route == "runtime/core" && method == http.MethodPost:
		if err := s.core.Control(ctx, stringAt(body, "action")); err != nil {
			return nil, err
		}
		return s.core.Health(ctx)
	case route == "permissions/request" && method == http.MethodPost:
		return requestPermission(ctx, stringAt(body, "id"))
	case core.DesktopRoute(route):
		return s.desktopRequest(ctx, route, method, body)
	default:
		return s.core.Request(ctx, route, method, body)
	}
}

func (s *DesktopService) desktopRequest(ctx context.Context, route, method string, body object) (any, error) {
	select {
	case s.requests <- struct{}{}:
		defer func() { <-s.requests }()
	default:
		return nil, errors.New("DESKTOP_BUSY: Too many desktop requests are in flight. Wait for completion and read current state before retrying.")
	}
	if method != http.MethodGet {
		if err := s.checkWrite(); err != nil {
			return nil, err
		}
	}
	switch {
	case route == "service" && method == http.MethodGet:
		return object{"supported": runtime.GOOS == "darwin" || runtime.GOOS == "windows", "enabled": autostartEnabled(ctx)}, nil
	case route == "service" && method == http.MethodPost:
		if len(body) != 0 && (len(body) != 1 || !has(body, "enabled")) {
			return nil, errors.New("invalid service request")
		}
		enabled, ok := body["enabled"].(bool)
		if !ok {
			return nil, errors.New("invalid enabled")
		}
		if err := setAutostart(ctx, enabled); err != nil {
			return nil, err
		}
		return object{"supported": true, "enabled": enabled}, nil
	case route == "subscriptions/open" && method == http.MethodPost:
		return s.openSubscriptions(ctx, body)
	case route == "permissions/desktop" && method == http.MethodGet:
		return permissionStatus(ctx), nil
	case route == "permissions/notify" && method == http.MethodPost:
		title, ok := body["title"].(string)
		if !ok {
			title = appName
		}
		err := notify(ctx, title, stringAt(body, "body"), "")
		return object{"sent": true}, err
	case route == "appearance" && runtime.GOOS == "darwin":
		return s.requestAppearance(ctx, method, body)
	case route == "app" && method == http.MethodGet:
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		build, err := core.DesktopBuildID()
		return object{"pid": os.Getpid(), "bundleId": bundleID, "appName": appName, "version": core.DesktopVersion(), "executable": exe, "build": build}, err
	case route == "app/snapshot" && method == http.MethodPost:
		return s.captureSnapshot(ctx, body)
	case (route == "app/quit" || route == "app/restart") && method == http.MethodPost:
		return s.requestExit(route == "app/restart")
	case strings.HasPrefix(route, "src-containers/"):
		return s.sourceRequest(ctx, route, body)
	default:
		return nil, errors.New("UNSUPPORTED_OPERATION")
	}
}

func has(value object, key string) bool {
	_, exists := value[key]
	return exists
}

func (s *DesktopService) openSubscriptions(ctx context.Context, body object) (any, error) {
	if len(body) != 0 && (len(body) != 1 || !has(body, "providerId")) {
		return nil, errors.New("invalid subscriptions open request")
	}
	provider := stringAt(body, "providerId")
	if has(body, "providerId") {
		if provider == "" {
			return nil, errors.New("unknown subscription provider")
		}
		snapshot, err := s.core.Request(ctx, "subscriptions", http.MethodGet, nil)
		if err != nil {
			return nil, err
		}
		found := false
		for _, entry := range rows(objectValue(snapshot)["providers"]) {
			if stringAt(objectValue(entry), "providerId") == provider {
				found = true
				break
			}
		}
		if !found {
			return nil, errors.New("unknown subscription provider")
		}
	}
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := onMain(wait, func() error {
		if err := s.checkWrite(); err != nil {
			return err
		}
		s.show(&desktopMessage{"subscriptions:open", provider})
		return nil
	})
	if errors.Is(err, context.DeadlineExceeded) {
		err = errors.New("desktop request timed out; read current state before retrying a write")
	}
	return object{"opened": true, "providerId": provider, "pid": os.Getpid()}, err
}

func (s *DesktopService) requestExit(restart bool) (any, error) {
	var restartApp func() error
	var restartLog io.Closer
	state := "quitting"
	if restart {
		state = "restarting"
		if runtime.GOOS == "darwin" {
			cmd, file, err := core.DesktopRelaunch()
			if err != nil {
				return nil, err
			}
			restartLog = file
			restartApp = func() error {
				if err := cmd.Start(); err != nil {
					return err
				}
				go func() { _ = cmd.Wait() }()
				return nil
			}
		}
	}
	time.AfterFunc(300*time.Millisecond, func() {
		s.closing.Store(true)
		if restartApp != nil {
			defer restartLog.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			err := s.core.Shutdown(ctx)
			if err == nil {
				err = restartApp()
			}
			if err != nil {
				log.Printf("App restart: %v", err)
				s.core.Resume()
				s.closing.Store(false)
				return
			}
		}
		if restart && runtime.GOOS != "darwin" {
			mygo.App.Relaunch()
		} else {
			mygo.App.Quit()
		}
	})
	return object{"accepted": true, "state": state, "pid": os.Getpid()}, nil
}

func (s *DesktopService) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.core.Close(ctx)
	s.cleanUpdates()
}

func (s *DesktopService) observeProjection(ctx context.Context, route, event string, interval time.Duration) {
	var previous []byte
	for ctx.Err() == nil {
		visible := false
		_ = onMain(ctx, func() error {
			visible = s.window != nil && s.ready && s.window.IsVisible()
			return nil
		})
		if visible {
			value, err := s.core.Request(ctx, route, http.MethodGet, nil)
			if err != nil && route == "subscriptions" {
				value, err = object{}, nil
			}
			if err == nil {
				comparison := value
				if route == "agents/activity" {
					fields := object{}
					for key, item := range objectValue(value) {
						if key != "observedAt" {
							fields[key] = item
						}
					}
					comparison = fields
				}
				current, err := canonjson.Marshal(comparison)
				if err == nil && !bytes.Equal(previous, current) {
					mygo.RunOnMain(func() {
						if s.ready {
							s.emit(event, value)
							previous = current
						}
					})
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func runCommand(ctx context.Context, binary string, args ...string) error {
	return exec.CommandContext(ctx, binary, args...).Run()
}
