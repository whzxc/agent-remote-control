package main

import (
	"context"
	"errors"
	"time"

	"github.com/ebitengine/purego/objc"
	"github.com/whzxc/agent-remote-control/internal/core"
)

func notificationPermission(ctx context.Context, request bool) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result := make(chan string, 1)
	if err := onMain(ctx, func() error {
		center := objc.ID(objc.GetClass("UNUserNotificationCenter")).Send(objc.RegisterName("currentNotificationCenter"))
		if center == 0 {
			return errors.New("Notification center unavailable")
		}
		var callback objc.Block
		if request {
			callback = objc.NewBlock(func(_ objc.Block, granted bool, _ objc.ID) {
				state := "missing"
				if granted {
					state = "granted"
				}
				result <- state
			})
			center.Send(objc.RegisterName("requestAuthorizationWithOptions:completionHandler:"), uint(7), callback)
		} else {
			callback = objc.NewBlock(func(_ objc.Block, settings objc.ID) {
				state := "unknown"
				switch objc.Send[int](settings, objc.RegisterName("authorizationStatus")) {
				case 2, 3, 4:
					state = "granted"
				case 0, 1:
					state = "missing"
				}
				result <- state
			})
			center.Send(objc.RegisterName("getNotificationSettingsWithCompletionHandler:"), callback)
		}
		callback.Release()
		return nil
	}); err != nil {
		return "", err
	}
	select {
	case state := <-result:
		return state, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func requestPermission(ctx context.Context, id string) (any, error) {
	panel := map[string]string{
		"accessibility":            "com.apple.preference.security?Privacy_Accessibility",
		"screen-recording":         "com.apple.preference.security?Privacy_ScreenCapture",
		"full-disk-access":         "com.apple.preference.security?Privacy_AllFiles",
		"command-full-disk-access": "com.apple.preference.security?Privacy_AllFiles",
		"notifications":            "com.apple.Notifications-Settings.extension",
		"login-start":              "com.apple.LoginItems-Settings.extension",
	}[id]
	if panel == "" {
		return nil, errors.New("UNKNOWN_PERMISSION")
	}
	switch id {
	case "notifications":
		if _, err := notificationPermission(ctx, true); err != nil {
			return nil, err
		}
	case "accessibility", "screen-recording":
		if err := core.RequestDesktopScreenPermission(ctx, id); err != nil {
			return nil, err
		}
	}
	if err := runCommand(ctx, "/usr/bin/open", "x-apple.systempreferences:"+panel); err != nil {
		return nil, err
	}
	return object{"requested": true}, nil
}
