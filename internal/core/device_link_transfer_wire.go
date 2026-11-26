package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

func deviceTransferFailure(message string) object {
	var value object
	_ = decodeObject([]byte(message), &value)
	if text(value, "code") == "" {
		value = object{"code": managementErrorCode(message), "message": message}
	}
	if value["next"] == nil {
		value["next"] = object{"via": "query", "op": "guide", "args": object{"op": "device_transfer"}}
	}
	return value
}

func transferWireReply(w http.ResponseWriter, value any, err error) {
	reply := object{"ok": true, "result": value}
	if err != nil {
		reply = object{"ok": false, "error": deviceTransferFailure(err.Error())}
	}
	w.Header()["Content-Type"] = nil
	_, _ = io.WriteString(w, wire(reply))
}

func streamDeviceTransfer(path string, offset, length uint64, trailers http.Header) (io.ReadCloser, error) {
	if offset > math.MaxInt64 || length > math.MaxInt64-offset {
		return nil, errors.New("OFFSET_MISMATCH: invalid range")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	section := io.NewSectionReader(file, int64(offset), int64(length))
	digest := sha256.New()
	remaining := length
	return &deviceTransferReadCloser{close: file.Close, read: func(dst []byte) (int, error) {
		if remaining == 0 {
			trailers.Set("X-Arc-Sha256", hex.EncodeToString(digest.Sum(nil)))
			return 0, io.EOF
		}
		n, err := section.Read(dst)
		if n > 0 {
			digest.Write(dst[:n])
			remaining -= uint64(n)
		}
		if err == io.EOF && remaining != 0 {
			return n, io.ErrUnexpectedEOF
		}
		return n, err
	}}, nil
}

type deviceTransferReadCloser struct {
	close func() error
	read  func([]byte) (int, error)
}

func (r *deviceTransferReadCloser) Read(dst []byte) (int, error) { return r.read(dst) }
func (r *deviceTransferReadCloser) Close() error                 { return r.close() }

func readTransferWireReply(response *http.Response) (any, error) {
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, errors.New("length limit exceeded")
	}
	var result any
	if err := canonjson.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	if field(result, "ok") != true {
		return nil, errors.New(wire(field(result, "error")))
	}
	return field(result, "result"), nil
}

type deviceTransferLink struct {
	path   devicePreparedPath
	member *deviceMember
}

func (link *deviceTransferLink) size() uint64 {
	if link.path.lan == nil {
		return deviceTransferTunnelRange
	}
	return deviceTransferLANRange
}

func (link *deviceTransferLink) control(ctx context.Context, body object) (any, error) {
	body["version"] = deviceProtocolVersion
	if link.path.lan != nil {
		return link.path.lan.request(ctx, deviceReadPath+"transfer/control", body, 25*time.Second)
	}
	return devicePostTunnel(ctx, link.path.tunnelURL, "transfer/control", link.path.token, body, 25*time.Second)
}

