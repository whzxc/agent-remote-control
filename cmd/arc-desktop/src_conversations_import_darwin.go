package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/google/uuid"
	"golang.org/x/crypto/pbkdf2"
	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

type chromeCookie struct {
	host, name, path             string
	value, encrypted             []byte
	expires                      int64
	persistent, secure, httpOnly bool
	sameSite                     int
	partitioned                  bool
}

func chromeRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.New("home-missing")
	}
	return filepath.Join(home, "Library", "Application Support", "Google", "Chrome"), nil
}

func chromeProfiles() ([]object, error) {
	root, err := chromeRoot()
	if err != nil {
		return nil, err
	}
	var state object
	if err := readJSON(filepath.Join(root, "Local State"), &state); err != nil {
		var fileErr *os.PathError
		if errors.As(err, &fileErr) {
			return nil, errors.New("chrome-local-state-unavailable")
		}
		return nil, errors.New("chrome-local-state-invalid")
	}
	cache := objectValue(objectValue(state["profile"])["info_cache"])
	if cache == nil {
		return nil, errors.New("chrome-profiles-unavailable")
	}
	names := make([]string, 0, len(cache))
	for name := range cache {
		if name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	profiles := make([]object, 0, len(names))
	for _, name := range names {
		display, ok := objectValue(cache[name])["name"].(string)
		if !ok {
			display = name
		}
		profiles = append(profiles, object{"directory": name, "name": display})
	}
	return profiles, nil
}

func chromeProfileExists(profile string) error {
	profiles, err := chromeProfiles()
	if err != nil {
		return err
	}
	for _, row := range profiles {
		if row["directory"] == profile {
			return nil
		}
	}
	return errors.New("chrome-profile-not-found")
}

type cookieFileStamp struct {
	size     int64
	modified time.Time
}

func cookieStamp(path string) cookieFileStamp {
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return cookieFileStamp{info.Size(), info.ModTime()}
	}
	return cookieFileStamp{}
}

func copyChromeDB(source, root string) (string, error) {
	if cookieStamp(source) == (cookieFileStamp{}) {
		return "", errors.New("chrome-default-cookies-missing")
	}
	dir, err := os.MkdirTemp("", "arc-cookie-copy-")
	if err != nil {
		return "", errors.New("snapshot-temp-failed")
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(dir)
		}
	}()
	names := []string{"", "-wal", "-shm"}
	stamps := make([]cookieFileStamp, len(names))
	for i, suffix := range names {
		stamps[i] = cookieStamp(source + suffix)
	}
	for i, suffix := range names {
		if stamps[i] == (cookieFileStamp{}) {
			continue
		}
		path, err := filepath.EvalSymlinks(source + suffix)
		if err != nil || !filepath.IsLocal(relative(root, path)) {
			return "", errors.New("chrome-profile-outside-root")
		}
		err = copyCookieFile(path, filepath.Join(dir, "Cookies"+suffix))
		if err != nil {
			return "", errors.New("snapshot-copy-failed")
		}
	}
	for i, suffix := range names {
		if stamps[i] != cookieStamp(source+suffix) {
			return "", errors.New("chrome-db-changed-during-copy-retry-manually")
		}
	}
	success = true
	return dir, nil
}

func copyCookieFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	return errors.Join(err, out.Close())
}

