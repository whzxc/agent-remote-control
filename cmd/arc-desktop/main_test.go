package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

type fakeAppLifecycle struct {
	allClosed      func()
	beforeQuit     func(*mygo.QuitEvent)
	quitCanceled   func()
	secondInstance func([]string, string)
	activate       func(bool)
	openURL        func(string)
	notification   func(string)
}

func (f *fakeAppLifecycle) OnWindowAllClosed(fn func()) func() {
	f.allClosed = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnBeforeQuit(fn func(*mygo.QuitEvent)) func() {
	f.beforeQuit = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnQuitCanceled(fn func()) func() {
	f.quitCanceled = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnSecondInstance(fn func([]string, string)) func() {
	f.secondInstance = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnActivate(fn func(bool)) func() {
	f.activate = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnOpenURL(fn func(string)) func() {
	f.openURL = fn
	return func() {}
}
func (f *fakeAppLifecycle) OnNotificationClick(fn func(string)) func() {
	f.notification = fn
	return func() {}
}

func TestDesktopLifecycleKeepsAppRunningWithoutWindows(t *testing.T) {
	// Recurring bug class: lifecycle retiring the last hidden window must not quit ARC, and second-instance handling must not duplicate OnOpenURL delivery.
	hooks := &fakeAppLifecycle{}
	service := &DesktopService{}
	var shown bool
	var deliveredAction *desktopMessage
	registerDesktopLifecycle(hooks, service, func(action *desktopMessage) {
		shown = true
		deliveredAction = action
	})
	if hooks.allClosed == nil {
		t.Fatal("OnWindowAllClosed listener was not registered; destroying the hidden window would quit ARC")
	}
	if hooks.openURL == nil || hooks.notification == nil {
		t.Fatal("OnOpenURL and OnNotificationClick listeners must both be registered")
	}

	hooks.beforeQuit(&mygo.QuitEvent{})
	if !service.quitting {
		t.Fatal("OnBeforeQuit did not mark service as quitting")
	}
	hooks.quitCanceled()
	if service.quitting {
		t.Fatal("OnQuitCanceled did not clear quitting state")
	}

	hooks.secondInstance([]string{linkScheme + "://permissions"}, "")
	if !shown {
		t.Fatal("OnSecondInstance did not surface the main window")
	}
	if deliveredAction != nil {
		t.Fatalf("OnSecondInstance dispatched deep-link action %+v instead of leaving URL delivery to OnOpenURL", deliveredAction)
	}

	shown = false
	service.opened = true
	hooks.activate(true)
	if shown {
		t.Fatal("OnActivate surfaced the window when a visible window already existed")
	}
	hooks.activate(false)
	if !shown {
		t.Fatal("OnActivate did not surface the window when no visible window existed")
	}
}

func TestStartupFailureDialogPolicyAndDetail(t *testing.T) {
	// Contract: interactive startup failures show a native error dialog with actionable detail while supervised dev and fixture runs stay non-interactive.
	if !shouldShowStartupDialog(false, false) {
		t.Fatal("interactive launch should show the startup error dialog")
	}
	if shouldShowStartupDialog(true, false) {
		t.Fatal("supervised development launch must not block on a modal dialog")
	}
	if shouldShowStartupDialog(false, true) {
		t.Fatal("update fixture launch must not block on a modal dialog")
	}
	detail := startupErrorDetail(errors.New("Core runtime unavailable"))
	if !strings.Contains(detail, "Core runtime unavailable") || !strings.Contains(detail, appName) {
		t.Fatalf("startupErrorDetail = %q, want both the error text and app name %q", detail, appName)
	}
}
