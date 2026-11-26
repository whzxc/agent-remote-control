package core

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const maxBinaryChunk = 8 * 1024 * 1024
const maxBinaryFile = 512 * 1024 * 1024

var expectedBinarySHA256 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func transferBinaryFile(ctx context.Context, method string, args object) (object, error) {
	requested := text(args, "path")
	if !filepath.IsAbs(requested) {
		return nil, errors.New("INVALID_PATH: fs requires an absolute host path; for UTF-8 text use write")
	}
	if err := checkProtectedPath(requested); err != nil {
		return nil, err
	}
	var path string
	if _, err := os.Stat(requested); err == nil {
		path, err = filepath.EvalSymlinks(requested)
		if err != nil {
			return nil, err
		}
	} else {
		parent, err := filepath.EvalSymlinks(filepath.Dir(requested))
		if err != nil {
			return nil, err
		}
		path = filepath.Join(parent, filepath.Base(requested))
	}
	if err := checkProtectedPath(path); err != nil {
		return nil, err
	}
	expected := text(args, "expectedSha256")
	if _, supplied := args["expectedSha256"]; supplied && !expectedBinarySHA256.MatchString(expected) {
		return nil, errors.New("INVALID_SHA256: expectedSha256 must contain 64 hexadecimal characters")
	}
	unlock := lockReceipt("file:" + path)
	defer unlock()
	appendBytes, appendOK := args["append"].(bool)
	if _, supplied := args["append"]; supplied && !appendOK {
		return nil, errors.New("INVALID_ARGUMENT: append must be a boolean")
	}
	if _, supplied := args["offset"]; supplied && !appendBytes {
		return nil, errors.New("INVALID_ARGUMENT: offset requires append:true")
	}
	limit := uint64(64 * 1024 * 1024)
	if value, supplied := args["maxBytes"]; supplied {
		limit = uintOr(value, 0)
		if limit == 0 || limit > maxBinaryFile {
			return nil, errors.New("INVALID_ARGUMENT: maxBytes must be an integer from 1 to 536870912")
		}
	}
	if appendBytes && method != "fs/writeFile" {
		return nil, errors.New("INVALID_ARGUMENT: append is only supported by fs writeFile")
	}
	previous, _ := os.Stat(path)
	var existing uint64
	if appendBytes && previous != nil {
		existing = uint64(previous.Size())
	}
	if appendBytes {
		offset, confirmed := uintValue(args["offset"])
		if !confirmed {
			return nil, errors.New("OFFSET_REQUIRED: append requires the exact current byte length; read the previous receipt")
		}
		if offset != existing {
			return nil, fmt.Errorf("OFFSET_MISMATCH: expected %d bytes, found %d; read the original receipt before retrying", offset, existing)
		}
	}
	temp := filepath.Join(filepath.Dir(path), ".arc-"+id()+".tmp")
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp)
	defer file.Close()
	digest := sha256.New()
	writers := io.MultiWriter(file, digest)
	var written uint64
	const tooLarge = "FILE_TOO_LARGE: maximum resulting file size is 512 MiB"
	if appendBytes && previous != nil {
		old, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		size, err := io.Copy(writers, io.LimitReader(old, maxBinaryFile+1))
		err = errors.Join(err, old.Close())
		if err != nil {
			return nil, err
		}
		written = uint64(size)
		if written > maxBinaryFile {
			return nil, errors.New(tooLarge)
		}
	}
	if method == "fs/fetchFile" {
		size, err := fetchBinaryFile(ctx, text(args, "url"), writers, limit)
		if err != nil {
			return nil, err
		}
		written += size
	} else {
		chunk, err := decodeFileChunk(args)
		if err != nil {
			return nil, err
		}
		if written+uint64(len(chunk)) > maxBinaryFile {
			return nil, errors.New(tooLarge)
		}
		size, err := writers.Write(chunk)
		if err != nil {
			return nil, err
		}
		written += uint64(size)
	}
	sha := hex.EncodeToString(digest.Sum(nil))
	if expected != "" && !strings.EqualFold(sha, expected) {
		return nil, fmt.Errorf("SHA256_MISMATCH: expected %s, computed %s; destination unchanged", expected, sha)
	}
	if previous != nil {
		if err := file.Chmod(previous.Mode()); err != nil {
			return nil, err
		}
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return nil, err
	}
	current, _ := os.Stat(path)
	if (previous == nil) != (current == nil) || previous != nil && current != nil &&
		(previous.Size() != current.Size() || !previous.ModTime().Equal(current.ModTime())) {
		return nil, errors.New("FILE_CHANGED_DURING_TRANSFER: destination unchanged by ARC; inspect it before retrying")
	}
	if err := platform.ReplaceFile(temp, path); err != nil {
		return nil, err
	}
	return object{"path": path, "bytesWritten": written - existing, "sizeBytes": written, "sha256": sha, "append": appendBytes}, nil
}

func decodeFileChunk(args object) ([]byte, error) {
	encoded, ok := args["dataBase64"].(string)
	if !ok {
		return nil, errors.New("DATA_REQUIRED: binary fs writeFile requires dataBase64; for UTF-8 text use write")
	}
	const tooLarge = "CHUNK_TOO_LARGE: send at most 8 MiB decoded bytes per write"
	if len(encoded) > base64.StdEncoding.EncodedLen(maxBinaryChunk) {
		return nil, errors.New(tooLarge)
	}
	if index := strings.IndexAny(encoded, "\r\n"); index >= 0 {
		return nil, fmt.Errorf("INVALID_BASE64: Invalid symbol %d, offset %d.", encoded[index], index)
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		if corrupt, ok := err.(base64.CorruptInputError); ok && int(corrupt) < len(encoded) {
			ch := encoded[corrupt]
			if (ch < 'A' || ch > 'Z') && (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '+' && ch != '/' && ch != '=' {
				return nil, fmt.Errorf("INVALID_BASE64: Invalid symbol %d, offset %d.", ch, corrupt)
			}
		}
		return nil, fmt.Errorf("INVALID_BASE64: %w", err)
	}
	if len(data) > maxBinaryChunk {
		return nil, errors.New(tooLarge)
	}
	return data, nil
}

func fetchBinaryFile(ctx context.Context, address string, out io.Writer, limit uint64) (uint64, error) {
	target, err := url.Parse(address)
	if err != nil || target.Scheme != "https" || target.Host == "" {
		return 0, errors.New("INVALID_URL: use an HTTPS URL")
	}
	proxy, err := savedNetworkProxy(ctx)
	if err != nil {
		return 0, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy.proxyFor
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 120 * time.Second, CheckRedirect: func(next *http.Request, previous []*http.Request) error {
		if next.URL.Scheme != "https" {
			return errors.New("builder error")
		}
		if len(previous) >= 10 {
			return errors.New("error following redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return 0, err
	}
	reply, err := client.Do(req)
	if err != nil {
		if failure, ok := errors.AsType[*url.Error](err); ok {
			err = failure.Err
		}
		return 0, err
	}
	defer reply.Body.Close()
	if reply.StatusCode >= 400 {
		kind := "client"
		if reply.StatusCode >= 500 {
			kind = "server"
		}
		return 0, fmt.Errorf("HTTP status %s error (%s)", kind, reply.Status)
	}
	size, err := io.Copy(out, io.LimitReader(reply.Body, int64(limit)+1))
	if err != nil {
		return 0, err
	}
	if uint64(size) > limit {
		return 0, errors.New("DOWNLOAD_TOO_LARGE: increase maxBytes (maximum 512 MiB)")
	}
	return uint64(size), nil
}
