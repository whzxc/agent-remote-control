package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"

	"github.com/egoist/mygo"
)

// Command handles the native bridge for the local ARC renderer.
func (s *DesktopService) Command(ctx context.Context, command string, raw json.RawMessage) (any, error) {
	var args object
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&args); err != nil {
		return nil, err
	}
	window := mygo.CallerWindow(ctx)
	isMain := false
	if err := onMain(ctx, func() error {
		isMain = window != nil && window == s.window
		return nil
	}); err != nil {
		return nil, err
	}
	if !isMain {
		return nil, errors.New("invalid window")
	}
	switch command {
	case "service_request":
		return s.request(ctx, stringAt(args, "route"), stringAt(args, "method"), objectValue(args["body"]))
	case "open_external":
		target := stringAt(args, "url")
		parsed, err := url.Parse(target)
		if err != nil || parsed == nil || !slices.Contains([]string{"https", "http", "mailto", "tel", "codex", "vscode", "vscode-insiders", "cursor", "zed"}, parsed.Scheme) {
			return nil, errors.New("unsupported external URL")
		}
		return nil, mygo.Shell.OpenExternal(target)
	case "clipboard_write":
		mygo.Clipboard.WriteText(stringAt(args, "text"))
		return nil, nil
	case "set_ui_locale":
		return nil, s.setLocale(ctx, stringAt(args, "locale"), stringAt(args, "resolvedLocale"))
	case "check_update":
		return s.checkUpdate(ctx)
	case "download_update":
		return nil, s.downloadUpdate(ctx, window, intAt(args, "rid"))
	case "close_update":
		return nil, s.closeUpdate(intAt(args, "rid"))
	case "install_update":
		return nil, s.installUpdate(ctx, intAt(args, "rid"))
	case "snapshot_ready":
		s.snapshot.acknowledge(stringAt(args, "id"), args["model"], stringAt(args, "error"))
		return nil, nil
	case "window_visible":
		return window.IsVisible(), nil
	case "window_minimized":
		return window.IsMinimized(), nil
	case "window_fullscreen":
		return window.IsFullScreen(), nil
	case "window_theme":
		return windowTheme(), nil
	case "window_set_fullscreen":
		value, _ := args["value"].(bool)
		window.SetFullScreen(value)
		return nil, nil
	case "main_window_ready":
		return nil, onMain(ctx, func() error { return s.windowReady(window) })
	case "release_main_window":
		return nil, onMain(ctx, func() error { return s.releaseWindow(window) })
	case "apply_env_window":
		return nil, onMain(ctx, func() error { return applyEnvWindow(window, args) })
	case "set_windows_appearance":
		dark, _ := args["dark"].(bool)
		return nil, onMain(ctx, func() error { return s.setWindowsAppearance(window, dark) })
	default:
		return nil, errors.New("UNSUPPORTED_OPERATION")
	}
}

func intAt(body object, key string) int {
	return max(0, number(body[key]))
}
