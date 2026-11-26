package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const outputQuota = 64 * 1024 * 1024
const outputTTL = time.Hour

var outputWriter sync.Mutex

func schemaClosure(schema, definitions object) object {
	var pending []string
	var refs func(any)
	refs = func(value any) {
		if object, ok := value.(map[string]any); ok {
			if name, ok := strings.CutPrefix(text(object, "$ref"), "#/definitions/"); ok {
				pending = append(pending, strings.ReplaceAll(strings.ReplaceAll(name, "~1", "/"), "~0", "~"))
			}
			for _, child := range object {
				refs(child)
			}
		}
		for _, child := range arr(value) {
			refs(child)
		}
	}
	refs(schema)
	selected := object{}
	for len(pending) > 0 {
		name := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if _, seen := selected[name]; seen {
			continue
		}
		if value, exists := definitions[name]; exists {
			selected[name] = value
			refs(value)
		}
	}
	if len(selected) != 0 {
		schema = clone(schema)
		schema["definitions"] = selected
	}
	return schema
}

func reserveOutput(data string, extension string) (string, error) {
	outputWriter.Lock()
	defer outputWriter.Unlock()
	dir := filepath.Join(root(), "outputs")
	if err := platform.PrivateDir(dir); err != nil {
		return "", err
	}
	if err := makeOutputRoom(dir, int64(len(data))); err != nil {
		return "", err
	}
	output := id()
	return output, saveBytes(filepath.Join(dir, output+extension), []byte(data))
}

