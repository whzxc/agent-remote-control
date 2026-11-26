package main

import (
	"context"
	"errors"
	"runtime"

	"github.com/egoist/mygo"
)

func permissionStatus(ctx context.Context) object {
	state := "not-applicable"
	if runtime.GOOS == "darwin" {
		var err error
		state, err = notificationPermission(ctx, false)
		if err != nil {
			state = "unknown"
		}
	}
	return object{"items": []object{{"id": "notifications", "state": state, "process": "Desktop"}, autostartReadiness(ctx)}}
}

func notify(ctx context.Context, title, body, id string) error {
	if runtime.GOOS == "darwin" {
		state, err := notificationPermission(ctx, false)
		if err != nil {
			return err
		}
		if state != "granted" {
			return errors.New("NOTIFICATION_PERMISSION_REQUIRED")
		}
	}
	return mygo.NewNotification(mygo.NotificationOptions{ID: id, Title: title, Body: body}).ShowContext(ctx)
}
