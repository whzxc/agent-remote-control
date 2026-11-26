package core

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestDeviceForwardRecordsKeepTheOriginalEventSource(t *testing.T) {
	// Recurring bug class: persistence later readers must never reassign the originating source of a forwarded task or receipt.
	directory := t.TempDir()
	records, err := openDeviceRecords(directory)
	if err != nil {
		t.Fatal(err)
	}
	records.associate("member", "source-one", object{"thread": object{"id": "fixture-task"}})
	records.associate("member", "source-two", object{"threadId": "fixture-task"})
	if err := records.save(directory); err != nil {
		t.Fatal(err)
	}
	records, err = openDeviceRecords(directory)
	if err != nil {
		t.Fatal(err)
	}
	if source, found := records.taskSource("member", "fixture-task"); !found || source != "source-one" {
		t.Fatalf("reloaded event source %q, found=%v", source, found)
	}
	for index := range deviceTaskCap + 1 {
		records.associate("member", "source-two", object{"taskId": fmt.Sprintf("task-%d", index)})
	}
	if _, found := records.taskSource("member", "fixture-task"); found {
		t.Fatal("expired task association retained")
	}
	for index := range deviceForwardCap + 1 {
		records.record(deviceForwardRecord{RequestID: fmt.Sprintf("fixture-%d", index), DeviceID: "member", Op: "command", SourceID: "source-one"})
	}
	if records.associateReceipt("member", "fixture-0", object{"taskId": "expired"}) {
		t.Fatal("expired forward regained a task association")
	}
	records.associateReceipt("member", fmt.Sprintf("fixture-%d", deviceForwardCap), object{"result": object{"threadId": "recovered"}})
	if source, found := records.taskSource("member", "recovered"); !found || source != "source-one" {
		t.Fatalf("recovered receipt source %q, found=%v", source, found)
	}
}

func TestDeviceForwardDeadlineExceedsMemberWait(t *testing.T) {
	// Algorithmic core: forwarded wait deadlines preserve control waits across operations.
	for _, op := range []string{"codex_wait", "agent_wait", "inbox_wait"} {
		if got := deviceRequestBound(op, object{"timeoutMs": 1_800_000}); got <= 30*time.Minute {
			t.Errorf("%s wait deadline %v", op, got)
		}
	}
	if got := deviceRequestBound("command", object{"waitMs": 120_000}); got <= 2*time.Minute {
		t.Errorf("command wait deadline %v", got)
	}
}

func TestControllerCoreLossRetainsTheMemberReceiptTarget(t *testing.T) {
	// Contract: the private error envelope continues a forwarded write at its original member receipt.
	outer, original := id(), id()
	for _, item := range []struct {
		body object
		want string
	}{
		{object{"op": "device", "args": object{"device": "fixture-member", "op": "notice_post", "args": object{}}}, outer},
		{object{"op": "device", "args": object{"device": "fixture-member", "op": "receipt", "args": object{"action": "approve", "requestId": original}}}, original},
		{object{"op": "notice_post", "args": object{"device": "fixture-member"}}, outer},
	} {
		err := lostPrivate(frontDoorRequest{Operation: "LocalControl", ID: outer, Body: item.body}, errors.New("connection closed"))
		var failure object
		if err := decodeObject([]byte(err.Error()), &failure); err != nil {
			t.Fatal(err)
		}
		data := failure["data"]
		next := field(data, "next")
		args := field(next, "args")
		if field(data, "requestId") != item.want || field(data, "state") != "unconfirmed" ||
			field(next, "via") != "act" || field(next, "op") != "device" ||
			field(args, "device") != "fixture-member" || field(args, "op") != "receipt" ||
			field(field(args, "args"), "requestId") != item.want {
			t.Fatalf("private recovery envelope %v", failure)
		}
	}
}
