package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestEncryptedDatabaseVersionsAndHostIntegrity(t *testing.T) {
	// Recurring bug class: security Chrome v24 cookies are bound to the original host.
	for _, version := range []int{23, 24} {
		root, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		source := filepath.Join(root, "Cookies")
		db, err := sql.Open("sqlite", source)
		if err != nil {
			t.Fatal(err)
		}
		key := bytes.Repeat([]byte{7}, 16)
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		encode := func(value string) []byte {
			plain := []byte(value)
			if version == 24 {
				digest := sha256.Sum256([]byte(".claude.ai"))
				plain = append(digest[:], plain...)
			}
			pad := aes.BlockSize - len(plain)%aes.BlockSize
			plain = append(plain, bytes.Repeat([]byte{byte(pad)}, pad)...)
			cipher.NewCBCEncrypter(block, bytes.Repeat([]byte{' '}, 16)).CryptBlocks(plain, plain)
			return append([]byte("v10"), plain...)
		}
		exec := func(db *sql.DB, statement string, args ...any) {
			t.Helper()
			if _, err := db.Exec(statement, args...); err != nil {
				t.Fatal(err)
			}
		}
		exec(db, `CREATE TABLE meta(key TEXT,value TEXT);
			CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER,
			is_persistent INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT);`)
		exec(db, "INSERT INTO meta VALUES ('version', ?)", version)
		for _, input := range []struct{ host, name string }{
			{".claude.ai", "sessionKey"}, {".claude.ai", "cf_clearance"}, {"unrelated.example", "sessionKey"},
		} {
			exec(db, "INSERT INTO cookies VALUES (?,?,'/','',?,0,0,1,1,1,'')", input.host, input.name, encode("synthetic-value"))
		}
		const org = "550e8400-e29b-41d4-a716-446655440000"
		exec(db, "INSERT INTO cookies VALUES ('.claude.ai','lastActiveOrg','/','',?,0,0,1,0,1,'')", encode(org))
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		read := func(key []byte) ([]chromeCookie, error) {
			dir, err := copyChromeDB(source, root)
			if err != nil {
				return nil, err
			}
			defer os.RemoveAll(dir)
			gotVersion, rows, err := chromeCookieRows(dir)
			if err != nil {
				return nil, err
			}
			defer clearChromeRows(rows)
			if version != gotVersion {
				return nil, fmt.Errorf("version %d, want %d", gotVersion, version)
			}
			return decodeChromeRows(gotVersion, rows, key, 1_700_000_000)
		}
		result, err := read(key)
		if err != nil {
			t.Fatal(err)
		}
		if len(result) != 2 {
			t.Fatalf("version %d returned %d allowed cookies", version, len(result))
		}
		if got := lastActiveOrg(result); got == nil || got.String() != org {
			t.Fatal("organization mismatch")
		}
		session := result[0]
		if session.host != ".claude.ai" || string(session.value) != "synthetic-value" || !session.secure || !session.httpOnly || session.sameSite != 1 {
			t.Fatal("session cookie projection lost host, value or flags")
		}
		if _, err := read(bytes.Repeat([]byte{9}, 16)); err == nil {
			t.Fatal("incorrect key accepted")
		}
		if version == 24 {
			db, err = sql.Open("sqlite", source)
			if err != nil {
				t.Fatal(err)
			}
			exec(db, "UPDATE cookies SET host_key='claude.ai' WHERE name='sessionKey' AND host_key='.claude.ai'")
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := read(key); err == nil || err.Error() != "cookie-host-digest-mismatch" {
				t.Fatalf("expected host mismatch, got %v", err)
			}
		}
	}
}
