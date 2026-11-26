package main

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type tauriWindowState struct {
	Width      int  `json:"width"`
	Height     int  `json:"height"`
	X          int  `json:"x"`
	Y          int  `json:"y"`
	PreviousX  int  `json:"prev_x"`
	PreviousY  int  `json:"prev_y"`
	Maximized  bool `json:"maximized"`
	Visible    bool `json:"visible"`
	Decorated  bool `json:"decorated"`
	Fullscreen bool `json:"fullscreen"`
}

type windowStateStore struct{}

func (windowStateStore) path() string {
	dir, err := os.UserConfigDir()
	if bundleID != productionID || err != nil {
		return filepath.Join(core.DesktopStateDir(), "app", ".window-state.json")
	}
	return filepath.Join(dir, bundleID, ".window-state.json")
}

func windowScale(x, y int) float64 {
	displays := mygo.Screen.Displays()
	for _, d := range displays {
		r, scale := d.Bounds, d.ScaleFactor
		if scale > 0 && float64(x) >= float64(r.X)*scale && float64(y) >= float64(r.Y)*scale &&
			float64(x) < float64(r.X+r.Width)*scale && float64(y) < float64(r.Y+r.Height)*scale {
			return scale
		}
	}
	if len(displays) > 0 && displays[0].ScaleFactor > 0 {
		return displays[0].ScaleFactor
	}
	return 1
}

func (store windowStateStore) LoadWindowStates() (map[string]mygo.WindowState, error) {
	var stored map[string]tauriWindowState
	if err := readJSON(store.path(), &stored); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	states := map[string]mygo.WindowState{}
	for key, state := range stored {
		x, y := state.X, state.Y
		if state.Maximized {
			x, y = state.PreviousX, state.PreviousY
		}
		scale := windowScale(x, y)
		logical := func(value int) int { return int(math.Round(float64(value) / scale)) }
		states[key] = mygo.WindowState{
			X: logical(x), Y: logical(y), Width: logical(state.Width), Height: logical(state.Height),
			PixelX: x, PixelY: y, PixelWidth: state.Width, PixelHeight: state.Height,
			Maximized: state.Maximized, FullScreen: state.Fullscreen,
		}
	}
	return states, nil
}

func (store windowStateStore) SaveWindowStates(states map[string]mygo.WindowState) error {
	var previous map[string]tauriWindowState
	if err := readJSON(store.path(), &previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		previous = nil
	}
	stored := make(map[string]tauriWindowState, len(states))
	for key, state := range states {
		x, y, w, h := state.PixelX, state.PixelY, state.PixelWidth, state.PixelHeight
		if runtime.GOOS != "windows" || w <= 0 || h <= 0 {
			r := mygo.Rectangle{X: state.X, Y: state.Y, Width: state.Width, Height: state.Height}
			scale := mygo.Screen.DisplayMatching(r).ScaleFactor
			if scale <= 0 {
				scale = 1
			}
			pixels := func(value int) int { return int(math.Round(float64(value) * scale)) }
			x, y, w, h = pixels(r.X), pixels(r.Y), pixels(r.Width), pixels(r.Height)
		}
		visibility, decorations := true, true
		if old, ok := previous[key]; ok {
			visibility, decorations = old.Visible, old.Decorated
		}
		stored[key] = tauriWindowState{w, h, x, y, x, y, state.Maximized, visibility, decorations, state.FullScreen}
	}
	return writeJSON(store.path(), stored)
}
