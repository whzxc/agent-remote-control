package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	cryptohash "hash"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const deviceTransferBlock = 256 * 1024
const deviceTransferLANRange = 16 * 1024 * 1024
const deviceTransferTunnelRange = 64 * 1024
const deviceTransferTunnelCap = 512 * 1024

func resolveDeviceTransferPath(raw string) (string, error) {
	if !filepath.IsAbs(raw) {
		return "", errors.New("INVALID_PATH: use an absolute host path")
	}
	if err := checkProtectedPath(raw); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(raw)
	if errors.Is(err, os.ErrNotExist) {
		parent, problem := filepath.EvalSymlinks(filepath.Dir(raw))
		if problem != nil {
			return "", problem
		}
		resolved, err = filepath.Join(parent, filepath.Base(raw)), nil
	}
	if err != nil {
		return "", err
	}
	return resolved, checkProtectedPath(resolved)
}

func deviceTransferFingerprint(path string) (object, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("INVALID_PATH: source must be a regular file")
	}
	var modified any
	if at := info.ModTime(); !at.IsZero() && at.Unix() >= 0 {
		modified = strconv.FormatInt(at.Unix(), 10) + fmt.Sprintf("%09d", at.Nanosecond())
		modified = strings.TrimLeft(str(modified), "0")
		if modified == "" {
			modified = "0"
		}
	}
	return object{"total": info.Size(), "modified": modified}, nil
}

func deviceTransferFree(path string, need uint64) error {
	available, err := deviceTransferAvailable(path)
	if err != nil {
		return err
	}
	if available < need {
		return errors.New("INSUFFICIENT_DISK_SPACE: free space is smaller than the remaining transfer")
	}
	return nil
}

func deviceTransferSpace(blocks, blockSize uint64) uint64 {
	if blockSize != 0 && blocks > math.MaxUint64/blockSize {
		return math.MaxUint64
	}
	return blocks * blockSize
}

type transferLock struct {
	slot chan struct{}
	refs int
}

var transferLocks = struct {
	sync.Mutex
	all map[string]*transferLock
}{all: map[string]*transferLock{}}

func lockDeviceFile(ctx context.Context, path string) (func(), error) {
	transferLocks.Lock()
	entry := transferLocks.all[path]
	if entry == nil {
		entry = &transferLock{slot: make(chan struct{}, 1)}
		transferLocks.all[path] = entry
	}
	entry.refs++
	transferLocks.Unlock()
	release := func() {
		transferLocks.Lock()
		defer transferLocks.Unlock()
		entry.refs--
		if entry.refs == 0 {
			delete(transferLocks.all, path)
		}
	}
	select {
	case entry.slot <- struct{}{}:
		return func() { <-entry.slot; release() }, nil
	case <-ctx.Done():
		release()
		return nil, ctx.Err()
	}
}

type deviceReceiverStore struct {
	entries sync.Map // request ID -> *deviceReceiver
}

type deviceReceiver struct {
	mu         sync.Mutex
	manifest   string
	meta       object
	file       *os.File
	sha        cryptohash.Hash
	pathUnlock func()
	published  bool
}

func receiverManifest(directory, request string) (string, error) {
	if _, err := uuid.Parse(request); err != nil {
		return "", errors.New("INVALID_REQUEST_ID")
	}
	return filepath.Join(directory, request+".json"), nil
}

func (store *deviceReceiverStore) get(ctx context.Context, directory, request string) (*deviceReceiver, error) {
	manifest, err := receiverManifest(directory, request)
	if err != nil {
		return nil, err
	}
	unlock := lockReceipt("transfer-load:" + manifest)
	defer unlock()
	if value, ok := store.entries.Load(request); ok {
		return value.(*deviceReceiver), nil
	}
	raw, err := load(manifest)
	if err != nil {
		return nil, err
	}
	meta := obj(raw)
	if meta == nil {
		return nil, errors.New("TRANSFER_CORRUPT: invalid transfer manifest")
	}
	receiver := &deviceReceiver{manifest: manifest, meta: meta, sha: sha256.New()}
	if meta["state"] == "receiving" {
		if err := receiver.recover(ctx); err != nil {
			receiver.close()
			return nil, err
		}
	}
	store.entries.Store(request, receiver)
	return receiver, nil
}

