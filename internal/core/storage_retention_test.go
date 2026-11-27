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
	// Contract: automatic archiving moves old terminal receipts, coordination files, dispatches and terminal notifications into monthly gzip JSONL archives while preserving active and red-line state.
	dir := t.TempDir()
	oldTime := time.Now().UTC().AddDate(0, 0, -45)
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
	redLine := writeAged("accounts/index.json", `{"accounts":[]}`, oldTime)

	dryRun, err := runStorageArchiveIn(context.Background(), dir, false, storageManualBatchLimit)
	if err != nil || dryRun["applied"] != false {
		t.Fatalf("dry-run failed: %v %v", dryRun, err)
	}
	if _, err := os.Stat(oldReceipt); err != nil {
		t.Fatal("dry-run removed source receipt")
	}

	applied, err := runStorageArchiveIn(context.Background(), dir, true, storageManualBatchLimit)
	if err != nil || applied["applied"] != true {
		t.Fatalf("apply failed: %v %v", applied, err)
	}

	for _, removed := range []string{oldReceipt, oldCoord, oldDispatch, oldNotify} {
		if _, err := os.Stat(removed); !os.IsNotExist(err) {
			t.Fatalf("expected archived file to be removed from hot dir: %s", removed)
		}
	}
	for _, kept := range []string{activeReceipt, recentReceipt, pendingNotify, redLine} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected active/recent/red-line file to remain: %s", kept)
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

func TestStoragePruneRespectsDryRunAgeAndLegacyFlag(t *testing.T) {
	// Recurring bug class: persistence prune must default to dry-run and only remove expired archives and explicitly requested legacy directories.
	dir := t.TempDir()
	oldTime := time.Now().UTC().AddDate(0, 0, -120)
	recentTime := time.Now().UTC().AddDate(0, 0, -10)

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
	legacyFile := writeAged("usage/old.json", oldTime)
	accountFile := writeAged("accounts/index.json", oldTime)

	preview, err := runStoragePruneIn(context.Background(), dir, false, 90, true)
	if err != nil || preview["applied"] != false {
		t.Fatalf("dry-run prune failed: %v %v", preview, err)
	}
	if _, err := os.Stat(expiredArchive); err != nil {
		t.Fatal("dry-run prune deleted archive")
	}

	if _, err := runStoragePruneIn(context.Background(), dir, true, 90, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expiredArchive); !os.IsNotExist(err) {
		t.Fatal("expired archive was not removed")
	}
	if _, err := os.Stat(recentArchive); err != nil {
		t.Fatal("recent archive was removed")
	}
	if _, err := os.Stat(legacyFile); err != nil {
		t.Fatal("legacy dir removed without includeLegacy")
	}

	if _, err := runStoragePruneIn(context.Background(), dir, true, 90, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyFile); !os.IsNotExist(err) {
		t.Fatal("legacy dir was not removed when includeLegacy=true")
	}
	if _, err := os.Stat(accountFile); err != nil {
		t.Fatal("red-line accounts file was removed")
	}
}
