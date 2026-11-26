package core

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

var deviceTransferSession = sync.OnceValue(id)

type deviceTransferJob struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func deviceTransferReceipt(_ context.Context, r operationRequest) (any, bool, error) {
	request := text(r.args, "requestId")
	store := coreReceiptStore()
	path, err := store.path(request)
	if err != nil {
		return nil, true, err
	}
	raw, err := cachedLoad(path)
	if errors.Is(err, os.ErrNotExist) || err == nil && field(raw, "operation") != "device_transfer" {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	if action := text(r.args, "action"); action != "" && action != "read" {
		return nil, true, errors.New("INVALID_ARGUMENT: use device_transfer action:cancel or action:resume")
	}
	value, err := store.read(request, deviceTransferSession())
	return value, true, err
}

func transferPlan(args object) object {
	copy := maps.Clone(args)
	for _, key := range []string{"requestId", "waitMs", "action"} {
		delete(copy, key)
	}
	return copy
}

func (c *deviceController) transfer(ctx context.Context, args object) (any, error) {
	action := text(args, "action")
	if action == "" {
		action = "start"
	}
	request := text(args, "requestId")
	if request == "" {
		request = id()
	}
	if _, err := uuid.Parse(request); err != nil {
		return nil, errors.New("INVALID_REQUEST_ID: requestId must be a UUID")
	}
	unlock := lockReceipt(request)
	defer unlock()
	store := coreReceiptStore()
	counterpart, _ := agentReceiptStore().path(request)
	if _, err := os.Stat(counterpart); err == nil {
		return nil, errors.New("REQUEST_ID_CONFLICT: requestId belongs to another operation")
	}
	row, err := store.read(request, deviceTransferSession())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if row != nil && row["operation"] != "device_transfer" {
		return nil, errors.New("REQUEST_ID_CONFLICT: transfer belongs to another operation or source")
	}
	if action == "read" {
		if row == nil {
			return nil, errors.New("RECEIPT_NOT_FOUND")
		}
		return row, nil
	}
	origin := currentOrigin(ctx)
	if row != nil && field(row["origin"], "sourceId") != origin["sourceId"] {
		return nil, errors.New("REQUEST_ID_CONFLICT: transfer mutation belongs to another source")
	}
	var link *deviceTransferLink
	var release func()
	if row == nil {
		if action != "start" {
			return nil, errors.New("RECEIPT_NOT_FOUND")
		}
		from, to := args["from"], args["to"]
		originDevice, fromPeer := field(from, "device").(string)
		targetDevice, toPeer := field(to, "device").(string)
		if fromPeer == toPeer {
			return nil, errors.New("INVALID_ARGUMENT: exactly one side must name a member device")
		}
		if text(from, "path") == "" || text(to, "path") == "" {
			return nil, errors.New("INVALID_PATH: both endpoints require a path")
		}
		device := originDevice
		if toPeer {
			device = targetDevice
		}
		link, release, err = c.admitTransfer(ctx, device, true)
		if err != nil {
			return nil, err
		}
		row = object{"requestId": request, "operation": "device_transfer", "state": "reserved",
			"backendSession": deviceTransferSession(), "origin": origin, "createdAt": now(), "plan": transferPlan(args),
			"device": link.member.peer.DeviceID, "progress": object{"bytes": 0, "total": nil, "path": field(to, "path"), "rate": 0},
			"next": object{"via": "act", "op": "receipt", "args": object{"action": "read", "requestId": request}},
		}
		if err := store.reserve(ctx, row); err != nil {
			release()
			return nil, err
		}
		if err := store.checkpoint(ctx, row); err != nil {
			release()
			return nil, err
		}
	} else if action == "start" {
		if wire(row["plan"]) != wire(transferPlan(args)) {
			return nil, errors.New("REQUEST_ID_CONFLICT: transfer parameters differ; read the original receipt")
		}
		return row, nil
	}
	if row["state"] == "completed" || row["state"] == "cancelled" {
		return row, nil
	}
	if action == "cancel" {
		return c.cancelTransfer(ctx, row, store)
	}
	if action != "start" && action != "resume" {
		return nil, errors.New("INVALID_ARGUMENT: use start, read, resume or cancel")
	}
	if _, exists := c.transferJobs.Load(request); exists {
		return row, nil
	}
	if link == nil {
		link, release, err = c.admitTransfer(ctx, text(row, "device"), true)
		if err != nil {
			return nil, err
		}
	}
	row["state"], row["backendSession"], row["error"] = "reserved", deviceTransferSession(), nil
	owner, err := store.begin(ctx, row)
	if err != nil {
		release()
		return nil, err
	}
	workerRow := clone(row)
	wait, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stopCore, stopMember := context.AfterFunc(c.ctx, cancel), context.AfterFunc(link.member.ctx, cancel)
	job := &deviceTransferJob{cancel: cancel, done: make(chan struct{})}
	c.transferJobs.Store(request, job)
	go func() {
		defer close(job.done)
		defer c.transferJobs.CompareAndDelete(request, job)
		defer release()
		defer owner.close()
		defer cancel()
		defer stopCore()
		defer stopMember()
		value, err := c.runTransfer(wait, link, store, workerRow)
		if wait.Err() != nil {
			return
		}
		if err == nil {
			workerRow["state"], workerRow["result"] = "completed", deviceTransferResult(value)
		} else {
			workerRow["state"], workerRow["error"] = "failed", deviceTransferFailure(err.Error())
			workerRow["resume"] = object{"via": "act", "op": "device_transfer", "args": object{"action": "resume", "requestId": request}}
		}
		if err := store.checkpoint(context.WithoutCancel(wait), workerRow); err != nil {
			recordLog("ERROR", err.Error(), nil)
		}
	}()
	return row, nil
}

func deviceTransferResult(value any) object {
	return object{"path": field(value, "path"), "sizeBytes": field(value, "offset"), "sha256": field(value, "sha256")}
}

func (c *deviceController) cancelTransfer(ctx context.Context, row object, store receiptStore) (object, error) {
	request := text(row, "requestId")
	if active, ok := c.transferJobs.Load(request); ok {
		job := active.(*deviceTransferJob)
		job.cancel()
		<-job.done
	}
	var result any
	var err error
	if _, upload := field(field(row["plan"], "to"), "device").(string); upload {
		var link *deviceTransferLink
		link, _, err = c.admitTransfer(ctx, text(row, "device"), false)
		if err == nil {
			remote, cancel := context.WithCancel(ctx)
			defer cancel()
			defer context.AfterFunc(link.member.ctx, cancel)()
			result, err = link.control(remote, object{"action": "cancel", "requestId": request})
		}
	} else {
		directory := filepath.Join(c.directory, "transfer-receivers")
		r, problem := c.transfers.get(ctx, directory, request)
		switch {
		case errors.Is(problem, os.ErrNotExist):
			result = object{"state": "cancelled"}
		case problem != nil:
			err = problem
		default:
			r.mu.Lock()
			result, err = r.cancel()
			r.mu.Unlock()
		}
	}
	switch {
	case err != nil:
		row["state"], row["error"] = "failed", object{"code": "TRANSFER_CANCEL_PENDING", "message": err.Error()}
	case field(result, "state") == "completed":
		obj(row["progress"])["bytes"] = field(result, "offset")
		row["state"], row["error"], row["result"] = "completed", nil, deviceTransferResult(result)
	default:
		row["state"], row["error"] = "cancelled", nil
	}
	return row, store.checkpoint(ctx, row)
}

func (c *deviceController) runTransfer(ctx context.Context, link *deviceTransferLink, store receiptStore, row object) (any, error) {
	if err := link.refresh(ctx); err != nil {
		return nil, err
	}
	request := text(row, "requestId")
	plan := obj(row["plan"])
	_, upload := field(plan["to"], "device").(string)
	source := text(plan["from"], "path")
	var path string
	if upload {
		var err error
		path, err = resolveDeviceTransferPath(source)
		if err != nil {
			return nil, err
		}
	}
	fingerprint := func() (any, error) {
		if upload {
			return deviceTransferFingerprint(path)
		}
		return link.control(ctx, object{"action": "stat", "path": source})
	}
	stamp, err := fingerprint()
	if err != nil {
		return nil, err
	}
	if obj(row["fingerprint"]) != nil && wire(row["fingerprint"]) != wire(stamp) {
		return nil, errors.New("SOURCE_CHANGED: use a new requestId")
	}
	total, ok := uintValue(field(stamp, "total"))
	if !ok {
		return nil, errors.New("INVALID_ARGUMENT: source length unavailable")
	}
	row["fingerprint"] = stamp
	progress := obj(row["progress"])
	progress["total"] = total
	if err := store.checkpoint(ctx, row); err != nil {
		return nil, err
	}
	spec := object{"path": field(plan["to"], "path"), "total": total, "overwrite": plan["overwrite"] == true,
		"expectedSha256": plan["expectedSha256"], "source": stamp, "from": plan["from"]}
	if err := link.refresh(ctx); err != nil {
		return nil, err
	}
	directory := filepath.Join(c.directory, "transfer-receivers")
	var result any
	if upload {
		result, err = link.control(ctx, object{"action": "begin", "requestId": request, "spec": spec})
	} else {
		result, err = c.transfers.begin(ctx, directory, request, spec)
	}
	if err != nil {
		return nil, err
	}
	switch field(result, "state") {
	case "completed":
		progress["bytes"] = total
		return result, nil
	case "receiving":
	default:
		return nil, errors.New("TRANSFER_TERMINAL: receiver cannot resume")
	}
	offset, ok := uintValue(field(result, "offset"))
	if !ok || offset > total {
		return nil, errors.New("OFFSET_MISMATCH")
	}
	started, checkpoint, initial := time.Now(), time.Now(), offset
	for offset < total {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err := link.refresh(ctx); err != nil {
			return nil, err
		}
		length := min(total-offset, link.size())
		if upload {
			if observed, err := fingerprint(); err != nil || wire(observed) != wire(stamp) {
				return nil, errors.New("SOURCE_CHANGED: source changed during transfer")
			}
			reply, err := link.upload(ctx, request, path, offset, length)
			if err != nil {
				return nil, err
			}
			if uintOr(field(reply, "offset"), 0) != offset+length {
				return nil, errors.New("OFFSET_MISMATCH: receiver acknowledgement differs")
			}
		} else {
			r, err := c.transfers.get(ctx, directory, request)
			if err != nil {
				return nil, err
			}
			r.mu.Lock()
			err = link.download(ctx, request, source, stamp, r, length)
			r.mu.Unlock()
			if err != nil {
				return nil, err
			}
		}
		offset += length
		progress["bytes"], progress["rate"] = offset, uint64(float64(offset-initial)/max(time.Since(started).Seconds(), 0.000001))
		if offset == total || time.Since(checkpoint) >= 250*time.Millisecond {
			if err := store.checkpoint(ctx, row); err != nil {
				return nil, err
			}
			checkpoint = time.Now()
		}
	}
	if err := link.refresh(ctx); err != nil {
		return nil, err
	}
	last, err := fingerprint()
	if err != nil {
		return nil, err
	}
	if wire(last) != wire(stamp) {
		return nil, errors.New("SOURCE_CHANGED: source changed during transfer")
	}
	if err := link.refresh(ctx); err != nil {
		return nil, err
	}
	if upload {
		return link.control(ctx, object{"action": "commit", "requestId": request})
	}
	r, err := c.transfers.get(ctx, directory, request)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.commit()
}

func init() {
	ownedReceiptLookup = append(ownedReceiptLookup, deviceTransferReceipt)
	registerOperation("device_transfer", func(ctx context.Context, r operationRequest) (any, error) {
		c, err := serviceDeviceController(r.service)
		if err != nil {
			return nil, err
		}
		return c.transfer(ctx, r.args)
	}, deviceOpAvailable)
}
