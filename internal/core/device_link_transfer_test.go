//go:build arcfixture

package core

import (
	"bytes"
	"context"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func loopbackDeviceController(t *testing.T, directory string, handle func(context.Context, string, object) (any, error)) (*deviceController, string, *deviceTransferLink) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Setenv("ARC_STATE_DIR", directory)
	manager, err := newDeviceManager(ctx, filepath.Join(directory, "member"))
	if err != nil {
		t.Fatal(err)
	}
	memberIdentity, err := loadDeviceIdentity(manager.directory)
	if err != nil {
		t.Fatal(err)
	}
	controllerDirectory := filepath.Join(directory, "controller")
	controllerIdentity, err := loadDeviceIdentity(controllerDirectory)
	if err != nil {
		t.Fatal(err)
	}
	manager.enabled, manager.identity = true, memberIdentity
	manager.stored.Controller = &devicePeer{DeviceID: controllerIdentity.id, PublicKey: controllerIdentity.publicKey, Name: "Fixture controller"}
	if handle == nil {
		handle = func(context.Context, string, object) (any, error) { return egressTool(object{}, false), nil }
	}
	manager.control = handle

	socket, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	pinned := func(candidate string) bool { return candidate == controllerIdentity.id }
	server := newDevicePeerListener(memberIdentity, pinned, pinned, manager.servePeer)
	server.allow = netip.Addr.IsLoopback
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.listen(ctx, socket)
	}()
	member := &deviceMember{
		peer:     devicePeer{DeviceID: memberIdentity.id, PublicKey: memberIdentity.publicKey, Name: "Fixture member"},
		identity: controllerIdentity, ctx: ctx, slots: make(chan struct{}, 8),
		status: deviceMemberStatus{online: true, path: "lan"}, changed: make(chan struct{}),
	}
	records, err := openDeviceRecords(controllerDirectory)
	if err != nil {
		t.Fatal(err)
	}
	controller := &deviceController{ctx: ctx, directory: controllerDirectory, records: records, members: map[string]*deviceMember{memberIdentity.id: member}}
	t.Cleanup(func() {
		cancel()
		member.business.close()
		<-done
		controller.transferJobs.Range(func(_, active any) bool {
			<-active.(*deviceTransferJob).done
			return true
		})
		controller.transfers.close()
		manager.transfers.close()
	})
	channel, err := member.business.connect(ctx, controllerIdentity, memberIdentity.id, []netip.AddrPort{socket.Addr().(*net.TCPAddr).AddrPort()})
	if err != nil {
		t.Fatal(err)
	}
	return controller, memberIdentity.id, &deviceTransferLink{path: devicePreparedPath{lan: channel}, member: member}
}

func TestDeviceLANTransferReceiptsAndVerifiedRanges(t *testing.T) {
	// Contract: pinned LAN transfers stream in either direction and expose durable receipts for destination, checksum and cancellation outcomes.
	directory := t.TempDir()
	controller, member, link := loopbackDeviceController(t, directory, nil)
	ctx, cancel := context.WithTimeout(controller.ctx, 8*time.Second)
	defer cancel()
	wait := func(request string) object {
		t.Helper()
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			raw, err := controller.transfer(ctx, object{"action": "read", "requestId": request})
			if err != nil {
				t.Fatal(err)
			}
			if state := text(raw, "state"); state != "executing" && state != "reserved" {
				return obj(raw)
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-tick.C:
			}
		}
	}
	start := func(from, to object, extra object) (object, object) {
		t.Helper()
		plan := object{"requestId": id(), "from": from, "to": to}
		for name, value := range extra {
			plan[name] = value
		}
		row, err := controller.transfer(ctx, plan)
		if err != nil || field(row, "requestId") != plan["requestId"] || field(row, "state") != "executing" {
			t.Fatalf("transfer admission %v: %v", row, err)
		}
		return plan, wait(text(plan, "requestId"))
	}
	data := bytes.Repeat([]byte("arc peer fixture\x00\xff"), 130000)
	source := filepath.Join(directory, "source")
	uploaded := filepath.Join(directory, "uploaded")
	downloaded := filepath.Join(directory, "downloaded")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := hash(data)
	from := object{"path": source}
	to := object{"device": member, "path": uploaded}
	plan, result := start(from, to, object{"expectedSha256": sum})
	if result["state"] != "completed" || field(result["result"], "sha256") != sum || uintOr(field(result["progress"], "bytes"), 0) != uint64(len(data)) {
		t.Fatalf("upload receipt %v", result)
	}
	if repeated, err := controller.transfer(ctx, plan); err != nil || field(repeated, "state") != "completed" || field(repeated, "requestId") != plan["requestId"] {
		t.Fatalf("duplicate upload %v: %v", repeated, err)
	}
	_, result = start(to, object{"path": downloaded}, object{"expectedSha256": sum})
	if result["state"] != "completed" || field(result["result"], "sha256") != sum {
		t.Fatalf("download receipt %v", result)
	}
	checkBytes := func(path string) {
		t.Helper()
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("file %s: got %d bytes, error %v", path, len(got), err)
		}
	}
	checkBytes(downloaded)
	_, result = start(from, to, nil)
	if field(result["error"], "code") != "DESTINATION_EXISTS" {
		t.Fatalf("no-replace receipt %v", result)
	}
	bad, result := start(from, to, object{"overwrite": true, "expectedSha256": hash([]byte("other"))})
	if field(result["error"], "code") != "SHA256_MISMATCH" {
		t.Fatalf("digest failure receipt %v", result)
	}
	checkBytes(uploaded)
	request := text(bad, "requestId")
	cancelled, err := controller.transfer(ctx, object{"action": "cancel", "requestId": request})
	if err != nil || field(cancelled, "state") != "cancelled" {
		t.Fatalf("cancelled receipt %v: %v", cancelled, err)
	}
	meta, err := link.control(ctx, object{"action": "status", "requestId": request})
	if err != nil || field(meta, "state") != "cancelled" {
		t.Fatalf("receiver cancellation %v: %v", meta, err)
	}
	if _, err := os.Stat(text(meta, "temporary")); !os.IsNotExist(err) {
		t.Fatalf("cancelled transfer still owns a temporary file: %v", err)
	}
	replacement := []byte("replacement transfer payload")
	if err := os.WriteFile(source, replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	_, result = start(from, to, object{"overwrite": true, "expectedSha256": hash(replacement)})
	got, err := os.ReadFile(uploaded)
	if err != nil || !bytes.Equal(got, replacement) || result["state"] != "completed" || field(result["result"], "sha256") != hash(replacement) {
		t.Fatalf("overwrite outcome = %v, file = %q, %v", result, got, err)
	}
	if _, err := changePreferences(object{"values": object{"device-link": "off"}}, false); err != nil {
		t.Fatal(err)
	}
	denied := localControl(ctx, &service{}, requestSource{policy: "all", local: true},
		object{"op": "device_transfer", "args": plan})
	value, err := egressToolValue(denied)
	if err != nil || field(field(value, "error"), "code") != "OP_UNAVAILABLE" {
		t.Fatalf("disabled transfer command = %v, %v", value, err)
	}
}

