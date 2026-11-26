package core

import (
	"context"
	"errors"
	"path/filepath"
)

func frontDoorStatus(installed string) any {
	info, _ := load(filepath.Join(root(), "app/front-door.json"))
	var update object
	if operatingSystem == "darwin" {
		if value, err := load(filepath.Join(root(), "app/front-door-update.json")); err == nil {
			update = obj(value)
		}
		if update == nil {
			update = object{"state": "idle", "targetBuild": installed, "lastOutcome": nil, "rollback": false}
		}
		if target, ok := update["targetBuild"].(string); ok {
			installed = target
		}
	}
	if update == nil && info == nil {
		return nil
	}
	var matches any
	if build, ok := field(info, "build").(string); ok {
		matches = build == installed
	}
	result := object{"pid": field(info, "pid"), "protocol": field(info, "protocol"), "build": field(info, "build"), "installedBuild": installed, "matchesInstalledBuild": matches}
	if update != nil {
		update["currentBuild"] = result["build"]
		result["update"] = update
	}
	return result
}

func headlessStatus(ctx context.Context) (object, error) {
	build, err := processBuildID()
	if err != nil {
		return nil, err
	}
	status := object{"running": false, "stateDirectory": root(), "frontDoor": frontDoorStatus(build)}
	info, health, err := discoverLocal(ctx)
	if err != nil {
		return status, nil
	}
	if health["owner"] != "core" || health["version"] != buildVersion || health["build"] != build {
		return nil, errors.New("CORE_BUILD_MISMATCH: Close other local entry points. Reload Desktop and CLI from the same build.")
	}
	status["running"] = true
	for _, field := range []string{"pid", "daemon", "version"} {
		status[field] = info[field]
	}
	return status, nil
}
