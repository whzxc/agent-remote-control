package core

import (
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
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

func TestOfflineDeviceTransferRejectsBeforeSourceAccess(t *testing.T) {
	// Contract: an offline member returns DEVICE_OFFLINE and devices recovery before reading a local source.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	const member = "offline-fixture"
	controller := &deviceController{members: map[string]*deviceMember{
		member: {peer: devicePeer{DeviceID: member, Name: "Offline fixture"}},
	}}
	_, err := controller.transfer(t.Context(), object{
		"from": object{"path": "nonexistent-source"},
		"to":   object{"device": member, "path": "nonexistent-destination"},
	})
	var failure object
	if err == nil || decodeObject([]byte(err.Error()), &failure) != nil ||
		failure["code"] != "DEVICE_OFFLINE" || field(failure["next"], "op") != "devices" {
		t.Fatalf("offline transfer returned %v", err)
	}
}

func TestDeviceGuideDisclosesFullScopeAndTransferRecovery(t *testing.T) {
	// Contract: device guide disclosure and transfer receipt recovery follow the frozen MCP schemas.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	if _, err := changePreferences(object{"values": object{"device-link": "on"}}, false); err != nil {
		t.Fatal(err)
	}
	s := &service{metadata: object{"instance": id()}}
	common := callLocalCoordination(t, s, "guide", object{})
	full := callLocalCoordination(t, s, "guide", object{"view": "full"})
	device := callLocalCoordination(t, s, "guide", object{"op": "device"})
	transfer := callLocalCoordination(t, s, "guide", object{"op": "device_transfer"})
	if find(common["ops"], "op", "device") != nil || find(common["ops"], "op", "devices") != nil ||
		find(full["ops"], "op", "devices") == nil || wire(device["via"]) != `["query","act"]` ||
		transfer["via"] != "act" || field(transfer["retry"], "mode") != "receipt" || !devicePeerForbidden("device_transfer") {
		t.Fatalf("unexpected device guide contract: device=%v transfer=%v", device["via"], transfer["retry"])
	}
}

func TestDeviceCLIErrorsKeepStableCodesAndRecovery(t *testing.T) {
	// Contract: device CLI failures retain the version-one error envelope and guide recovery.
	for _, code := range []string{"OP_UNAVAILABLE", "DEVICE_PAIRING_INVALID", "DEVICE_PROTOCOL_MISMATCH", "DEVICE_PEER_FORBIDDEN", "DEVICE_UNPAIRED"} {
		result := cliErrorResponse(code+": Read cli guide.", "cli device offer", []string{"device", "offer"}, false)
		if uintOr(result["schemaVersion"], 0) != 1 || result["ok"] != false ||
			field(result["error"], "code") != code || field(result["next"], "op") != "guide" {
			t.Fatalf("device CLI error for %s was %v", code, result)
		}
	}
}

func TestDeviceLANTLSErrorWinsOverLinkLocalTimeout(t *testing.T) {
	// Algorithmic core: concurrent LAN dials report the strongest failure regardless of completion order.
	ipv4 := netip.MustParseAddrPort("192.0.2.10:7143")
	linkLocal := netip.MustParseAddrPort("[fe80::2%1]:7143")
	failures := []deviceDialFailure{
		{address: ipv4, dialable: true, message: "DEVICE_TLS_FAILED: Peer handshake failed"},
		{address: linkLocal, dialable: true, message: "TCP connect deadline expired"},
	}
	for range 2 {
		result := deviceLANDialError(failures).Error()
		if managementErrorCode(result) != "DEVICE_TLS_FAILED" || !strings.Contains(result, ipv4.String()) {
			t.Fatalf("a less informative LAN error won: %s", result)
		}
		slices.Reverse(failures)
	}
}
