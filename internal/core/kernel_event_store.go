package core

import (
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const eventSegmentBytes = 8 * 1024 * 1024

func eventDirectory(session string) (string, error) {
	if _, err := uuid.Parse(session); err != nil {
		return "", errors.New("INVALID_OUTPUT_ID")
	}
	directory := filepath.Join(root(), "outputs", session)
	if info, err := os.Lstat(directory); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("INVALID_OUTPUT_DIRECTORY")
	}
	return directory, platform.PrivateDir(directory)
}

func eventLock(dir string, shared bool) (*os.File, error) {
	file, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := platform.Lock(file, shared); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func eventSegments(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	paths := object{}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		ext := filepath.Ext(entry.Name())
		stem := strings.TrimSuffix(entry.Name(), ext)
		if len(stem) != 20 || strings.IndexFunc(stem, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			continue
		}
		switch ext {
		case ".jsonl":
			paths[stem] = filepath.Join(dir, entry.Name())
		case ".gz":
			if _, exists := paths[stem]; exists {
				continue
			}
			if info, err := os.Stat(filepath.Join(dir, stem+".json")); err == nil && info.Mode().IsRegular() {
				paths[stem] = filepath.Join(dir, entry.Name())
			}
		}
	}
	segments := make([]string, 0, len(paths))
	for _, stem := range keys(paths) {
		segments = append(segments, str(paths[stem]))
	}
	return segments, nil
}