func chromeCookieRows(dir string) (int, []chromeCookie, error) {
	db, err := sql.Open("sqlite", filepath.Join(dir, "Cookies"))
	if err != nil {
		return 0, nil, errors.New("snapshot-open-failed")
	}
	defer db.Close()
	var check string
	if db.QueryRow("PRAGMA quick_check").Scan(&check) != nil {
		return 0, nil, errors.New("snapshot-check-failed")
	}
	if check != "ok" {
		return 0, nil, errors.New("snapshot-integrity-failed")
	}
	var version int
	if db.QueryRow("SELECT CAST(value AS INTEGER) FROM meta WHERE key='version'").Scan(&version) != nil {
		return 0, nil, errors.New("snapshot-version-failed")
	}
	result, err := db.Query(`SELECT host_key, name, path, value, encrypted_value, expires_utc, is_persistent, is_secure, is_httponly, samesite,
		top_frame_site_key FROM cookies WHERE host_key IN ('claude.ai','.claude.ai','.anthropic.com')`)
	if err != nil {
		return 0, nil, errors.New("unsupported-cookie-schema")
	}
	defer result.Close()
	var entries []chromeCookie
	for result.Next() {
		var row chromeCookie
		var partition string
		if result.Scan(&row.host, &row.name, &row.path, &row.value, &row.encrypted, &row.expires, &row.persistent, &row.secure,
			&row.httpOnly, &row.sameSite, &partition) != nil {
			clearChromeRows(entries)
			return 0, nil, errors.New("snapshot-row-failed")
		}
		row.partitioned = partition != ""
		entries = append(entries, row)
	}
	if result.Err() != nil {
		clearChromeRows(entries)
		return 0, nil, errors.New("snapshot-row-failed")
	}
	return version, entries, nil
}

func clearChromeRows(entries []chromeCookie) {
	for _, row := range entries {
		clear(row.value)
		clear(row.encrypted)
	}
}

type passwordReply struct {
	password []byte
	err      error
}

type keychainRequest struct{ inFlight atomic.Bool }

func (k *keychainRequest) password(ctx context.Context, fetch func() ([]byte, error), timeout time.Duration) ([]byte, error) {
	if !k.inFlight.CompareAndSwap(false, true) {
		return nil, errors.New("keychain-request-still-pending")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result := make(chan passwordReply)
	go func() {
		password, err := fetch()
		k.inFlight.Store(false)
		select {
		case result <- passwordReply{password, err}:
		case <-ctx.Done():
			clear(password)
		}
	}()
	select {
	case reply := <-result:
		return reply.password, reply.err
	case <-ctx.Done():
		return nil, errors.New("keychain-timeout")
	}
}

type chromeSecurity struct {
	find func(uintptr, uint32, string, uint32, uintptr, *uint32, *unsafe.Pointer, uintptr) int32
	free func(uintptr, unsafe.Pointer) int32
}

var keychain = keychainRequest{}
var chromeSecurityAPI = sync.OnceValues(func() (chromeSecurity, error) {
	var api chromeSecurity
	lib, err := purego.Dlopen("/System/Library/Frameworks/Security.framework/Security", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return api, err
	}
	purego.RegisterLibFunc(&api.find, lib, "SecKeychainFindGenericPassword")
	purego.RegisterLibFunc(&api.free, lib, "SecKeychainItemFreeContent")
	return api, nil
})

func chromeSafeStorage() ([]byte, error) {
	api, err := chromeSecurityAPI()
	if err != nil {
		return nil, errors.New("keychain-unavailable")
	}
	const service = "Chrome Safe Storage"
	var size uint32
	var value unsafe.Pointer
	code := api.find(0, uint32(len(service)), service, 0, 0, &size, &value, 0)
	if code != 0 {
		return nil, errors.New("keychain-denied-or-unavailable")
	}
	if value == nil {
		return nil, errors.New("keychain-no-password")
	}
	defer api.free(0, value)
	return append([]byte(nil), unsafe.Slice((*byte)(value), size)...), nil
}

func decryptChromeCookie(encrypted, key []byte, host string, version int) ([]byte, error) {
	ciphertext, ok := bytes.CutPrefix(encrypted, []byte("v10"))
	if !ok {
		return nil, errors.New("unsupported-cookie-encryption")
	}
	block, err := aes.NewCipher(key)
	if err != nil || len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, errors.New("cookie-decrypt-failed")
	}
	iv := []byte("                ")
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(ciphertext, ciphertext)
	padding := int(ciphertext[len(ciphertext)-1])
	if padding < 1 || padding > aes.BlockSize {
		return nil, errors.New("cookie-decrypt-failed")
	}
	plain := ciphertext[:len(ciphertext)-padding]
	for _, pad := range ciphertext[len(plain):] {
		if int(pad) != padding {
			return nil, errors.New("cookie-decrypt-failed")
		}
	}
	if version >= 24 {
		digest := sha256.Sum256([]byte(host))
		if !bytes.HasPrefix(plain, digest[:]) {
			return nil, errors.New("cookie-host-digest-mismatch")
		}
		plain = plain[sha256.Size:]
	}
	return plain, nil
}