func (r *deviceReceiver) recover(ctx context.Context) error {
	path, temporary := text(r.meta, "path"), text(r.meta, "temporary")
	if err := checkProtectedPath(path); err != nil {
		return err
	}
	unlock, err := lockDeviceFile(ctx, path)
	if err != nil {
		return err
	}
	r.pathUnlock = unlock
	offset := r.offset()
	if offset > math.MaxInt64 {
		return errors.New("TRANSFER_CORRUPT: invalid verified offset")
	}
	_, partErr := os.Stat(temporary)
	published := errors.Is(partErr, os.ErrNotExist) && uintOr(field(r.meta["spec"], "total"), 0) == offset
	readPath, flags := temporary, os.O_RDWR
	if published {
		readPath, flags = path, os.O_RDONLY
	}
	file, err := os.OpenFile(readPath, flags, 0)
	if err != nil {
		return err
	}
	r.file = file
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if uint64(info.Size()) < offset {
		return errors.New("TRANSFER_CORRUPT: temporary file is shorter than verified offset")
	}
	if published {
		if uint64(info.Size()) != offset {
			return errors.New("TRANSFER_CORRUPT: published destination length changed")
		}
	} else if err := file.Truncate(int64(offset)); err != nil {
		return err
	}
	if _, err := io.CopyN(r.sha, file, int64(offset)); err != nil {
		return errors.New("TRANSFER_CORRUPT: incomplete verified prefix")
	}
	if hex.EncodeToString(r.sha.Sum(nil)) != text(r.meta, "sha256") {
		return errors.New("SHA256_MISMATCH: verified temporary prefix changed")
	}
	if published {
		next := clone(r.meta)
		next["state"] = "completed"
		if err := r.save(next); err != nil {
			return err
		}
		r.close()
	}
	return nil
}

