package core

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const respondTokenTTL = 24 * 60 * 60

var respondTokenLock sync.Mutex
var respondTokenFormat = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func issueRespondTokenAt(dir, source string, request object, at int64) error {
	if source == "" || request["canRespond"] == false || request["backendSession"] == nil || request["id"] == nil {
		return nil
	}
	backend := request["backendSession"]
	if request["owner"] == "desktop" {
		backend = nil
	}
	path := filepath.Join(dir, hash([]byte(wire([]any{source, request["owner"], request["id"], backend})))+".json")
	stored, _ := cachedLoad(path)
	record := obj(stored)
	if uintOr(record["expiresAt"], 0) <= uint64(at) {
		token := newUUID()
		record = object{"token": base64.RawURLEncoding.EncodeToString(token[:]), "expiresAt": at + respondTokenTTL,
			"sourceId": source, "request": request}
		if err := save(path, record); err != nil {
			return err
		}
	}
	if record["used"] != true {
		request["respondToken"] = record["token"]
		request["respondTokenExpiresAt"] = record["expiresAt"]
	}
	return nil
}

func issueRespondToken(source string, request object) error {
	respondTokenLock.Lock()
	defer respondTokenLock.Unlock()
	return issueRespondTokenAt(filepath.Join(root(), "respond-tokens"), source, request, time.Now().Unix())
}

func resolveRespondTokenAt(dir, source, token string, thread *string, at int64) (string, object, error) {
	if source == "" {
		return "", nil, errors.New("SOURCE_REQUIRED")
	}
	if !respondTokenFormat.MatchString(token) {
		return "", nil, errors.New("RESPOND_TOKEN_INVALID_OR_EXPIRED")
	}
	entries, _ := cachedEntries(dir)
	for _, entry := range entries {
		path := entry.path
		value, err := cachedLoad(path)
		record := obj(value)
		if err != nil || record["token"] != token {
			continue
		}
		if record["sourceId"] != source {
			return "", nil, errors.New("RESPOND_TOKEN_SCOPE_MISMATCH")
		}
		if record["used"] == true || uintOr(record["expiresAt"], 0) <= uint64(at) {
			return "", nil, errors.New("RESPOND_TOKEN_EXPIRED_OR_RESOLVED")
		}
		if thread != nil && field(field(record["request"], "params"), "threadId") != *thread {
			return "", nil, errors.New("RESPOND_TOKEN_SCOPE_MISMATCH")
		}
		return path, record, nil
	}
	return "", nil, errors.New("RESPOND_TOKEN_INVALID_OR_EXPIRED")
}

func resolveRespondToken(ctx context.Context, args object) (object, error) {
	respondTokenLock.Lock()
	defer respondTokenLock.Unlock()
	var thread *string
	if name, ok := args["threadId"].(string); ok {
		thread = &name
	}
	_, record, err := resolveRespondTokenAt(filepath.Join(root(), "respond-tokens"), text(currentOrigin(ctx), "sourceId"),
		text(args, "respondToken"), thread, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	return clone(obj(record["request"])), nil
}

func consumeRespondToken(ctx context.Context, args object) error {
	if args["respondToken"] == nil {
		return nil
	}
	respondTokenLock.Lock()
	defer respondTokenLock.Unlock()
	var thread *string
	if name, ok := args["threadId"].(string); ok {
		thread = &name
	}
	path, record, err := resolveRespondTokenAt(filepath.Join(root(), "respond-tokens"), text(currentOrigin(ctx), "sourceId"),
		text(args, "respondToken"), thread, 0)
	if err != nil {
		return err
	}
	record = clone(record)
	record["used"] = true
	return save(path, record)
}
