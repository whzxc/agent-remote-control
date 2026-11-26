package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

type receiptStore struct {
	base        string
	counterpart string
}

func coreReceiptStore() receiptStore {
	return receiptStore{root(), filepath.Join(root(), "agents/requests")}
}
func agentReceiptStore() receiptStore {
	return receiptStore{filepath.Join(root(), "agents/requests"), root()}
}
func (s receiptStore) path(request string) (string, error) {
	if _, err := uuid.Parse(request); err != nil {
		return "", errors.New("INVALID_REQUEST_ID")
	}
	return filepath.Join(s.base, request+".json"), nil
}

var observeReceiptUnconfirmed []func(object)
var onReceiptCheckpoint []func(string, object) error

func normalizeReceipt(raw any, session string) (object, error) {
	row := obj(raw)
	if row == nil {
		return nil, errors.New("INVALID_RECEIPT")
	}
	before := row["state"]
	ownerLive := row["backendSession"] == session
	row = projectReceipt(row, ownerLive, time.Now().UnixMilli())
	if row["state"] == "unconfirmed" && before != "unconfirmed" {
		for _, observe := range observeReceiptUnconfirmed {
			observe(row)
		}
	}
	return row, nil
}
func (s receiptStore) read(request, session string) (object, error) {
	path, err := s.path(request)
	if err != nil {
		return nil, err
	}
	value, err := cachedLoad(path)
	if err != nil {
		return nil, err
	}
	return normalizeReceipt(value, session)
}
func (s receiptStore) projected(ctx context.Context, request, session string) (object, error) {
	path, err := s.path(request)
	if err != nil {
		return nil, err
	}
	row, err := readReceiptProjection(ctx, path)
	if err != nil {
		return nil, err
	}
	return normalizeReceipt(row, session)
}
func (s receiptStore) replay(ctx context.Context, request, digest, session string) (object, error) {
	path, err := s.path(request)
	if err != nil {
		return nil, err
	}
	if s.counterpart != "" {
		if _, err := os.Stat(filepath.Join(s.counterpart, filepath.Base(path))); err == nil {
			return nil, errors.New("REQUEST_ID_CONFLICT")
		}
	}
	row, err := s.read(request, session)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if field(row["origin"], "sourceId") != currentOrigin(ctx)["sourceId"] || row["digest"] != digest {
		return nil, errors.New("REQUEST_ID_CONFLICT")
	}
	row["replayed"] = true
	return row, nil
}
func (s receiptStore) reserve(ctx context.Context, row object) error {
	path, err := s.path(text(row, "requestId"))
	if err != nil {
		return err
	}
	return indexChange(ctx, path, func() (any, error) {
		before, err := readStamp(s.base)
		if err != nil {
			return nil, err
		}
		if err := platform.PrivateDir(s.base); err != nil {
			return nil, err
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, fmt.Errorf("RECEIPT_RESERVATION_FAILED: File operation failed at reserve-receipt for %s: %w", path, err)
		}
		_, err = file.WriteString(wire(row))
		if err == nil {
			err = file.Sync()
		}
		if err := errors.Join(err, file.Close()); err != nil {
			return nil, err
		}
		markCachedFileChanged(path, before)
		return receiptSummary(row)
	})
}
func (s receiptStore) checkpoint(ctx context.Context, row object) error {
	for _, key := range []string{"submissionState", "executionState", "progressStalled", "phaseAgeMs"} {
		delete(row, key)
	}
	path, err := s.path(text(row, "requestId"))
	if err != nil {
		return err
	}
	if previous, err := cachedLoad(path); err == nil {
		previousFields := maps.Clone(obj(previous))
		next := maps.Clone(row)
		for _, fields := range []object{previousFields, next} {
			delete(fields, "updatedAt")
			delete(fields, "coordinationPending")
		}
		if wire(previousFields) == wire(next) {
			clear(row)
			maps.Copy(row, obj(previous))
			return nil
		}
	}
	row["updatedAt"] = now()
	return indexChange(ctx, path, func() (any, error) {
		for _, observe := range onReceiptCheckpoint {
			if err := observe(path, row); err != nil {
				return nil, err
			}
		}
		if err := save(path, row); err != nil {
			return nil, err
		}
		return receiptSummary(row)
	})
}
func (s receiptStore) abandon(ctx context.Context, request string) error {
	path, err := s.path(request)
	if err != nil {
		return err
	}
	value, err := cachedLoad(path)
	if err != nil {
		return err
	}
	row := obj(value)
	switch readReceiptState(text(row, "state"), true) {
	case receiptReserved, receiptExecuting:
		return s.checkpoint(ctx, projectReceipt(row, false, time.Now().UnixMilli()))
	default:
		return nil
	}
}

type receiptExecutionOwner struct {
	store   receiptStore
	request string
}

func (s receiptStore) begin(ctx context.Context, row object) (receiptExecutionOwner, error) {
	owner := receiptExecutionOwner{s, text(row, "requestId")}
	if row["state"] != "reserved" {
		return owner, errors.New("SUBMISSION_UNCONFIRMED: read the original receipt; execution cannot be resubmitted")
	}
	row["state"] = "executing"
	return owner, s.checkpoint(ctx, row)
}
func (o receiptExecutionOwner) close() {
	if err := o.store.abandon(context.Background(), o.request); err != nil {
		recordLog("ERROR", "Cannot record receipt owner loss: "+err.Error(), nil)
	}
}

type receiptExecutionResult struct {
	value object
	err   error
}

func (s receiptStore) wait(ctx context.Context, request, session string, timeout time.Duration, result <-chan receiptExecutionResult) (object, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return s.read(request, session)
	case response, ok := <-result:
		if ok {
			return response.value, response.err
		}
		if err := s.abandon(ctx, request); err != nil {
			return nil, err
		}
		return s.read(request, session)
	}
}

var requestLocks struct {
	sync.Mutex
	keys map[string]*indexOwnerLock
}

func lockReceipt(request string) func() {
	requestLocks.Lock()
	if requestLocks.keys == nil {
		requestLocks.keys = map[string]*indexOwnerLock{}
	}
	entry := requestLocks.keys[request]
	if entry == nil {
		entry = &indexOwnerLock{}
		requestLocks.keys[request] = entry
	}
	entry.users++
	requestLocks.Unlock()
	entry.Lock()
	return func() {
		entry.Unlock()
		requestLocks.Lock()
		entry.users--
		if entry.users == 0 {
			delete(requestLocks.keys, request)
		}
		requestLocks.Unlock()
	}
}
func readControlReceipt(ctx context.Context, request operationRequest) (any, error) {
	name := text(request.args, "requestId")
	switch text(request.args, "action") {
	case "", "read":
	default:
		if decideControlReceipt != nil {
			return decideControlReceipt(ctx, request)
		}
		return nil, errors.New(PortPending)
	}
	session := text(request.service.metadata, "instance")
	for _, store := range []receiptStore{coreReceiptStore(), agentReceiptStore()} {
		result, err := store.read(name, session)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return result, nil
	}
	return object{"requestId": name, "state": "not-found", "executionState": "no-reservation"}, nil
}
func init() {
	registerOperation("receipt", readControlReceipt, nil)
	core := func() string { return coreReceiptStore().base }
	agents := func() string { return agentReceiptStore().base }
	registerStartupIndex(core, 10, func(ctx context.Context, _ *service) error {
		return seedReceiptIndex(ctx, core())
	}, closeReceiptIndex)
	registerStartupIndex(agents, 20, func(ctx context.Context, _ *service) error {
		return seedReceiptIndex(ctx, agents())
	}, closeReceiptIndex)
}