func decodeChromeRows(version int, entries []chromeCookie, key []byte, now int64) ([]chromeCookie, error) {
	cookies := make([]chromeCookie, 0, len(entries))
	success := false
	defer func() {
		if !success {
			clearChromeRows(cookies)
		}
	}()
	for _, row := range entries {
		row.expires = row.expires/1_000_000 - 11_644_473_600
		if strings.HasPrefix(row.name, "__cf") || strings.HasPrefix(row.name, "_cf") || strings.HasPrefix(row.name, "cf_") ||
			row.partitioned || (row.persistent && row.expires <= now) {
			continue
		}
		value := row.value
		if len(row.encrypted) > 0 {
			var err error
			value, err = decryptChromeCookie(row.encrypted, key, row.host, version)
			if err != nil {
				return nil, err
			}
		}
		if !utf8.Valid(value) {
			return nil, errors.New("cookie-value-not-utf8")
		}
		if row.sameSite < -1 || row.sameSite > 2 {
			return nil, errors.New("unsupported-samesite")
		}
		if row.persistent && time.Unix(row.expires, 0).Year() > 9999 {
			return nil, errors.New("invalid-cookie-expiry")
		}
		row.value, row.encrypted = append([]byte(nil), value...), nil
		cookies = append(cookies, row)
	}
	success = true
	return cookies, nil
}

func importChrome(ctx context.Context, profile string) ([]chromeCookie, error) {
	if unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{}) != nil {
		return nil, errors.New("core-dump-disable-failed")
	}
	root, err := chromeRoot()
	if err != nil {
		return nil, err
	}
	if err := chromeProfileExists(profile); err != nil {
		return nil, err
	}
	source := filepath.Join(root, profile, "Cookies")
	canonical, err := filepath.EvalSymlinks(source)
	if err != nil {
		return nil, errors.New("chrome-cookies-missing")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, errors.New("chrome-root-missing")
	}
	if !filepath.IsLocal(relative(root, canonical)) {
		return nil, errors.New("chrome-profile-outside-root")
	}
	dir, err := copyChromeDB(source, root)
	if err != nil {
		return nil, err
	}
	version, entries, err := chromeCookieRows(dir)
	defer clearChromeRows(entries)
	if os.RemoveAll(dir) != nil {
		return nil, errors.New("snapshot-cleanup-failed")
	}
	if err != nil {
		return nil, err
	}
	password, err := keychain.password(ctx, chromeSafeStorage, 180*time.Second)
	if err != nil {
		return nil, err
	}
	key := pbkdf2.Key(password, []byte("saltysalt"), 1003, 16, sha1.New)
	clear(password)
	defer clear(key)
	return decodeChromeRows(version, entries, key, time.Now().Unix())
}

func lastActiveOrg(cookies []chromeCookie) *uuid.UUID {
	var org *uuid.UUID
	for _, cookie := range cookies {
		if cookie.name != "lastActiveOrg" || (cookie.host != "claude.ai" && cookie.host != ".claude.ai") {
			continue
		}
		candidate, err := uuid.Parse(string(cookie.value))
		if err != nil || (org != nil && *org != candidate) {
			return nil
		}
		org = &candidate
	}
	return org
}
