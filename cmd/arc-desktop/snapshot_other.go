//go:build !darwin

package main

import (
	"context"
	"errors"

	"github.com/egoist/mygo"
)

func capturePNG(context.Context, *mygo.Window) ([]byte, error) {
	return nil, errors.New("WebView PNG capture is supported on macOS only")
}