func readDeviceTransferRange(path string, offset, length, limit uint64) ([]byte, error) {
	if length > limit {
		return nil, errors.New("DEVICE_TUNNEL_LIMIT: range exceeds the transport cap")
	}
	if offset > math.MaxInt64 || length > math.MaxInt64-offset {
		return nil, errors.New("OFFSET_MISMATCH: invalid range")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data := make([]byte, length)
	_, err = io.ReadFull(io.NewSectionReader(file, int64(offset), int64(length)), data)
	return data, err
}

func (link *deviceTransferLink) upload(ctx context.Context, request, path string, offset, length uint64) (any, error) {
	if link.path.lan == nil {
		data, err := readDeviceTransferRange(path, offset, length, deviceTransferTunnelCap)
		if err != nil {
			return nil, err
		}
		return link.control(ctx, object{"action": "put", "requestId": request, "offset": offset,
			"sha256": hash(data), "data": base64.StdEncoding.EncodeToString(data)})
	}
	trailers := http.Header{"X-Arc-Sha256": nil}
	body, err := streamDeviceTransfer(path, offset, length, trailers)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://arc-peer.local"+deviceReadPath+"transfer/upload", body)
	if err != nil {
		return nil, err
	}
	req.Trailer = trailers
	req.Header.Set("X-Arc-Request", request)
	req.Header.Set("X-Arc-Offset", strconv.FormatUint(offset, 10))
	req.Header.Set("X-Arc-Length", strconv.FormatUint(length, 10))
	response, err := link.path.lan.connection.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	return readTransferWireReply(response)
}

func (link *deviceTransferLink) download(ctx context.Context, request, path string, stamp any, receiver *deviceReceiver, length uint64) error {
	offset := receiver.offset()
	if link.path.lan == nil {
		result, err := link.control(ctx, object{"action": "get", "requestId": request, "path": path, "fingerprint": stamp, "offset": offset, "length": length})
		if err != nil {
			return err
		}
		data, err := base64.StdEncoding.Strict().DecodeString(text(result, "data"))
		if err != nil {
			return err
		}
		return receiver.receive(ctx, bytes.NewReader(data), offset, length, func() string { return text(result, "sha256") })
	}
	content := wire(object{"version": deviceProtocolVersion, "path": path, "offset": offset, "length": length, "fingerprint": stamp})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://arc-peer.local"+deviceReadPath+"transfer/download", strings.NewReader(content))
	if err != nil {
		return err
	}
	req.GetBody = nil
	response, err := link.path.lan.connection.RoundTrip(req)
	if err != nil {
		return err
	}
	if response.Header.Get("Content-Type") != "application/octet-stream" {
		_, err := readTransferWireReply(response)
		return err
	}
	defer response.Body.Close()
	return receiver.receive(ctx, response.Body, offset, length, func() string { return response.Trailer.Get("X-Arc-Sha256") })
}

func (m *deviceManager) authorizeTransfer(ctx context.Context, id string) error {
	value, err := m.business(ctx, id, object{"version": deviceProtocolVersion, "tool": "query", "body": object{"op": "guide", "args": object{"op": "fs"}}, "origin": object{}})
	if err != nil {
		return err
	}
	if field(value, "isError") == true {
		return errors.New("DEVICE_PEER_FORBIDDEN: peer source has no host file authority")
	}
	return nil
}

func (m *deviceManager) transferControl(ctx context.Context, id string, body object) (any, error) {
	if err := m.authorizeTransfer(ctx, id); err != nil {
		return nil, err
	}
	return m.transferControlAuthorized(ctx, id, body)
}

func (m *deviceManager) transferControlAuthorized(ctx context.Context, id string, body object) (any, error) {
	action := text(body, "action")
	if action == "stat" || action == "get" {
		path, stamp, err := deviceTransferSource(body)
		if err != nil {
			return nil, err
		}
		if action == "stat" {
			return stamp, nil
		}
		if wire(stamp) != wire(body["fingerprint"]) {
			return nil, errors.New("SOURCE_CHANGED: restart with a new requestId")
		}
		offset, length, err := deviceTransferRange(body)
		if err != nil {
			return nil, err
		}
		data, err := readDeviceTransferRange(path, offset, length, deviceTransferTunnelCap)
		if err != nil {
			return nil, err
		}
		return object{"data": base64.StdEncoding.EncodeToString(data), "sha256": hash(data)}, nil
	}
	request := text(body, "requestId")
	directory := filepath.Join(m.directory, "transfer-receivers")
	store := &m.transfers
	switch action {
	case "begin":
		spec := clone(obj(body["spec"]))
		if spec == nil {
			spec = object{}
		}
		spec["peer"] = id
		return store.begin(ctx, directory, request, spec)
	case "cancel":
		return store.cancel(ctx, directory, request, id)
	}
	receiver, err := store.get(ctx, directory, request)
	if err != nil {
		return nil, err
	}
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	if field(receiver.meta["spec"], "peer") != id {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer")
	}
	if err := checkProtectedPath(text(receiver.meta, "path")); err != nil {
		return nil, err
	}
	switch action {
	case "status":
		return clone(receiver.meta), nil
	case "commit":
		return receiver.commit()
	case "put":
		data, err := base64.StdEncoding.Strict().DecodeString(text(body, "data"))
		if err != nil {
			return nil, err
		}
		if len(data) > deviceTransferTunnelCap {
			return nil, errors.New("DEVICE_TUNNEL_LIMIT: upload range exceeds 512 KiB")
		}
		offset, ok := uintValue(body["offset"])
		if !ok {
			return nil, errors.New("INVALID_ARGUMENT")
		}
		if hash(data) != text(body, "sha256") {
			return nil, errors.New("SHA256_MISMATCH: range digest differs")
		}
		if err := receiver.receive(ctx, bytes.NewReader(data), offset, uint64(len(data)), func() string { return text(body, "sha256") }); err != nil {
			return nil, err
		}
		return clone(receiver.meta), nil
	default:
		return nil, errors.New("INVALID_ARGUMENT: use transfer begin, status, put, get, stat, commit or cancel")
	}
}

func deviceTransferSource(body object) (string, object, error) {
	path, err := resolveDeviceTransferPath(text(body, "path"))
	if err != nil {
		return "", nil, err
	}
	stamp, err := deviceTransferFingerprint(path)
	return path, stamp, err
}

func deviceTransferRange(body object) (uint64, uint64, error) {
	offset, offsetOK := uintValue(body["offset"])
	length, lengthOK := uintValue(body["length"])
	if !offsetOK || !lengthOK {
		return 0, 0, errors.New("INVALID_ARGUMENT")
	}
	return offset, length, nil
}

func (m *deviceManager) transferHTTP(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	if err := m.authorizeTransfer(ctx, id); err != nil {
		transferWireReply(w, nil, err)
		return
	}
	if r.Method != http.MethodPost {
		transferWireReply(w, nil, errors.New("DEVICE_PEER_FORBIDDEN: use POST transfer routes"))
		return
	}
	switch r.URL.EscapedPath() {
	case deviceReadPath + "transfer/control", deviceReadPath + "transfer/download":
		data, err := io.ReadAll(io.LimitReader(r.Body, 16385))
		var body object
		if err != nil || len(data) > 16384 || decodeObject(data, &body) != nil {
			transferWireReply(w, nil, errors.New("INVALID_ARGUMENT: peer body must be JSON"))
			return
		}
		if uintOr(body["version"], 0) != deviceProtocolVersion {
			transferWireReply(w, nil, errors.New("DEVICE_PROTOCOL_MISMATCH: use peer protocol 3"))
			return
		}
		if strings.HasSuffix(r.URL.EscapedPath(), "/control") {
			value, err := m.transferControlAuthorized(ctx, id, body)
			transferWireReply(w, value, err)
			return
		}
		if err := serveTransferDownload(w, body); err != nil {
			transferWireReply(w, nil, err)
		}
	case deviceReadPath + "transfer/upload":
		value, err := m.receiveTransferUpload(ctx, id, r)
		transferWireReply(w, value, err)
	default:
		transferWireReply(w, nil, errors.New("DEVICE_PEER_FORBIDDEN: unknown transfer route"))
	}
}

func serveTransferDownload(w http.ResponseWriter, body object) error {
	path, stamp, err := deviceTransferSource(body)
	if err != nil {
		return err
	}
	if wire(stamp) != wire(body["fingerprint"]) {
		return errors.New("SOURCE_CHANGED: restart with a new requestId")
	}
	offset, length, err := deviceTransferRange(body)
	if err != nil || length > deviceTransferLANRange {
		return errors.New("INVALID_ARGUMENT")
	}
	trailers := make(http.Header)
	stream, err := streamDeviceTransfer(path, offset, length, trailers)
	if err != nil {
		return err
	}
	defer stream.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Trailer", "X-Arc-Sha256")
	w.WriteHeader(http.StatusOK)
	_, err = io.CopyBuffer(w, stream, make([]byte, deviceTransferBlock))
	if err == nil {
		w.Header().Set("X-Arc-Sha256", trailers.Get("X-Arc-Sha256"))
	}
	return nil
}

func (m *deviceManager) receiveTransferUpload(ctx context.Context, id string, r *http.Request) (any, error) {
	request, at, total := r.Header.Get("X-Arc-Request"), r.Header.Get("X-Arc-Offset"), r.Header.Get("X-Arc-Length")
	if request == "" || at == "" || total == "" {
		return nil, errors.New("INVALID_ARGUMENT: missing transfer header")
	}
	offset, err := strconv.ParseUint(at, 10, 64)
	if err != nil {
		return nil, err
	}
	length, err := strconv.ParseUint(total, 10, 64)
	if err != nil {
		return nil, err
	}
	if length > deviceTransferLANRange {
		return nil, errors.New("INVALID_ARGUMENT: LAN ranges must fit 16 MiB")
	}
	receiver, err := m.transfers.get(ctx, filepath.Join(m.directory, "transfer-receivers"), request)
	if err != nil {
		return nil, err
	}
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	if field(receiver.meta["spec"], "peer") != id {
		return nil, errors.New("DEVICE_PEER_FORBIDDEN: transfer belongs to another peer")
	}
	if receiver.offset() != offset {
		return nil, errors.New("OFFSET_MISMATCH: read verified receiver offset")
	}
	if err := checkProtectedPath(text(receiver.meta, "path")); err != nil {
		return nil, err
	}
	if err := receiver.receive(ctx, r.Body, offset, length, func() string { return r.Trailer.Get("X-Arc-Sha256") }); err != nil {
		return nil, err
	}
	return clone(receiver.meta), nil
}

func init() {
	serveDeviceTransfer = (*deviceManager).transferHTTP
	deviceTunnelTransfer = func(ctx context.Context, m *deviceManager, id string, body object) (any, error) {
		return m.transferControl(ctx, id, body)
	}
}
