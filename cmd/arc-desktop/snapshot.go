package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/core"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

type snapshotReply struct {
	model any
	err   error
}

type snapshotState struct {
	serial  sync.Mutex
	mu      sync.Mutex
	id      string
	pending chan snapshotReply
}

func (s *snapshotState) acknowledge(id string, model any, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending != nil && s.id == id {
		var err error
		if message != "" {
			err = errors.New(message)
		}
		s.pending <- snapshotReply{model, err}
		s.pending = nil
	}
}

func (s *DesktopService) captureSnapshot(ctx context.Context, body object) (any, error) {
	if err := core.ValidateDesktopSnapshot(body); err != nil {
		return nil, err
	}
	s.snapshot.serial.Lock()
	defer s.snapshot.serial.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := uuid.NewString()
	out := fallback(stringAt(body, "out"), filepath.Join(core.DesktopStateDir(), "acceptance", id))
	if !filepath.IsAbs(out) {
		return nil, errors.New("INVALID_ARGUMENT: out must be an absolute directory")
	}
	modelOnly := body["modelOnly"] == true
	if !modelOnly {
		if err := platform.PrivateDir(out); err != nil {
			return nil, err
		}
	}
	reply := make(chan snapshotReply, 1)
	s.snapshot.mu.Lock()
	s.snapshot.id, s.snapshot.pending = id, reply
	s.snapshot.mu.Unlock()
	defer func() {
		s.snapshot.mu.Lock()
		s.snapshot.id, s.snapshot.pending = "", nil
		s.snapshot.mu.Unlock()
	}()
	var window *mygo.Window
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	err := onMain(wait, func() error {
		window = s.ensureWindow()
		width, height := number(body["width"]), number(body["height"])
		if width > 0 || height > 0 {
			window.SetMinimumSize(320, 320)
			w, h := window.ContentSize()
			if width > 0 {
				w = width
			}
			if height > 0 {
				h = height
			}
			window.SetContentSize(w, h)
		}
		s.show(&desktopMessage{"acceptance:snapshot", object{"id": id, "panel": body["panel"], "taskPanel": body["taskPanel"], "taskBubble": body["taskBubble"]}})
		return nil
	})
	cancel()
	if err != nil {
		return nil, errors.New("SNAPSHOT_TIMEOUT: main thread")
	}
	var model any
	select {
	case result := <-reply:
		if result.err != nil {
			return nil, result.err
		}
		model = result.model
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(20 * time.Second):
		return nil, errors.New("SNAPSHOT_TIMEOUT: UI did not acknowledge rendered state")
	}
	instance := object{"desktopPid": os.Getpid(), "bundleId": bundleID, "appName": appName, "version": core.DesktopVersion()}
	if modelOnly {
		return object{"model": model, "instance": instance}, nil
	}
	modelPath := filepath.Join(out, "view-model.json")
	if err := writeJSON(modelPath, model); err != nil {
		return nil, err
	}
	png, err := capturePNG(ctx, window)
	var pngResult object
	if err == nil {
		path := filepath.Join(out, "snapshot.png")
		if err := writePrivate(path, png); err != nil {
			return nil, err
		}
		pngResult = object{"ok": true, "path": path}
	} else {
		code := "NOT_SUPPORTED"
		if runtime.GOOS == "darwin" {
			code = "SNAPSHOT_FAILED"
		}
		pngResult = object{"ok": false, "code": code, "message": err.Error()}
	}
	return object{"directory": out, "viewModel": modelPath, "png": pngResult, "instance": instance}, nil
}