func (store *deviceReceiverStore) begin(ctx context.Context, directory, request string, spec object) (object, error) {
	manifest, err := receiverManifest(directory, request)
	if err != nil {
		return nil, err
	}
	unlock := lockReceipt("transfer:" + manifest)
	defer unlock()
	if _, err := os.Stat(manifest); err == nil {
		r, err := store.get(ctx, directory, request)
		if err != nil {
			return nil, err
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.meta["state"] == "cancelled" && field(r.meta["spec"], "peer") == spec["peer"] {
			return clone(r.meta), nil
		}
		if wire(r.meta["spec"]) != wire(spec) {
			return nil, errors.New("REQUEST_ID_CONFLICT: transfer parameters differ")
		}
		if r.meta["state"] == "receiving" {
			total := uintOr(spec["total"], 0)
			if r.offset() > total {
				return nil, errors.New("OFFSET_MISMATCH")
			}
			if err := deviceTransferFree(filepath.Dir(text(r.meta, "path")), total-r.offset()); err != nil {
				return nil, err
			}
		}
		return clone(r.meta), nil
	}
	path, err := resolveDeviceTransferPath(text(spec, "path"))
	if err != nil {
		return nil, err
	}
	pathUnlock, err := lockDeviceFile(ctx, path)
	if err != nil {
		return nil, err
	}
	admitted := false
	defer func() {
		if !admitted {
			pathUnlock()
		}
	}()
	admit := lockReceipt("transfer-admit:" + manifest)
	defer admit()
	if raw, err := load(manifest); err == nil {
		meta := obj(raw)
		if meta["state"] == "cancelled" && field(meta["spec"], "peer") == spec["peer"] {
			return meta, nil
		}
		return nil, errors.New("REQUEST_ID_CONFLICT: receiver was already admitted")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if _, err := os.Stat(path); err == nil && spec["overwrite"] != true {
		return nil, errors.New("DESTINATION_EXISTS: set overwrite:true to replace the destination")
	}
	total, ok := uintValue(spec["total"])
	if !ok {
		return nil, errors.New("INVALID_ARGUMENT: total is required")
	}
	if err := deviceTransferFree(filepath.Dir(path), total); err != nil {
		return nil, err
	}
	part := filepath.Join(filepath.Dir(path), ".arc-transfer-"+request+".part")
	file, err := os.OpenFile(part, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0666)
	if err != nil {
		return nil, err
	}
	receiver := &deviceReceiver{manifest: manifest, file: file, sha: sha256.New(), pathUnlock: pathUnlock}
	meta := object{"spec": spec, "path": path, "temporary": part, "offset": 0, "sha256": hash(nil), "state": "receiving"}
	if err := receiver.save(meta); err != nil {
		file.Close()
		_ = os.Remove(part)
		return nil, err
	}
	admitted = true
	store.entries.Store(request, receiver)
	return clone(meta), nil
}

func (store *deviceReceiverStore) cancel(ctx context.Context, directory, request, peer string) (object, error) {
	manifest, err := receiverManifest(directory, request)
	if err != nil {
		return nil, err
	}
	unlock := lockReceipt("transfer-admit:" + manifest)
	_, err = os.Stat(manifest)
	if errors.Is(err, os.ErrNotExist) {
		r := &deviceReceiver{manifest: manifest}
		meta := object{"spec": object{"peer": peer}, "state": "cancelled", "offset": 0}
		err := r.save(meta)
		unlock()
		return meta, err
	}
	unlock()
	if err != nil {
		return nil, err
	}
	r, err := store.get(ctx, directory, request)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if field(r.meta["spec"], "peer") != peer {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer")
	}
	return r.cancel()
}

func (store *deviceReceiverStore) close() {
	store.entries.Range(func(k, value any) bool {
		r := value.(*deviceReceiver)
		r.mu.Lock()
		r.close()
		r.mu.Unlock()
		store.entries.Delete(k)
		return true
	})
}

func (r *deviceReceiver) offset() uint64 { return uintOr(r.meta["offset"], 0) }

func (r *deviceReceiver) save(meta object) error {
	if err := save(r.manifest, meta); err != nil {
		return err
	}
	r.meta = meta
	file, err := os.OpenFile(r.manifest, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return err
	}
	return syncDeviceTransferParent(r.manifest)
}

func (r *deviceReceiver) close() {
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	if r.pathUnlock != nil {
		r.pathUnlock()
		r.pathUnlock = nil
	}
}

func (r *deviceReceiver) cancel() (object, error) {
	if r.published && r.meta["state"] != "completed" {
		return r.commit()
	}
	if r.meta["state"] == "completed" {
		return clone(r.meta), nil
	}
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	if part := text(r.meta, "temporary"); part != "" {
		if err := os.Remove(part); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	next := clone(r.meta)
	next["state"] = "cancelled"
	err := r.save(next)
	if r.meta["state"] == next["state"] {
		r.close()
	}
	if err != nil {
		return nil, err
	}
	return clone(next), nil
}

func (r *deviceReceiver) receive(ctx context.Context, body io.Reader, offset, length uint64, expected func() string) error {
	if r.meta["state"] != "receiving" || r.file == nil {
		return errors.New("TRANSFER_TERMINAL: receiver is no longer writable")
	}
	if offset != r.offset() {
		return errors.New("OFFSET_MISMATCH: read the receiver verified offset before resume")
	}
	total := uintOr(field(r.meta["spec"], "total"), 0)
	if offset > total || length > total-offset || offset > math.MaxInt64 || length > math.MaxInt64-offset {
		return errors.New("OFFSET_MISMATCH: range exceeds source length")
	}
	cloner, ok := r.sha.(cryptohash.Cloner)
	if !ok {
		return errors.New("Cannot clone the verified transfer digest")
	}
	fullDigest, err := cloner.Clone()
	if err != nil {
		return err
	}
	rangeDigest := sha256.New()
	if _, err := r.file.Seek(int64(offset), io.SeekStart); err != nil {
		return err
	}
	verified := false
	defer func() {
		if !verified {
			if err := r.file.Truncate(int64(offset)); err != nil {
				recordLog("ERROR", err.Error(), nil)
			}
		}
	}()
	writer := io.MultiWriter(r.file, fullDigest, rangeDigest)
	buf := make([]byte, min(length+1, deviceTransferBlock))
	var copied uint64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		size, err := body.Read(buf[:min(length-copied+1, uint64(len(buf)))])
		if uint64(size) > length-copied {
			return errors.New("OFFSET_MISMATCH: oversized range")
		}
		copied += uint64(size)
		if size != 0 {
			if _, err := writer.Write(buf[:size]); err != nil {
				return err
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if copied != length {
		return errors.New("OFFSET_MISMATCH: incomplete range")
	}
	if expected() != hex.EncodeToString(rangeDigest.Sum(nil)) {
		return errors.New("SHA256_MISMATCH: range trailer differs")
	}
	if err := r.file.Sync(); err != nil {
		return err
	}
	next := clone(r.meta)
	next["offset"], next["sha256"] = offset+length, hex.EncodeToString(fullDigest.Sum(nil))
	err = r.save(next)
	if r.offset() == offset+length {
		r.sha, verified = fullDigest, true
	}
	return err
}

func (r *deviceReceiver) commit() (object, error) {
	if r.meta["state"] == "completed" {
		return clone(r.meta), nil
	}
	if r.meta["state"] != "receiving" || r.file == nil || uintOr(field(r.meta["spec"], "total"), 0) != r.offset() {
		return nil, errors.New("OFFSET_MISMATCH: receive all verified bytes before commit")
	}
	sha := hex.EncodeToString(r.sha.Sum(nil))
	if expected, ok := field(r.meta["spec"], "expectedSha256").(string); ok && !strings.EqualFold(expected, sha) {
		return nil, errors.New("SHA256_MISMATCH: destination unchanged")
	}
	if err := r.file.Sync(); err != nil {
		return nil, err
	}
	temporary, path := text(r.meta, "temporary"), text(r.meta, "path")
	if !r.published {
		var err error
		if field(r.meta["spec"], "overwrite") == true {
			err = platform.ReplaceFile(temporary, path)
		} else {
			err = renameNewDeviceTransfer(temporary, path)
			if errors.Is(err, os.ErrExist) {
				err = fmt.Errorf("DESTINATION_EXISTS: %w", err)
			}
		}
		if err != nil {
			return nil, err
		}
		r.published = true
	}
	if err := syncDeviceTransferParent(path); err != nil {
		return nil, err
	}
	next := clone(r.meta)
	next["state"], next["sha256"] = "completed", sha
	err := r.save(next)
	if r.meta["state"] == next["state"] {
		r.close()
	}
	if err != nil {
		return nil, err
	}
	return clone(next), nil
}
