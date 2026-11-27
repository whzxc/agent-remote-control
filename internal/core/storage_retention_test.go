package core

import (
	"compress/gzip"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStorageArchiveMovesOnlyOldTerminalRecordsAndPreservesActive(t *testing.T) {
	// Contract: lossless archiving moves old terminal receipts, coordination files, dispatches and terminal notifications into monthly gzip JSONL archives, compresses old metric logs, and never deletes outputs or active/red-line state.
	dir := t.TempDir()
	oldTime := time.Now().UTC().AddDate(0, 0, -45)
	expiredOutputTime := time.Now().UTC().AddDate(0, 0, -8)
	recentTime := time.Now().UTC().AddDate(0, 0, -2)

	writeAged := func(rel, content string, mtime time.Time) string {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return path
	}

	oldReceiptID := id()
	activeReceiptID := id()
	recentReceiptID := id()
	oldReceipt := writeAged(oldReceiptID+".json", `{"requestId":"`+oldReceiptID+`","state":"completed"}`, oldTime)
	activeReceipt := writeAged(activeReceiptID+".json", `{"requestId":"`+activeReceiptID+`","state":"executing"}`, oldTime)
	recentReceipt := writeAged(recentReceiptID+".json", `{"requestId":"`+recentReceiptID+`","state":"completed"}`, recentTime)
	oldCoord := writeAged("coordination/observations/obs-1.json", `{"id":"obs-1"}`, oldTime)
	oldDispatch := writeAged("dispatches/thread-1/d1.json", `{"id":"d1"}`, oldTime)
	oldNotify := writeAged("notifications/tasks/n1.json", `{"deliveries":[{"status":"delivered"}]}`, oldTime)
	pendingNotify := writeAged("notifications/tasks/n2.json", `{"deliveries":[{"status":"pending"}]}`, oldTime)
	oldMetric := writeAged("control-metrics/2026-01-01.jsonl", `{"op":"guide"}`+"\n", oldTime)
	expiredOutput := writeAged("outputs/expired-output.txt", "stale temp output", expiredOutputTime)
	recentOutput := writeAged("outputs/recent-output.txt", "fresh temp output", recentTime)
	existingArchive := writeAged("archives/receipts/2025-01.jsonl.gz", "existing-archive", oldTime)
	redLine := writeAged("accounts/index.json", `{"accounts":[]}`, oldTime)

	dryRun, err := runStorageArchiveIn(context.Background(), dir, false, storageManualBatchLimit)
	if err != nil || dryRun["applied"] != false {
		t.Fatalf("dry-run failed: %v %v", dryRun, err)
	}
	if _, err := os.Stat(oldReceipt); err != nil {
		t.Fatal("dry-run removed source receipt")
	}
	if _, err := os.Stat(oldMetric); err != nil {
		t.Fatal("dry-run modified metric log")
	}
	drySummary := obj(dryRun["summary"])
	if int(uintOr(drySummary["eligibleArchive"], 0)) != 4 || int(uintOr(drySummary["eligibleCompress"], 0)) != 1 {
		t.Fatalf("unexpected dry-run summary: %v", drySummary)
	}

	applied, err := runStorageArchiveIn(context.Background(), dir, true, storageManualBatchLimit)
	if err != nil || applied["applied"] != true {
		t.Fatalf("apply failed: %v %v", applied, err)
	}
	summary := obj(applied["summary"])
	if int(uintOr(summary["archived"], 0)) != 4 || int(uintOr(summary["compressed"], 0)) != 1 {
		t.Fatalf("unexpected archive summary: %v", summary)
	}
	if _, hasOutputs := obj(applied["categories"])["outputs"]; hasOutputs {
		t.Fatalf("lossless archive must not report or delete outputs: %v", applied["categories"])
	}

	for _, removed := range []string{oldReceipt, oldCoord, oldDispatch, oldNotify, oldMetric} {
		if _, err := os.Stat(removed); !os.IsNotExist(err) {
			t.Fatalf("expected archived/compressed file to be removed from hot dir: %s", removed)
		}
	}
	for _, kept := range []string{activeReceipt, recentReceipt, pendingNotify, expiredOutput, recentOutput, existingArchive, redLine, oldMetric + ".gz"} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected preserved file to remain: %s", kept)
		}
	}

	month := oldTime.Format("2006-01")
	archiveFile := filepath.Join(dir, "archives", "receipts", month+".jsonl.gz")
	f, err := os.Open(archiveFile)
	if err != nil {
		t.Fatalf("missing receipt archive: %v", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	raw, err := io.ReadAll(gz)
	if err != nil || !strings.Contains(string(raw), oldReceiptID) {
		t.Fatalf("archive content missing receipt %s: %s (%v)", oldReceiptID, string(raw), err)
	}
}

func TestStoragePruneRespectsDryRunAgeAndFlags(t *testing.T) {
	// Recurring bug class: persistence prune must default to dry-run and only remove expired archives, expired outputs, and legacy directories when explicitly requested.
	dir := t.TempDir()
	oldTime := time.Now().UTC().AddDate(0, 0, -120)
	expiredOutputTime := time.Now().UTC().AddDate(0, 0, -8)
	recentTime := time.Now().UTC().AddDate(0, 0, -2)

	writeAged := func(rel string, mtime time.Time) string {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("payload"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return path
	}

	expiredArchive := writeAged("archives/receipts/2025-01.jsonl.gz", oldTime)
	recentArchive := writeAged("archives/receipts/2026-11.jsonl.gz", recentTime)
	expiredOutput := writeAged("outputs/old-output.txt", expiredOutputTime)
	recentOutput := writeAged("outputs/fresh-output.txt", recentTime)
	legacyFile := writeAged("usage/old.json", oldTime)
	accountFile := writeAged("accounts/index.json", oldTime)

	preview, err := runStoragePruneIn(context.Background(), dir, false, 90, true, true)
	if err != nil || preview["applied"] != false {
		t.Fatalf("dry-run prune failed: %v %v", preview, err)
	}
	if int(uintOr(field(preview["archives"], "eligible"), 0)) != 1 || int(uintOr(field(preview["outputs"], "eligible"), 0)) != 1 {
		t.Fatalf("unexpected dry-run prune preview: %v", preview)
	}
	for _, kept := range []string{expiredArchive, expiredOutput, legacyFile} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("dry-run prune deleted file: %s", kept)
		}
	}

	if _, err := runStoragePruneIn(context.Background(), dir, true, 90, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expiredArchive); !os.IsNotExist(err) {
		t.Fatal("expired archive was not removed")
	}
	for _, kept := range []string{recentArchive, expiredOutput, recentOutput, legacyFile, accountFile} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("unexpected removal without flag: %s", kept)
		}
	}

	outRes, err := runStoragePruneIn(context.Background(), dir, true, 90, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if int(uintOr(field(outRes["outputs"], "removed"), 0)) != 1 {
		t.Fatalf("expected 1 expired output removed: %v", outRes)
	}
	if _, err := os.Stat(expiredOutput); !os.IsNotExist(err) {
		t.Fatal("expired output was not removed when includeOutputs=true")
	}
	for _, kept := range []string{recentArchive, recentOutput, legacyFile, accountFile} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("unexpected removal during output prune: %s", kept)
		}
	}

	if _, err := runStoragePruneIn(context.Background(), dir, true, 90, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyFile); !os.IsNotExist(err) {
		t.Fatal("legacy dir was not removed when includeLegacy=true")
	}
	if _, err := os.Stat(accountFile); err != nil {
		t.Fatal("red-line accounts file was removed")
	}
}

