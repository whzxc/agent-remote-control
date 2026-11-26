//go:build !darwin && !windows

package main

import (
	"context"
	"errors"
)

func autostartEnabled(context.Context) bool    { return false }
func setAutostart(context.Context, bool) error { return errors.New("Login startup is unsupported") }
func autostartReadiness(context.Context) object {
	return object{"id": "login-start", "process": "Desktop", "state": "not-applicable"}
}
