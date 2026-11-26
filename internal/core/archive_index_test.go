package core

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

func TestArchivedIndexFiltersAndPaginatesFreshNativeRows(t *testing.T) {
	// Recurring bug class: persistence archived search must remain fresh and use fast bounded native-index pages.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,updated_at INTEGER,cwd TEXT,title TEXT,source TEXT,model_provider TEXT);
		CREATE INDEX archive ON threads(archived,updated_at DESC,id DESC);`)
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for index := range 6000 {
		_, err := transaction.Exec("INSERT INTO threads VALUES(?1,1,?2,'/project','Search needle','cli','native')", fmt.Sprintf("id-%05d", index), index/2)
		if err != nil {
			_ = transaction.Rollback()
			t.Fatal(err)
		}
	}
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	result, err := codexArchivePage(t.Context(), db, object{"searchTerm": "NEEDLE", "limit": 20})
	if err != nil {
		t.Fatal(err)
	}
	first := decodedTaskList(result["data"])
	if len(first) != 20 || time.Since(start) >= time.Second {
		t.Fatalf("first indexed archive page = %d rows in %s", len(first), time.Since(start))
	}
	next, err := codexArchivePage(t.Context(), db, object{"searchTerm": "NEEDLE", "limit": 20, "cursor": result["nextCursor"]})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, row := range first {
		seen[text(row, "id")] = true
	}
	for _, row := range decodedTaskList(next["data"]) {
		if thread := text(row, "id"); seen[thread] {
			t.Fatalf("archive repeated thread %s", thread)
		}
	}
	if _, err := codexArchivePage(t.Context(), db, object{"searchTerm": "different", "cursor": result["nextCursor"]}); err == nil {
		t.Fatal("cursor accepted a different search")
	}
	if _, err := db.Exec("INSERT INTO threads VALUES('new',1,9999,'/project','Fresh needle','cli','native')"); err != nil {
		t.Fatal(err)
	}
	fresh, err := codexArchivePage(t.Context(), db, object{"searchTerm": "fresh"})
	if rows := decodedTaskList(fresh["data"]); err != nil || len(rows) != 1 || field(rows[0], "id") != "new" {
		t.Fatalf("fresh native archive row = %v, %v", fresh, err)
	}
	other, err := codexArchivePage(t.Context(), db, object{"cwd": []any{"/other"}})
	if err != nil || len(decodedTaskList(other["data"])) != 0 {
		t.Fatalf("other project indexed rows = %v, %v", other, err)
	}
}
