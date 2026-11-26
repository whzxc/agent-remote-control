package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func nativeChangeBaselinePath(thread, turn string) string {
	return filepath.Join(root(), "changes", hash([]byte(thread)), hash([]byte(turn))+".json")
}

func captureNativeChangeBaseline(ctx context.Context, cwd string) object {
	unavailable := func(err error) object {
		return object{"cwd": cwd, "unavailable": err.Error(), "capturedAt": now()}
	}
	if !filepath.IsAbs(cwd) {
		return unavailable(errors.New("workspace unavailable"))
	}
	git := func(args ...string) (string, error) {
		return projectGit(ctx, cwd, args...)
	}
	dir, err := git("rev-parse", "--show-toplevel")
	if err != nil {
		return unavailable(err)
	}
	status, err := git("status", "--porcelain=v1", "-z")
	if err != nil {
		return unavailable(err)
	}
	head, _ := git("rev-parse", "--verify", "HEAD")
	branch, _ := git("symbolic-ref", "-q", "HEAD")
	common, _ := git("rev-parse", "--path-format=absolute", "--git-common-dir")
	var commonDir any
	if name, err := filepath.EvalSymlinks(strings.TrimSpace(common)); err == nil && common != "" {
		commonDir = name
	}
	return object{"cwd": cwd, "root": strings.TrimSpace(dir), "head": dispatchFirstString(strings.TrimSpace(head)),
		"ref": dispatchFirstString(strings.TrimSpace(branch)), "commonDir": commonDir, "dirty": status != "",
		"capturedAt": now(), "source": "before-turn-submission"}
}

func recordNativeChangeBaseline(thread, turn string, baseline object) error {
	if thread == "" || turn == "" || baseline == nil {
		return nil
	}
	path := nativeChangeBaselinePath(thread, turn)
	unlock := lockReceipt(path)
	defer unlock()
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	row := clone(baseline)
	row["threadId"], row["turnId"] = thread, turn
	if err := save(path, row); err != nil {
		return err
	}
	observeCoordinationBaseline(row)
	return nil
}
