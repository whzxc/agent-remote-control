package main

import (
	"context"
	"errors"
	"runtime"
	"time"

	"github.com/egoist/mygo"
)

const (
	initialWidth  = 840
	initialHeight = 578
	minWidth      = 800
	minHeight     = 578
)

type desktopMessage struct {
	Name    string `json:"name"`
	Payload any    `json:"payload"`
}

var DesktopEvent = mygo.NewEvent[desktopMessage]("arc:desktop")

func (s *DesktopService) ensureWindow() *mygo.Window {
	if s.window != nil {
		return s.window
	}
	window := mygo.NewWindow(mygo.WindowOptions{
		Title: appName, Width: initialWidth, Height: initialHeight, MinWidth: minWidth, MinHeight: minHeight,
		UseContentSize: true, Hidden: true, URL: "/", Transparent: true,
		TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 38, BackgroundColor: "#0000", StateKey: "main",
		HideWindowButtons: runtime.GOOS == "windows",
	})
	s.window = window
	window.Page().OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	installWindowsFrame(window)
	window.OnClose(func(event *mygo.CloseEvent) {
		if !s.quitting {
			event.PreventDefault()
			window.Hide()
		}
	})
	window.OnClosed(func() {
		s.window = nil
		s.ready = false
		s.pending = nil
	})
	window.OnFocus(func() { s.emit("window:focus", true) })
	window.OnBlur(func() { s.emit("window:focus", false) })
	window.OnResize(func() { s.emit("window:resize", nil) })
	window.OnEnterFullScreen(func() { s.emit("window:resize", nil) })
	window.OnLeaveFullScreen(func() { s.emit("window:resize", nil) })
	off := mygo.Theme.OnUpdated(func() { s.emit("window:theme", windowTheme()) })
	window.OnClosed(off)
	return window
}

func (s *DesktopService) show(action *desktopMessage) {
	if !mygo.App.IsReady() {
		mygo.App.WhenReady(func() { s.show(action) })
		return
	}
	window := s.ensureWindow()
	if window.IsMinimized() {
		window.Restore()
	}
	window.Show()
	window.Focus()
	s.opened = true
	if action != nil {
		if s.ready {
			s.emit(action.Name, action.Payload)
		} else {
			s.pending = action
		}
	}
}

func (s *DesktopService) emit(name string, value any) {
	if s.window != nil && s.ready {
		logError(DesktopEvent.Emit(s.window, desktopMessage{name, value}))
	}
}

func (s *DesktopService) windowReady(window *mygo.Window) error {
	if window == nil || s.window != window {
		return errors.New("invalid window")
	}
	s.ready = true
	if pending := s.pending; pending != nil {
		s.pending = nil
		s.emit(pending.Name, pending.Payload)
	}
	return nil
}

func (s *DesktopService) releaseWindow(window *mygo.Window) error {
	if window == nil || s.window != window {
		return errors.New("invalid window")
	}
	if !window.IsVisible() && !s.closing.Load() {
		window.Destroy()
	}
	return nil
}

func windowTheme() string {
	if mygo.Theme.IsDark() {
		return "dark"
	}
	return "light"
}

func onMain(ctx context.Context, fn func() error) error {
	done := make(chan error, 1)
	go mygo.RunOnMain(func() {
		if ctx.Err() == nil {
			done <- fn()
		}
	})
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *DesktopService) observeCore(ctx context.Context) {
	go s.observeProjection(ctx, "subscriptions", "subscriptions:changed", 2*time.Second)
	go s.observeProjection(ctx, "agents/activity", "agents:activity", time.Second)
	go s.observeTray(ctx)
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mygo.RunOnMain(func() {
				if s.window == nil && !s.closing.Load() {
					s.ensureWindow()
				}
			})
		}
	}
}

func (s *DesktopService) setWindowsAppearance(window *mygo.Window, dark bool) error {
	if window == nil || s.window != window || runtime.GOOS != "windows" {
		return errors.New("invalid window")
	}
	return applyWindowsFrame(window, dark)
}