func makeOutputRoom(dir string, incoming int64) error {
	if incoming > outputQuota {
		return errors.New("OUTPUT_STORAGE_LIMIT")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type snapshot struct {
		name string
		info os.FileInfo
	}
	var snapshots []snapshot
	var total int64
	for _, entry := range entries {
		extension := filepath.Ext(entry.Name())
		if !entry.Type().IsRegular() || extension != ".json" && extension != ".txt" && extension != ".digest" {
			continue
		}
		if _, err := uuid.Parse(strings.TrimSuffix(entry.Name(), extension)); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		snapshots = append(snapshots, snapshot{entry.Name(), info})
	}
	slices.SortStableFunc(snapshots, func(a, b snapshot) int { return a.info.ModTime().Compare(b.info.ModTime()) })
	for _, snapshot := range snapshots {
		if time.Since(snapshot.info.ModTime()) < outputTTL && incoming+total <= outputQuota {
			break
		}
		if os.Remove(filepath.Join(dir, snapshot.name)) == nil {
			total -= snapshot.info.Size()
		}
	}
	if incoming+total > outputQuota {
		return errors.New("OUTPUT_STORAGE_LIMIT")
	}
	return nil
}

func utf16Length(text string) int {
	length := 0
	for _, r := range text {
		length += utf16.RuneLen(r)
	}
	return length
}

func pageOutput(value any, limit int) (any, error) {
	data := wire(value)
	if len(data) <= limit {
		return value, nil
	}
	output, err := reserveOutput(data, ".json")
	if err != nil {
		return nil, err
	}
	end := min(limit, 2048)
	for !utf8.RuneStart(data[end]) {
		end--
	}
	preview := data[:end]
	var summaryKeys any
	if row := obj(value); row != nil {
		summaryKeys = keys(row)
	}
	page := object{"text": preview, "offset": 0, "nextOffset": utf16Length(preview), "outputId": output, "bytes": len(data),
		"characters": utf16Length(data), "sha256": hash([]byte(data)), "nextAction": "control_output", "format": "JSON; offsets count UTF-16 code units",
		"retention": "temporary-cache", "expiresInSeconds": int(outputTTL.Seconds()), "summary": object{"keys": summaryKeys}}
	for _, field := range []string{"requestId", "state", "operation", "threadId", "taskId", "turnId", "error", "next", "runtimeStatus", "method", "direction"} {
		if value, exists := obj(value)[field]; exists {
			page[field] = value
		}
	}
	return page, nil
}

func textContinuation(value string) (object, error) {
	output, err := reserveOutput(value, ".txt")
	if err != nil {
		return nil, err
	}
	return object{"via": "query", "op": "control_output", "args": object{"outputId": output, "offset": 0},
		"format": "plain-text", "characters": utf16Length(value), "bytes": len(value), "sha256": hash([]byte(value)),
		"retention": "temporary-cache", "expiresInSeconds": int(outputTTL.Seconds())}, nil
}

func readOutput(ctx context.Context, args object) (object, error) {
	output := text(args, "outputId")
	if _, err := uuid.Parse(output); err != nil {
		return nil, errors.New("INVALID_OUTPUT_ID")
	}
	base := filepath.Join(root(), "outputs", output)
	offset := uintOr(args["offset"], 0)
	length := min(uintOr(args["length"], 65536), 65536)
	snapshot, expired, err := readDigest(output)
	if err != nil {
		return nil, err
	}
	if snapshot != nil {
		if snapshot["scope"] != digestScope(currentOrigin(ctx)) {
			return nil, errors.New("DIGEST_SCOPE_CHANGED: read with the original authorized source")
		}
		if expired {
			return nil, errors.New(wire(object{"code": "OUTPUT_EXPIRED", "next": digestRestart(text(snapshot, "op"), obj(snapshot["args"]))}))
		}
		text, chars, err := readOutputSlice(strings.NewReader(wire(snapshot["value"])), offset, length)
		if err != nil {
			return nil, err
		}
		var next any
		if offset < chars && length < chars-offset {
			next = offset + length
		}
		return object{"outputId": output, "offset": offset, "text": text, "characters": chars, "nextOffset": next}, nil
	}
	for _, suffix := range []string{".txt", ".json"} {
		file, err := os.Open(base + suffix)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if time.Since(info.ModTime()) >= outputTTL {
			return nil, errors.New("OUTPUT_EXPIRED")
		}
		reader := io.LimitReader(file, info.Size())
		if suffix == ".txt" {
			return readPlainOutput(reader, output, offset, length)
		}
		text, chars, err := readOutputSlice(reader, offset, length)
		if err != nil {
			return nil, err
		}
		var next any
		if offset < chars && length < chars-offset {
			next = offset + length
		}
		return object{"outputId": output, "offset": offset, "text": text, "characters": chars, "nextOffset": next}, nil
	}
	text, chars, err := readEventArchive(output, offset, length)
	if err != nil {
		return nil, err
	}
	var next any
	if offset < chars && length < chars-offset {
		next = offset + length
	}
	return object{"outputId": output, "offset": offset, "text": text, "characters": chars, "nextOffset": next}, nil
}

func readOutputSlice(input io.Reader, offset, length uint64) (string, uint64, error) {
	return readOutputSliceKnown(input, offset, length, nil)
}

func readOutputSliceKnown(input io.Reader, offset, length uint64, known *uint64) (string, uint64, error) {
	received := bufio.NewReaderSize(input, 64*1024)
	selected := make([]uint16, 0, length)
	var characters uint64
	push := func(unit uint16) {
		if characters >= offset && uint64(len(selected)) < length {
			selected = append(selected, unit)
		}
		characters++
	}
	for {
		if known != nil && characters >= offset && uint64(len(selected)) >= length {
			return string(utf16.Decode(selected)), *known, nil
		}
		ch, n, err := received.ReadRune()
		if err == io.EOF {
			if known != nil {
				characters = *known
			}
			return string(utf16.Decode(selected)), characters, nil
		}
		if err != nil {
			return "", 0, err
		}
		if ch == utf8.RuneError && n == 1 {
			return "", 0, errors.New("invalid UTF-8")
		}
		if utf16.RuneLen(ch) == 2 {
			hi, lo := utf16.EncodeRune(ch)
			push(uint16(hi))
			push(uint16(lo))
		} else {
			push(uint16(ch))
		}
	}
}

func readPlainOutput(input io.Reader, output string, offset, length uint64) (object, error) {
	reader := bufio.NewReader(input)
	var excerpt strings.Builder
	var characters uint64
	end := offset
	for {
		ch, n, err := reader.ReadRune()
		if err == io.EOF {
			break
		}
		if err != nil || ch == utf8.RuneError && n == 1 {
			return nil, errors.New("stream did not contain valid UTF-8")
		}
		next := characters + uint64(utf16.RuneLen(ch))
		if characters < offset && offset < next {
			return nil, errors.New(wire(object{"code": "INVALID_OUTPUT_OFFSET", "message": "Use the returned nextOffset; plain-text pages cannot split a Unicode character",
				"next": object{"via": "query", "op": "control_output", "args": object{"outputId": output, "offset": characters, "length": length}}}))
		}
		if characters >= offset && (next-offset <= length || excerpt.Len() == 0) {
			excerpt.WriteRune(ch)
			end = next
		}
		characters = next
	}
	var next any
	if end < characters {
		next = end
	}
	return object{"outputId": output, "offset": offset, "text": excerpt.String(), "format": "plain-text", "characters": characters, "nextOffset": next}, nil
}

func transportError(err error) object {
	var failure object
	if strings.HasPrefix(err.Error(), "{") && decodeObject([]byte(err.Error()), &failure) == nil && failure["code"] != nil {
		return failure
	}
	return object{"code": managementErrorCode(err.Error()), "message": fmt.Sprint(err)}
}

func init() {

	registerOperation("control_output", func(ctx context.Context, req operationRequest) (any, error) {
		return readOutput(ctx, req.args)
	}, nil)
}