func withArchiveReader(path string, visit func(io.Reader) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if filepath.Ext(path) == ".gz" || filepath.Ext(path) == ".tmp" {
		archive, err := gzip.NewReader(file)
		if err != nil {
			return err
		}
		defer archive.Close()
		archive.Multistream(false)
		return visit(archive)
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	return visit(io.LimitReader(file, info.Size()))
}

func compressEventSegment(path string) error {
	stem := strings.TrimSuffix(path, ".jsonl")
	temp := stem + ".tmp"
	defer os.Remove(temp)
	source, err := os.Open(path)
	if err != nil {
		return err
	}
	defer source.Close()
	before, err := source.Stat()
	if err != nil {
		return err
	}
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	encoder, err := gzip.NewWriterLevel(file, gzip.BestSpeed)
	if err != nil {
		file.Close()
		return err
	}
	digest := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(encoder, digest), source)
	closeErr := encoder.Close()
	if err := errors.Join(copyErr, closeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	expected := hex.EncodeToString(digest.Sum(nil))
	err = withArchiveReader(temp, func(reader io.Reader) error {
		verified := sha256.New()
		if _, err := io.Copy(verified, reader); err != nil {
			return err
		}
		if hex.EncodeToString(verified.Sum(nil)) != expected {
			return errors.New("EVENT_ARCHIVE_VERIFY_FAILED")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, characters, err := readOutputSlice(source, 0, 0)
	if err != nil {
		return err
	}
	after, err := os.Stat(path)
	if err != nil {
		return err
	}
	if size != before.Size() || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return errors.New("EVENT_ARCHIVE_SOURCE_CHANGED")
	}
	if err := source.Close(); err != nil {
		return err
	}
	if err := platform.ReplaceFile(temp, stem+".gz"); err != nil {
		return err
	}
	if err := save(stem+".json", object{"bytes": size, "characters": characters, "sha256": expected}); err != nil {
		return err
	}
	return os.Remove(path)
}

func rotateEvents(session, dir string, force bool) error {
	segments, err := eventSegments(dir)
	if err != nil {
		return err
	}
	for _, path := range segments {
		if strings.HasSuffix(path, ".jsonl") {
			if err := compressEventSegment(path); err != nil {
				return err
			}
		}
	}
	tail := filepath.Join(root(), "outputs", session+".jsonl")
	if info, err := os.Stat(tail); err != nil || info.Size() == 0 || !force && info.Size() < eventSegmentBytes {
		return nil
	}
	var next uint64
	if len(segments) != 0 {
		last := filepath.Base(segments[len(segments)-1])[:20]
		value, err := strconv.ParseUint(last, 10, 64)
		if err == nil {
			if value == math.MaxUint64 {
				return errors.New("INVALID_EVENT_INDEX")
			}
			next = value + 1
		}
	}
	segment := filepath.Join(dir, fmt.Sprintf("%020d.jsonl", next))
	if err := os.Rename(tail, segment); err != nil {
		return err
	}
	return compressEventSegment(segment)
}

func appendEventArchive(session, value string) error {
	directory, err := eventDirectory(session)
	if err != nil {
		return err
	}
	lock, err := eventLock(directory, false)
	if err != nil {
		return err
	}
	defer lock.Close()
	path := filepath.Join(root(), "outputs", session+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = io.WriteString(file, value)
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	return rotateEvents(session, directory, false)
}

func eventReadPaths(dir, session string) ([]string, error) {
	segments, err := eventSegments(dir)
	if err != nil {
		return nil, err
	}
	tail := filepath.Join(root(), "outputs", session+".jsonl")
	if info, err := os.Stat(tail); err == nil && info.Mode().IsRegular() {
		segments = append(segments, tail)
	}
	return segments, nil
}

func readEventArchive(session string, offset, length uint64) (string, uint64, error) {
	outputs := filepath.Join(root(), "outputs")
	dirInfo, dirErr := os.Stat(filepath.Join(outputs, session))
	tailInfo, tailErr := os.Stat(filepath.Join(outputs, session+".jsonl"))
	if (dirErr != nil || !dirInfo.IsDir()) && (tailErr != nil || !tailInfo.Mode().IsRegular()) {
		return "", 0, errors.New("OUTPUT_NOT_FOUND")
	}
	dir, err := eventDirectory(session)
	if err != nil {
		return "", 0, err
	}
	lock, err := eventLock(dir, true)
	if err != nil {
		return "", 0, err
	}
	defer lock.Close()
	paths, err := eventReadPaths(dir, session)
	if err != nil {
		return "", 0, err
	}
	if len(paths) == 0 {
		return "", 0, errors.New("OUTPUT_NOT_FOUND")
	}
	var selected strings.Builder
	var total uint64
	end := offset + min(length, math.MaxUint64-offset)
	for _, path := range paths {
		var known *uint64
		if filepath.Ext(path) == ".gz" {
			index, err := load(strings.TrimSuffix(path, ".gz") + ".json")
			if err != nil {
				return "", 0, err
			}
			count, ok := uintValue(field(index, "characters"))
			if !ok {
				return "", 0, errors.New("INVALID_EVENT_INDEX")
			}
			if total+min(count, math.MaxUint64-total) <= offset || total >= end {
				total += min(count, math.MaxUint64-total)
				continue
			}
			known = &count
		}
		start := offset - min(offset, total)
		wanted := end - min(end, max(total, offset))
		err := withArchiveReader(path, func(reader io.Reader) error {
			part, count, err := readOutputSliceKnown(reader, start, wanted, known)
			if err != nil {
				return err
			}
			selected.WriteString(part)
			total += min(count, math.MaxUint64-total)
			return nil
		})
		if err != nil {
			return "", 0, err
		}
	}
	return selected.String(), total, nil
}

func visitEventArchive(session string, consume func(any) error) error {
	dir, err := eventDirectory(session)
	if err != nil {
		return err
	}
	lock, err := eventLock(dir, true)
	if err != nil {
		return err
	}
	defer lock.Close()
	paths, err := eventReadPaths(dir, session)
	if err != nil {
		return err
	}
	for _, path := range paths {
		err := withArchiveReader(path, func(input io.Reader) error {
			reader := bufio.NewReader(input)
			for {
				line, readErr := reader.ReadBytes('\n')
				if readErr != nil && readErr != io.EOF {
					return readErr
				}
				if len(line) != 0 {
					var row any
					if err := unmarshalJSON(line, &row); err != nil {
						return err
					}
					if err := consume(row); err != nil {
						return err
					}
				}
				if readErr == io.EOF {
					return nil
				}
			}
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func compactEventArchives() (object, error) {
	outputs := filepath.Join(root(), "outputs")
	if err := platform.PrivateDir(outputs); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(outputs)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	seen := make(map[string]bool)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() {
			var ok bool
			name, ok = strings.CutSuffix(name, ".jsonl")
			if !ok {
				continue
			}
		}
		if _, err := uuid.Parse(name); err == nil && !seen[name] {
			seen[name] = true
			ids = append(ids, name)
		}
	}
	slices.Sort(ids)
	for _, id := range ids {
		dir, err := eventDirectory(id)
		if err != nil {
			return nil, err
		}
		lock, err := eventLock(dir, false)
		if err != nil {
			return nil, err
		}
		err = rotateEvents(id, dir, true)
		lock.Close()
		if err != nil {
			return nil, err
		}
	}
	return object{"compactedOutputs": len(ids), "lossless": true}, nil
}
