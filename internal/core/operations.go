package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

var operationID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var submitLock sync.Mutex

func operationPath(id string) (string, error) {
	if !operationID.MatchString(id) {
		return "", errors.New("invalid requestId")
	}
	return filepath.Join(root(), "operations", id+".json"), nil
}

func projectManagementReceipt(receipt object, instance string, timeMS int64) object {
	result := projectReceipt(receipt, receipt["instance"] == instance, timeMS)
	if result["state"] == string(receiptUnconfirmed) {
		result["next"] = object{"operation": "operations.get", "arguments": object{"id": result["requestId"]}}
		delete(result, "nextAction")
	}
	return result
}

func readManagementReceipt(id, instance string) (object, error) {
	path, err := operationPath(id)
	if err != nil {
		return nil, err
	}
	item, err := load(path)
	if err != nil {
		return nil, err
	}
	receipt := obj(item)
	if receipt == nil {
		return nil, errors.New("invalid operation receipt")
	}
	if receipt["state"] == "succeeded" {
		receipt["state"] = string(receiptCompleted)
		if err := save(path, receipt); err != nil {
			return nil, err
		}
	}
	return projectManagementReceipt(receipt, instance, time.Now().UnixMilli()), nil
}

func submitManagementOperation(ctx context.Context, service *service, body object) (object, error) {
	submitLock.Lock()
	defer submitLock.Unlock()
	requestID, name := text(body, "requestId"), text(body, "operation")
	path, err := operationPath(requestID)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(name, "operations.") || slices.Contains([]string{"app.start", "ingress.token", "ingress.credentials", "ingress.oauth.register"}, name) {
		return nil, errors.New("operation cannot be submitted")
	}
	args := obj(body["arguments"])
	if args == nil {
		args = object{}
	}
	route, method, input, err := managementResolve(name, args)
	if err != nil {
		return nil, err
	}
	fingerprint := hash([]byte(wire(body)))
	instance := text(service.metadata, "instance")
	existing, err := readManagementReceipt(requestID, instance)
	if err == nil {
		if existing["fingerprint"] != fingerprint {
			return nil, errors.New("REQUEST_ID_CONFLICT")
		}
		return existing, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	receipt := object{"requestId": requestID, "operation": name, "state": string(receiptReserved), "startedAt": now(), "instance": instance, "fingerprint": fingerprint}
	if err := save(path, receipt); err != nil {
		return nil, err
	}
	result := projectManagementReceipt(clone(receipt), instance, time.Now().UnixMilli())
	go func() {
		receipt["state"] = string(receiptExecuting)
		receipt["updatedAt"] = now()
		err := save(path, receipt)
		var value any
		if err == nil {
			if name == "logs.query" && input["offline"] == true {
				value, err = queryLogs(input)
			} else {
				value, err = service.management(context.WithoutCancel(ctx), route, method, input)
			}
		}
		receipt["completedAt"] = now()
		if err == nil {
			receipt["effectConfirmed"] = field(value, "accepted") != true && field(value, "restarting") != true
			receipt["state"] = string(receiptCompleted)
			receipt["nextAction"] = "Read the affected resource. Secret-bearing operation outputs are never persisted in receipts."
		} else {
			state := receiptFailed
			message := err.Error()
			switch {
			case strings.HasPrefix(message, "SUBMISSION_UNCONFIRMED:"):
				state = receiptUnconfirmed
			case strings.HasPrefix(message, "RPC_REJECTED"), strings.HasPrefix(message, "DESKTOP_REJECTED"):
				state = receiptRejected
			}
			receipt["state"] = string(advanceReceipt(receiptExecuting, receiptFail, state))
			receipt["error"] = message
		}
		if err := save(path, receipt); err != nil {
			recordLog("ERROR", fmt.Sprintf("Cannot save operation receipt: %s", err), nil)
		}
	}()
	return result, nil
}
