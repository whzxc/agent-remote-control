package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func nativeAgentResource(ctx context.Context, s *service, body object) (any, error) {
	id, agent := text(body, "id"), text(body, "agent")
	if _, err := nativeAgentTaskPath(id); err != nil {
		return nil, err
	}
	if !nativeAgentReadAllowed(ctx, agent, id) {
		return nil, errors.New("TASK_NOT_FOUND")
	}
	var cwd string
	task, err := s.nativeAgentTask(agent, id)
	switch {
	case err == nil:
		cwd = text(task, "cwd")
	case err.Error() != "TASK_NOT_FOUND":
		return nil, err
	case agent == "codex":
		rpc, err := s.codexUtility(ctx)
		if err != nil {
			return nil, err
		}
		metadata, err := rpc.call(ctx, "thread/read", object{"threadId": id, "includeTurns": false}, 5*time.Second)
		if err != nil {
			return nil, err
		}
		if field(field(metadata, "thread"), "id") != id {
			return nil, errors.New("native-thread-id-mismatch")
		}
		cwd = text(field(metadata, "thread"), "cwd")
	default:
		return nil, errors.New("TASK_NOT_FOUND")
	}
	if cwd == "" {
		return nil, errors.New("TASK_PROJECT_UNAVAILABLE")
	}
	path, err := nativeImagePath(text(body, "path"), id, cwd)
	if err != nil {
		return nil, err
	}
	if body["action"] == "image" {
		data, err := projectReadBytes("", path)
		if err != nil {
			return nil, err
		}
		prepared, err := prepareNativeImage(data, path, nil)
		if err != nil {
			return nil, err
		}
		return object{"src": "data:" + text(prepared.content, "mimeType") + ";base64," + text(prepared.content, "data")}, nil
	}
	switch operatingSystem {
	case "darwin":
		_, err = commandOutput(ctx, "/usr/bin/open", "-R", path)
	case "windows":
		_, err = commandOutput(ctx, "explorer.exe", "/select,"+path)
	default:
		if _, display := os.LookupEnv("DISPLAY"); !display {
			if _, wayland := os.LookupEnv("WAYLAND_DISPLAY"); !wayland {
				return nil, errors.New("FILE_REVEAL_UNAVAILABLE: this host has no graphical session.")
			}
		}
		_, err = commandOutput(ctx, "xdg-open", filepath.Dir(path))
	}
	if err != nil {
		return nil, err
	}
	return object{"revealed": true}, nil
}

func init() {
	registerOperation("task_resource", func(ctx context.Context, request operationRequest) (any, error) {
		return nativeAgentResource(ctx, request.service, request.args)
	}, nil)
	registerRoute(http.MethodPost, "agents/resources", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return nativeAgentResource(ctx, s, body)
	})
}