func TestInterruptedDeviceTransferRequiresExplicitResume(t *testing.T) {
	// Recurring bug class: lifecycle loss of an execution owner preserves only the verified prefix until explicit resume.
	directory := t.TempDir()
	var checked atomic.Int32
	prefix := make(chan struct{})
	controller, member, link := loopbackDeviceController(t, directory, func(ctx context.Context, _ string, _ object) (any, error) {
		if checked.Add(1) == 3 {
			close(prefix)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return egressTool(object{}, false), nil
	})
	ctx, cancel := context.WithTimeout(controller.ctx, 15*time.Second)
	defer cancel()
	data := bytes.Repeat([]byte{42}, deviceTransferLANRange+4096)
	source := filepath.Join(directory, "source")
	destination := filepath.Join(directory, "destination")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	request := id()
	plan := object{"requestId": request, "from": object{"path": source}, "to": object{"path": destination, "device": member}, "expectedSha256": hash(data)}
	if _, err := controller.transfer(ctx, plan); err != nil {
		t.Fatal(err)
	}
	select {
	case <-prefix:
	case <-ctx.Done():
		t.Fatal("first LAN range was never acknowledged")
	}
	active, ok := controller.transferJobs.Load(request)
	if !ok {
		t.Fatal("missing active transfer owner")
	}
	owner := active.(*deviceTransferJob)
	owner.cancel()
	select {
	case <-owner.done:
	case <-ctx.Done():
		t.Fatal("interrupted transfer did not release its owner")
	}
	meta, err := link.control(ctx, object{"action": "status", "requestId": request})
	if err != nil || uintOr(field(meta, "offset"), 0) != deviceTransferLANRange {
		t.Fatalf("verified prefix %v: %v", meta, err)
	}
	repeated, err := controller.transfer(ctx, plan)
	if err != nil || field(repeated, "state") != "unconfirmed" {
		t.Fatalf("duplicate request after interruption %v: %v", repeated, err)
	}
	if _, err := controller.transfer(ctx, object{"action": "resume", "requestId": request}); err != nil {
		t.Fatal(err)
	}
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
resuming:
	for {
		row, err := controller.transfer(ctx, object{"action": "read", "requestId": request})
		if err != nil {
			t.Fatal(err)
		}
		switch field(row, "state") {
		case "completed":
			got, err := os.ReadFile(destination)
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("resumed file: got %d bytes, error %v", len(got), err)
			}
			break resuming
		case "executing", "reserved":
		default:
			t.Fatalf("resumed transfer %v", row)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-tick.C:
		}
	}
	queuedPath := filepath.Join(directory, "queued-destination")
	first, second := id(), id()
	begin := func(request string) (any, error) {
		return link.control(ctx, object{"action": "begin", "requestId": request,
			"spec": object{"path": queuedPath, "total": 4, "expectedSha256": hash([]byte("test"))}})
	}
	if row, err := begin(first); err != nil || field(row, "state") != "receiving" {
		t.Fatalf("first destination owner = %v, %v", row, err)
	}
	type decision struct {
		row any
		err error
	}
	waiting := make(chan decision, 1)
	go func() {
		row, err := begin(second)
		waiting <- decision{row, err}
	}()
	select {
	case got := <-waiting:
		t.Fatalf("second destination owner bypassed the first: %v", got)
	case <-time.After(25 * time.Millisecond):
	}
	for _, request := range []string{second, first} {
		result, err := link.control(ctx, object{"action": "cancel", "requestId": request})
		if err != nil || field(result, "state") != "cancelled" {
			t.Fatalf("cancel receiver %s = %v, %v", request, result, err)
		}
	}
	select {
	case got := <-waiting:
		if got.err != nil || field(got.row, "state") != "cancelled" {
			t.Fatalf("cancelled begin was admitted later: %v", got)
		}
	case <-ctx.Done():
		t.Fatal("cancelled receiver did not finish")
	}
	if _, err := os.Stat(queuedPath); !os.IsNotExist(err) {
		t.Fatalf("cancelled receivers published a destination: %v", err)
	}
}