func TestStorageMaintenanceSeparatesArchiveCompressAndOutputDelete(t *testing.T) {
	// Recurring bug class: persistence daily maintenance must report archived, compressed, and deleted output counts separately while preserving recent outputs and existing archives under keep-forever retention.
	dir := t.TempDir()
	oldReceiptTime := time.Now().UTC().AddDate(0, 0, -45)
	oldMetricTime := time.Now().UTC().AddDate(0, 0, -20)
	expiredOutputTime := time.Now().UTC().AddDate(0, 0, -8)
	recentOutputTime := time.Now().UTC().AddDate(0, 0, -1)
	existingArchiveTime := time.Now().UTC().AddDate(0, 0, -120)

	writeAged := func(rel, content string, mtime time.Time) string {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return path
	}

	oldReceiptID := id()
	oldReceipt := writeAged(oldReceiptID+".json", `{"requestId":"`+oldReceiptID+`","state":"completed"}`, oldReceiptTime)
	oldMetric := writeAged("control-metrics/2026-01-01.jsonl", `{"op":"guide"}`+"\n", oldMetricTime)
	expiredOutput := writeAged("outputs/expired.txt", "8-day-old output", expiredOutputTime)
	recentOutput := writeAged("outputs/recent.txt", "1-day-old output", recentOutputTime)
	existingArchive := writeAged("archives/receipts/2025-01.jsonl.gz", "preexisting-gzip", existingArchiveTime)

	status, err := storageStatusIn(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	hot := obj(status["hot"])
	if int(uintOr(field(hot["receipts"], "archivable"), 0)) != 1 {
		t.Fatalf("expected 1 archivable receipt: %v", hot["receipts"])
	}
	if int(uintOr(field(hot["controlMetrics"], "compressible"), 0)) != 1 {
		t.Fatalf("expected 1 compressible metric: %v", hot["controlMetrics"])
	}
	if int(uintOr(field(hot["outputs"], "prunable"), 0)) != 1 || int64(uintOr(field(hot["outputs"], "prunableBytes"), 0)) != int64(len("8-day-old output")) {
		t.Fatalf("unexpected outputs status: %v", hot["outputs"])
	}

	counts, err := runStorageMaintenancePassIn(context.Background(), dir, 0, storageAutoBatchLimit)
	if err != nil {
		t.Fatal(err)
	}
	if int(uintOr(counts["archived"], 0)) != 1 || int(uintOr(counts["compressed"], 0)) != 1 ||
		int(uintOr(counts["deletedOutputs"], 0)) != 1 || int(uintOr(counts["deletedArchives"], 0)) != 0 {
		t.Fatalf("expected separate maintenance counts, got %v", counts)
	}

	if _, err := os.Stat(oldReceipt); !os.IsNotExist(err) {
		t.Fatal("old receipt should have been archived")
	}
	if _, err := os.Stat(expiredOutput); !os.IsNotExist(err) {
		t.Fatal("expired output should have been permanently deleted by daily maintenance")
	}
	for _, kept := range []string{recentOutput, existingArchive, oldMetric + ".gz"} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected preserved file to remain: %s", kept)
		}
	}

	month := oldReceiptTime.Format("2006-01")
	archiveFile := filepath.Join(dir, "archives", "receipts", month+".jsonl.gz")
	f, err := os.Open(archiveFile)
	if err != nil {
		t.Fatalf("missing monthly receipt archive: %v", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	raw, err := io.ReadAll(gz)
	if err != nil || !strings.Contains(string(raw), oldReceiptID) {
		t.Fatalf("monthly archive missing old receipt %s: %v", oldReceiptID, err)
	}
	if strings.Contains(string(raw), "8-day-old output") {
		t.Fatal("deleted output must not be written into receipt archive")
	}
}
