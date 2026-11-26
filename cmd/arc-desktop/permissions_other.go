//go:build !darwin

package main

import (
	"context"
	"errors"
)

func notificationPermission(context.Context, bool) (string, error) { return "not-applicable", nil }
func requestPermission(context.Context, string) (any, error) {
	return nil, errors.New("PERMISSION_NOT_APPLICABLE")
}
