package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

var nativeScreenOperations sync.Mutex

func callNativeScreen(ctx context.Context, args object) (object, error) {
	if operatingSystem != "darwin" {
		return nil, errors.New("SCREEN_UNSUPPORTED: screen supports macOS only.")
	}

	// Hold the operation lock through helper exit and focus restoration,
	// including when the caller disconnects while the action is underway.
	nativeScreenOperations.Lock()
	defer nativeScreenOperations.Unlock()
	ctx = context.WithoutCancel(ctx)
	executable, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	command := nativeCommand(ctx, filepath.Join(filepath.Dir(executable), "arc-screen"))
	command.Stdin = strings.NewReader(wire(args))
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := startOwnedChild(command); err != nil {
		return nil, fmt.Errorf("SCREEN_HELPER_UNAVAILABLE: %w", err)
	}
	if err := command.Wait(); err != nil {
		return nil, fmt.Errorf("SCREEN_HELPER_FAILED: %s %s", err, decodeCommandOutput(stderr.Bytes()))
	}
	var response object
	if err := decodeObject(stdout.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("SCREEN_HELPER_INVALID_JSON: %w", err)
	}
	if response["ok"] != true {
		if failure := obj(response["error"]); failure != nil {
			return nil, errors.New(wire(failure))
		}
		return nil, errors.New(text(response, "error"))
	}
	result := obj(response["result"])
	if args["action"] == "capture" {
		content, err := prepareNativeScreenImage(result, args)
		if err != nil {
			return nil, err
		}
		attachNativeImages(result, []any{content})
	} else if capture := obj(result["capture"]); capture != nil {
		content, err := prepareNativeScreenImage(capture, obj(field(args["after"], "capture")))
		if err != nil {
			result["captureError"] = err.Error()
		} else {
			attachNativeImages(result, []any{content})
		}
	}
	return result, nil
}

func prepareNativeScreenImage(capture, args object) (object, error) {
	value, exists := capture["imageBase64"]
	delete(capture, "imageBase64")
	if !exists {
		return nil, errors.New("SCREEN_IMAGE_MISSING")
	}
	encoded, ok := value.(string)
	if !ok {
		return nil, errors.New("SCREEN_IMAGE_INVALID")
	}
	if len(encoded) > nativeImageMaxInput*4/3+4 {
		return nil, errors.New("IMAGE_INPUT_TOO_LARGE: limit=16777216")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	source := "screen/window-" + wire(field(capture["window"], "windowId")) + ".png"
	image, err := prepareNativeImage(data, source, args)
	if err != nil {
		return nil, err
	}
	capture["image"] = image.metadata
	return image.content, nil
}

func init() {
	registerOperation("screen", func(ctx context.Context, r operationRequest) (any, error) {
		return callNativeScreen(ctx, r.args)
	}, nil)
	permissionScreenStatus = func(ctx context.Context) (object, error) {
		return callNativeScreen(ctx, object{"action": "status"})
	}
	permissionClaudeStatus = func(ctx context.Context) (bool, *bool) {
		if discoverAgentExecutable("claude") == "" {
			return false, nil
		}
		identity, err := readClaudeIdentity(ctx, "")
		loggedIn, known := identity["loggedIn"].(bool)
		if err != nil || !known {
			return true, nil
		}
		return true, &loggedIn
	}
}
