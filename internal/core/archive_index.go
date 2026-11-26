package core

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const archiveIndexPrefix = "archive-index:"

func codexArchiveDatabase(home string) string {
	entries, _ := os.ReadDir(home)
	var path string
	var newest uint64
	for _, entry := range entries {
		suffix, prefix := strings.CutPrefix(entry.Name(), "state_")
		version, suffixOK := strings.CutSuffix(suffix, ".sqlite")
		n, err := strconv.ParseUint(strings.TrimPrefix(version, "+"), 10, 32)
		if prefix && suffixOK && err == nil && (path == "" || n >= newest) {
			newest, path = n, filepath.Join(home, entry.Name())
		}
	}
	return path
}

func openCodexArchive(path string, wait bool) (*sql.DB, error) {
	address := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := url.Values{"mode": {"ro"}}
	if wait {
		query.Set("_pragma", "busy_timeout(100)")
	}
	address.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", address.String())
	if err == nil {
		db.SetMaxOpenConns(1)
	}
	return db, err
}

func listCodexArchive(ctx context.Context, home string, args object) (object, error) {
	path := codexArchiveDatabase(home)
	if path == "" {
		return nil, nil
	}
	db, err := openCodexArchive(path, true)
	if err == nil {
		defer db.Close()
		var page object
		page, err = codexArchivePage(ctx, db, args)
		if err == nil {
			return page, nil
		}
	}
	switch {
	case strings.HasPrefix(err.Error(), "ARCHIVE_CURSOR_"):
		return nil, err
	case strings.HasPrefix(text(args, "cursor"), archiveIndexPrefix):
		return nil, errors.New("ARCHIVE_INDEX_UNAVAILABLE: omit cursor to restart using the native listing")
	default:
		return nil, nil
	}
}

func codexArchivePage(ctx context.Context, db *sql.DB, args object) (object, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info(threads)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var id, notNull, primary int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&id, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, required := range []string{"id", "archived", "updated_at", "cwd", "title", "source", "model_provider"} {
		if !columns[required] {
			return nil, errors.New("ARCHIVE_INDEX_SCHEMA_UNSUPPORTED")
		}
	}
	optional := func(column string) string {
		if columns[column] {
			return "COALESCE(" + column + ",'')"
		}
		return "''"
	}
	updated := "updated_at*1000"
	if columns["updated_at_ms"] {
		updated = "COALESCE(updated_at_ms,updated_at*1000)"
	}
	title := "title"
	if columns["name"] {
		title = "COALESCE(NULLIF(name,''),title)"
	}
	preview, prompt := optional("preview"), optional("first_user_message")
	search, cwd := text(args, "searchTerm"), ""
	switch paths := args["cwd"].(type) {
	case []any:
		if len(paths) != 0 {
			cwd = str(paths[0])
		}
	case []string:
		if len(paths) != 0 {
			cwd = paths[0]
		}
	}
	binding := hash([]byte(wire([]string{search, cwd})))
	var before any
	beforeID := ""
	if cursor, supplied := args["cursor"].(string); supplied {
		token, ok := strings.CutPrefix(cursor, archiveIndexPrefix)
		if !ok {
			return nil, errors.New("ARCHIVE_CURSOR_MISMATCH: omit cursor when switching native/index listing")
		}
		raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
		var position object
		if err != nil || decodeObject(raw, &position) != nil {
			return nil, errors.New("ARCHIVE_CURSOR_INVALID")
		}
		if position["binding"] != binding {
			return nil, errors.New("ARCHIVE_CURSOR_MISMATCH: reuse searchTerm/project or omit cursor")
		}
		updated, err := strconv.ParseInt(wire(position["updated"]), 10, 64)
		id, ok := position["id"].(string)
		if err != nil || !ok {
			return nil, errors.New("ARCHIVE_CURSOR_INVALID")
		}
		before, beforeID = updated, id
	}
	limit := max(1, min(100, uintOr(args["limit"], 20)))
	query := fmt.Sprintf("SELECT id,%[1]s,%[2]s,cwd,%[3]s,model_provider,%[4]s,%[5]s FROM threads WHERE archived=1 AND source NOT LIKE '%%subagent%%' AND (?1='' OR instr(lower(%[1]s || ' ' || %[2]s || ' ' || %[6]s),lower(?1))>0) AND (?2='' OR cwd=?2) AND (?3 IS NULL OR %[3]s < ?3 OR (%[3]s=?3 AND id<?4)) ORDER BY %[3]s DESC,id DESC LIMIT ?5",
		title, preview, updated, optional("model"), optional("reasoning_effort"), prompt)
	page, err := db.QueryContext(ctx, query, search, cwd, before, beforeID, int64(limit+1))
	if err != nil {
		return nil, err
	}
	defer page.Close()
	data := []object{}
	var last int64
	var next any
	for page.Next() {
		var id, title, preview, cwd, provider, model, effort string
		var updated int64
		if err := page.Scan(&id, &title, &preview, &cwd, &updated, &provider, &model, &effort); err != nil {
			return nil, err
		}
		if uint64(len(data)) == limit {
			next = archiveIndexPrefix + base64.RawURLEncoding.EncodeToString([]byte(wire(object{"binding": binding, "updated": last, "id": data[len(data)-1]["id"]})))
			break
		}
		last = updated
		data = append(data, object{"id": id, "name": title, "preview": preview, "cwd": cwd, "updatedAt": updated / 1000,
			"modelProvider": provider, "model": model, "reasoningEffort": effort})
	}
	if err := page.Err(); err != nil {
		return nil, err
	}
	return object{"data": data, "nextCursor": next, "metadataSource": "native-sqlite-index"}, nil
}

func codexSpawnedDescendants(ctx context.Context, home, thread string) ([][2]string, error) {
	path := codexArchiveDatabase(home)
	if path == "" {
		return nil, errors.New("CODEX_STATE_INDEX_MISSING")
	}
	db, err := openCodexArchive(path, false)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var exists bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)", thread).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("DESKTOP_HANDBACK_THREAD_NOT_INDEXED")
	}
	rows, err := db.QueryContext(ctx, `WITH RECURSIVE subtree(id) AS (
		SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id=?1
		UNION SELECT child_thread_id FROM thread_spawn_edges JOIN subtree ON parent_thread_id=subtree.id
	) SELECT e.child_thread_id,e.parent_thread_id FROM thread_spawn_edges e JOIN subtree ON e.child_thread_id=subtree.id`, thread)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := [][2]string{}
	for rows.Next() {
		var row [2]string
		if err := rows.Scan(&row[0], &row[1]); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
