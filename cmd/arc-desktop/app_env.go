package main

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type windowDimensions struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

func applyEnvWindow(window *mygo.Window, args object) error {
	width, height := intAt(args, "width"), intAt(args, "height")
	for key, size := range map[string]int{"width": width, "height": height} {
		if args[key] != nil && (size < 320 || size > 3840 || number(args[key]) != size) {
			return errors.New("INVALID_APP_ENV: main window dimensions must be 320..3840 logical pixels")
		}
	}
	baseline := filepath.Join(core.DesktopStateDir(), "app-env-window.json")
	var saved windowDimensions
	w, h := window.ContentSize()
	err := readJSON(baseline, &saved)
	present := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if present && saved.Width <= 0 {
		return errors.New("INVALID_APP_ENV: invalid window baseline")
	}
	if width != 0 || height != 0 {
		if !present {
			if err := writeJSON(baseline, windowDimensions{w, h}); err != nil {
				return err
			}
		}
		window.SetMinimumSize(320, 320)
		if width != 0 {
			w = width
		}
		if height != 0 {
			h = height
		}
		window.SetContentSize(w, h)
	} else if present {
		window.SetMinimumSize(minWidth, minHeight)
		if saved.Height <= 0 {
			saved.Height = h
		}
		window.SetContentSize(saved.Width, saved.Height)
		if err := os.Remove(baseline); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
