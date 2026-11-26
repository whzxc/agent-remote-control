package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const frontDoorUpdateBackoff = time.Minute

var restoreRemoteConnections func(context.Context, *service) error

func superviseFrontDoor(ctx context.Context, service *service, endpoint *inProcess, path string, published object) {
	var attached generation
	update := frontDoorUpdater{}
	delay := 250 * time.Millisecond
	for ctx.Err() == nil {
		err := func() error {
			attachment, err := readFrontDoorInfo(ctx)
			if missingPrivateEndpoint(err) {
				guard, lockErr := frontDoorStartupGuard()
				if lockErr != nil {
					return lockErr
				}
				attachment, err = ensureFrontDoor(ctx, text(published, "build"))
				_ = guard.Close()
			}
			if err != nil {
				return err
			}
			if operatingSystem == "darwin" {
				next, replaceGuard, err := update.refresh(ctx, endpoint, attachment)
				if replaceGuard != nil {
					defer replaceGuard.Close()
				}
				if err != nil {
					return err
				}
				attachment = next
			}
			if attached != attachment.hello.Generation {
				published["port"], published["token"] = attachment.info["port"], attachment.info["token"]
				if err := save(path, published); err != nil {
					return err
				}
				if restoreRemoteConnections != nil {
					if err := restoreRemoteConnections(ctx, service); err != nil {
						return err
					}
				}
				attached = attachment.hello.Generation
			}
			return nil
		}()
		next := time.Second
		if err != nil && ctx.Err() == nil {
			recordLog("WARN", fmt.Sprintf("Front door reattachment: %s; retry in %d ms", err, delay.Milliseconds()), nil)
			next = delay
			delay = min(delay*2, 8*time.Second)
		} else {
			delay = 250 * time.Millisecond
		}
		timer := time.NewTimer(next)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

type frontDoorUpdater struct {
	stamp     *fileStamp
	installed string
	attempts  map[string]time.Time
}

func (u *frontDoorUpdater) refresh(ctx context.Context, endpoint *inProcess, attachment frontDoorAttachment) (frontDoorAttachment, *os.File, error) {
	guard, err := frontDoorLock("front-door-install.lock", false)
	if err != nil || guard == nil {
		return attachment, nil, err
	}
	retained := false
	defer func() {
		if !retained {
			_ = guard.Close()
		}
	}()
	source, err := runtimeBinary()
	if err != nil {
		return frontDoorAttachment{}, nil, err
	}
	stamp, err := readStamp(source)
	if err != nil || stamp == nil {
		return frontDoorAttachment{}, nil, errors.New("FRONT_DOOR_BUILD_CHANGED: installed image is unavailable")
	}
	if !stampSame(stamp, u.stamp) {
		build, err := buildID(source)
		if err != nil {
			return frontDoorAttachment{}, nil, err
		}
		u.stamp, u.installed = stamp, build
	}
	path := filepath.Join(root(), "app/front-door-update.json")
	value, _ := load(path)
	observed := obj(value)
	target, previous := u.installed, text(attachment.info, "build")
	if target == previous {
		if observed != nil && (observed["targetBuild"] != target || observed["state"] != "idle") {
			observed["targetBuild"], observed["currentBuild"], observed["state"], observed["lastOutcome"], observed["rollback"] = target, previous, "idle", "updated", false
			if err := save(path, observed); err != nil {
				return frontDoorAttachment{}, nil, err
			}
			if err := pruneFrontDoorImages(target); err != nil {
				return frontDoorAttachment{}, nil, err
			}
		}
		return attachment, nil, nil
	}
	if u.attempts == nil {
		u.attempts = make(map[string]time.Time)
	}
	maps.DeleteFunc(u.attempts, func(_ string, at time.Time) bool { return time.Since(at) >= frontDoorUpdateBackoff })
	if _, attempted := u.attempts[target]; attempted ||
		observed["targetBuild"] == target && uintOr(observed["retryAt"], 0) > uint64(time.Now().UnixMilli()) {
		return attachment, nil, nil
	}
	if !validBuildHash(previous) {
		return frontDoorAttachment{}, nil, errors.New("FRONT_DOOR_START_FAILED: The current image build is unavailable.")
	}
	u.attempts[target] = time.Now()
	state := object{"state": "staging", "currentBuild": previous, "targetBuild": target,
		"lastOutcome": observed["lastOutcome"], "rollback": false, "endedReads": 0, "outstandingWrites": 0,
		"retryAt": time.Now().Add(frontDoorUpdateBackoff).UnixMilli()}
	if err := save(path, state); err != nil {
		return frontDoorAttachment{}, nil, err
	}
	next, err := replaceFrontDoor(ctx, endpoint, source, previous, target, path, state)
	state["state"] = "idle"
	if err == nil {
		state["currentBuild"] = next.info["build"]
	} else {
		if state["rollback"] != true {
			state["lastOutcome"] = "failed"
		}
		state["lastError"] = err.Error()
	}
	if writeErr := save(path, state); writeErr != nil {
		return frontDoorAttachment{}, nil, errors.Join(err, writeErr)
	}
	if err != nil {
		return frontDoorAttachment{}, nil, err
	}
	if state["lastOutcome"] == "updated" {
		if err := pruneFrontDoorImages(target); err != nil {
			return frontDoorAttachment{}, nil, err
		}
	}
	retained = true
	return next, guard, nil
}

func replaceFrontDoor(ctx context.Context, endpoint *inProcess, source, previous, target, path string, state object) (frontDoorAttachment, error) {
	rollback := frontDoorImage(previous)
	if build, err := buildID(rollback); err != nil || build != previous {
		return frontDoorAttachment{}, errors.New("FRONT_DOOR_START_FAILED: The rollback image is unavailable.")
	}
	image, err := stageFrontDoor(source, target)
	if err != nil {
		return frontDoorAttachment{}, err
	}
	maintenance, err := endpoint.enterMaintenance()
	if err != nil {
		return frontDoorAttachment{}, err
	}
	defer maintenance.close()
	state["state"], state["endedReads"], state["outstandingWrites"] = "draining", maintenance.endedReads, maintenance.outstandingWrites()
	if err := save(path, state); err != nil {
		return frontDoorAttachment{}, err
	}
	_, drained := maintenance.drain(ctx)
	state["outstandingWrites"] = maintenance.outstandingWrites()
	if err := save(path, state); err != nil {
		return frontDoorAttachment{}, err
	}
	if drained != nil {
		return frontDoorAttachment{}, drained
	}
	state["state"] = "starting"
	if err := save(path, state); err != nil {
		return frontDoorAttachment{}, err
	}
	if err := stopFrontDoor(ctx); err != nil {
		return frontDoorAttachment{}, err
	}
	next, err := launchFrontDoor(ctx, image)
	if err == nil {
		state["lastOutcome"] = "updated"
		return next, nil
	}
	state["state"], state["lastError"], state["rollback"] = "rolling_back", err.Error(), true
	if stateErr := save(path, state); stateErr != nil {
		recordLog("WARN", "Cannot record front-door rollback: "+stateErr.Error(), nil)
	}
	// A replacement already stopped the previous owner; complete the rollback
	// even when the initiating supervision tick is canceled.
	previousInfo, restore := launchFrontDoor(context.WithoutCancel(ctx), rollback)
	if restore != nil {
		state["lastOutcome"] = "rollback_failed"
		return frontDoorAttachment{}, restore
	}
	state["lastOutcome"] = "rolled_back"
	return previousInfo, nil
}

func incompatibleFrontDoor(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), "FRONT_DOOR_PROTOCOL_MISMATCH")
}
