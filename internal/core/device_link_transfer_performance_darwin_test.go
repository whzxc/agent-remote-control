//go:build arcfixture && darwin

package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDeviceLANOneGiBStreamingBounds(t *testing.T) {
	// Contract: the one-GiB LAN stream preserves its digest and bounds memory growth and first-byte latency.
	if os.Getenv("ARC_TEST_DEVICE_LAN_GIB") != "1" {
		t.Skip("opt-in one-GiB LAN throughput and memory fixture")
	}
	directory := t.TempDir()
	controller, _, link := loopbackDeviceController(t, directory, nil)
	ctx, cancel := context.WithTimeout(controller.ctx, 2*time.Minute)
	defer cancel()

	const size = uint64(1 << 30)
	source, uploaded, downloaded := filepath.Join(directory, "source"), filepath.Join(directory, "uploaded"), filepath.Join(directory, "downloaded")
	file, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	buffer := make([]byte, deviceTransferBlock)
	for i := range buffer {
		buffer[i] = byte((i*17 + i/251) % 251)
	}
	digest := sha256.New()
	for offset := uint64(0); offset < size; offset += uint64(len(buffer)) {
		if _, err := file.Write(buffer); err != nil {
			t.Fatal(err)
		}
		_, _ = digest.Write(buffer)
	}
	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	sum := hex.EncodeToString(digest.Sum(nil))
	resident := func() uint64 {
		result := runtimeProcessMetrics()
		if result["state"] != "available" {
			t.Fatalf("process RSS unavailable: %v", result)
		}
		return uintOr(result["residentBytes"], 0)
	}
	report := func(direction string, started time.Time, before uint64) {
		t.Helper()
		var usage unix.Rusage
		if err := unix.Getrusage(unix.RUSAGE_SELF, &usage); err != nil {
			t.Fatal(err)
		}
		peak := uint64(usage.Maxrss)
		growth := peak - min(before, peak)
		elapsed := time.Since(started)
		t.Logf("%s bytes=%d seconds=%.3f MBps=%.1f rss_growth_MiB=%.2f", direction,
			size, elapsed.Seconds(), float64(size)/elapsed.Seconds()/1e6, float64(growth)/(1<<20))
		if growth > 64<<20 {
			t.Errorf("%s RSS grew by %d bytes", direction, growth)
		}
	}

	up := id()
	before, started := resident(), time.Now()
	receiver, err := link.control(ctx, object{"action": "begin", "requestId": up,
		"spec": object{"path": uploaded, "total": size, "expectedSha256": sum}})
	if err != nil {
		t.Fatal(err)
	}
	temporary := text(receiver, "temporary")
	first := make(chan time.Duration, 1)
	waitForByte, stopMonitoring := context.WithCancel(ctx)
	defer stopMonitoring()
	admitted := time.Now()
	go func() {
		ticks := time.NewTicker(time.Millisecond)
		defer ticks.Stop()
		for {
			select {
			case <-waitForByte.Done():
				return
			case <-ticks.C:
				if info, err := os.Stat(temporary); err == nil && info.Size() > 0 {
					first <- time.Since(admitted)
					return
				}
			}
		}
	}()
	for offset := uint64(0); offset < size; offset += deviceTransferLANRange {
		if _, err := link.upload(ctx, up, source, offset, deviceTransferLANRange); err != nil {
			t.Fatal(err)
		}
	}
	if result, err := link.control(ctx, object{"action": "commit", "requestId": up}); err != nil || field(result, "sha256") != sum {
		t.Fatalf("one-GiB upload digest: %v (%v)", result, err)
	}
	select {
	case latency := <-first:
		t.Logf("first_byte_ms=%.2f", float64(latency)/float64(time.Millisecond))
		if latency >= 200*time.Millisecond {
			t.Errorf("LAN first byte took %s", latency)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	report("LAN_UPLOAD", started, before)

	stamp, err := link.control(ctx, object{"action": "stat", "path": uploaded})
	if err != nil {
		t.Fatal(err)
	}
	store := &deviceReceiverStore{}
	defer store.close()
	down := id()
	if _, err := store.begin(ctx, directory, down, object{"path": downloaded, "total": size, "expectedSha256": sum}); err != nil {
		t.Fatal(err)
	}
	destination, err := store.get(ctx, directory, down)
	if err != nil {
		t.Fatal(err)
	}
	before, started = resident(), time.Now()
	for destination.offset() < size {
		if err := link.download(ctx, down, uploaded, stamp, destination, deviceTransferLANRange); err != nil {
			t.Fatal(err)
		}
	}
	if result, err := destination.commit(); err != nil || field(result, "sha256") != sum {
		t.Fatalf("one-GiB download digest: %v (%v)", result, err)
	}
	report("LAN_DOWNLOAD", started, before)
}
