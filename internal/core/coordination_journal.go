package core

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const (
	coordinationEventBytes    = 2048
	coordinationSegmentBytes  = 256 * 1024
	coordinationStoreBytes    = 16 * 1024 * 1024
	coordinationStoreEvents   = 20000
	coordinationRetentionMS   = 7 * 24 * 60 * 60 * 1000
	coordinationPageBytes     = 128 * 1024
	coordinationReservedBytes = 4 * coordinationSegmentBytes
	coordinationCoverageBytes = 16 * 1024
)

type coordinationManifest struct {
	Epoch      string   `json:"epoch"`
	CursorKey  string   `json:"cursorKey"`
	Next       uint64   `json:"next"`
	Floor      uint64   `json:"floor"`
	Segments   []uint64 `json:"segments"`
	Gaps       uint64   `json:"gaps"`
	Reconciled uint64   `json:"reconciled"`
	Dropped    uint64   `json:"dropped"`
}
type coordinationRecord struct {
	Sequence uint64                 `json:"sequence"`
	Time     int64                  `json:"time"`
	Input    coordinationEventInput `json:"input"`
}
type coordinationIndexed struct {
	record            coordinationRecord
	segment           uint64
	eventBytes, bytes int
}
type coordinationCursor struct {
	Epoch    string  `json:"epoch"`
	Scope    string  `json:"scope"`
	Resource *string `json:"resource"`
	After    uint64  `json:"after"`
	High     uint64  `json:"high"`
}
type coordinationQuery struct {
	Since    *string  `json:"since"`
	Resource *string  `json:"resource"`
	Kinds    []string `json:"kinds"`
	Limit    *int     `json:"limit"`
}
type coordinationReader struct {
	principal coordinationPrincipal
	revision  string
}

func (reader coordinationReader) identity() any {
	if reader.principal.Type == "source" {
		return object{"sourceId": reader.principal.SourceID}
	}
	return reader.principal
}
func (reader coordinationReader) scope(query coordinationQuery) string {
	return hash([]byte(wire([]any{reader.identity(), reader.revision, query.Resource, query.Kinds})))
}

type coordinationBucket struct {
	tokens float64
	at     time.Time
}
type coordinationJournal struct {
	dir              string
	manifest         coordinationManifest
	records          []coordinationIndexed
	transitions      map[string]coordinationIndexed
	resources        map[string]int
	bytes, tailBytes int
	readers          map[string]coordinationBucket
	emissionSecond   int64
	emissions        int
}

var errCoordinationJournalIO = errors.New("COORDINATION_STORAGE: journal I/O failed; restore local disk capacity and retry the same transition or cursor")
var errCoordinationJournalCorrupt = errors.New("COORDINATION_CORRUPT: preserve coordination/events for local recovery; do not reset it silently")

func decodeCoordinationRecord(data []byte, target any) error {
	if !json.Valid(data) {
		return errors.New("Invalid coordination JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func coordinationAtomicBytes(path string, data []byte) error {
	before, _ := readStamp(filepath.Dir(path))
	if err := indexAtomic(path, data); err != nil {
		_ = os.Remove(strings.TrimSuffix(path, filepath.Ext(path)) + ".tmp")
		return errCoordinationJournalIO
	}
	markCachedFileChanged(path, before)
	return nil
}

func readCoordinationSegment(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, coordinationSegmentBytes+1))
}

func openCoordinationJournal(dir string, ms int64) (*coordinationJournal, error) {
	if err := platform.PrivateDir(dir); err != nil {
		return nil, errCoordinationJournalIO
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, errCoordinationJournalIO
	}
	var manifest coordinationManifest
	path := filepath.Join(dir, "manifest.json")
	data, err := readCoordinationSegment(path)
	switch {
	case err == nil:
		if len(data) > coordinationSegmentBytes || decodeCoordinationRecord(data, &manifest) != nil {
			return nil, errCoordinationJournalCorrupt
		}
	case errors.Is(err, os.ErrNotExist) && len(entries) == 0:
		manifest = coordinationManifest{Epoch: id(), CursorKey: id(), Next: 1, Segments: []uint64{}}
	case errors.Is(err, os.ErrNotExist):
		return nil, errCoordinationJournalCorrupt
	default:
		return nil, errCoordinationJournalIO
	}
	if manifest.Next == 0 || manifest.Floor >= manifest.Next || manifest.Segments == nil || len(manifest.Segments) > 128 {
		return nil, errCoordinationJournalCorrupt
	}
	var previous uint64
	for _, segment := range manifest.Segments {
		if segment <= previous || segment >= manifest.Next {
			return nil, errCoordinationJournalCorrupt
		}
		previous = segment
	}
	if len(entries) > 132 {
		return nil, errors.New("COORDINATION_CAPACITY: too many journal files; local recovery required")
	}
	var diskBytes int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return nil, errCoordinationJournalIO
		}
		if !info.Mode().IsRegular() || info.Size() > coordinationSegmentBytes {
			return nil, errCoordinationJournalCorrupt
		}
		diskBytes += info.Size()
		if diskBytes > coordinationStoreBytes {
			return nil, errors.New("COORDINATION_CAPACITY: journal exceeds its disk budget")
		}
		name := entry.Name()
		if raw, ok := strings.CutSuffix(name, ".jsonl"); ok {
			if seq, err := strconv.ParseUint(raw, 10, 64); err == nil {
				if !slices.Contains(manifest.Segments, seq) {
					if seq > manifest.Floor {
						return nil, errCoordinationJournalCorrupt
					}
					if err := os.Remove(filepath.Join(dir, name)); err != nil {
						return nil, errCoordinationJournalIO
					}
				}
				continue
			}
		}
		if !slices.Contains([]string{"manifest.json", "manifest.tmp", "tail.quarantine", "tail.tmp"}, name) {
			return nil, errCoordinationJournalCorrupt
		}
	}
	journal := &coordinationJournal{dir: dir, manifest: manifest, transitions: map[string]coordinationIndexed{}, resources: map[string]int{}, readers: map[string]coordinationBucket{}}
	expected := manifest.Floor + 1
	for i, segment := range manifest.Segments {
		last := i == len(manifest.Segments)-1
		if err := journal.loadSegment(segment, last, &expected); err != nil {
			return nil, err
		}
	}
	if expected < manifest.Next && manifest.Next-1 > manifest.Reconciled {
		journal.manifest.Gaps = saturatingIncrement(journal.manifest.Gaps)
	}
	journal.manifest.Reconciled = manifest.Next - 1
	if err := journal.prune(ms, 0); err != nil {
		return nil, err
	}
	return journal, journal.persist()
}

func saturatingIncrement(value uint64) uint64 {
	if value < math.MaxUint64 {
		return value + 1
	}
	return value
}

func (j *coordinationJournal) loadSegment(segment uint64, last bool, expected *uint64) error {
	path := j.segmentPath(segment)
	data, err := readCoordinationSegment(path)
	if errors.Is(err, os.ErrNotExist) && last {
		j.tailBytes = 0
		return nil
	}
	if err != nil || len(data) > coordinationSegmentBytes {
		return errCoordinationJournalCorrupt
	}
	valid := 0
	for line := range bytes.SplitAfterSeq(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var record coordinationRecord
		if line[len(line)-1] != '\n' || len(line) > coordinationEventBytes || decodeCoordinationRecord(line, &record) != nil {
			if !last || valid+len(line) != len(data) {
				return errCoordinationJournalCorrupt
			}
			if err := j.quarantine(path, data[valid:], valid); err != nil {
				return err
			}
			break
		}
		if record.Sequence < *expected || record.Sequence >= j.manifest.Next {
			return errCoordinationJournalCorrupt
		}
		if record.Sequence != *expected && record.Sequence-1 > j.manifest.Reconciled {
			j.manifest.Gaps = saturatingIncrement(j.manifest.Gaps)
		}
		*expected = record.Sequence + 1
		event, err := record.Input.project(j.manifest.Epoch, record.Sequence, record.Time)
		if err != nil || len(wire(event)) > coordinationEventBytes {
			return errCoordinationJournalCorrupt
		}
		if err := j.index(coordinationIndexed{record: record, segment: segment, eventBytes: len(wire(event)), bytes: len(line)}); err != nil {
			return err
		}
		if len(j.records) > coordinationStoreEvents || j.bytes > coordinationStoreBytes-coordinationReservedBytes {
			return errCoordinationJournalCorrupt
		}
		valid += len(line)
	}
	j.tailBytes = valid
	return nil
}

func (j *coordinationJournal) quarantine(path string, data []byte, valid int) error {
	if err := coordinationAtomicBytes(filepath.Join(j.dir, "tail.quarantine"), data); err != nil {
		return err
	}
	j.manifest.Gaps = saturatingIncrement(j.manifest.Gaps)
	if err := j.persist(); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY, 0o600)
	if err != nil {
		return errCoordinationJournalIO
	}
	if errors.Join(file.Truncate(int64(valid)), file.Sync(), file.Close()) != nil {
		return errCoordinationJournalIO
	}
	return nil
}

func (j *coordinationJournal) segmentPath(sequence uint64) string {
	return filepath.Join(j.dir, fmt.Sprintf("%020d.jsonl", sequence))
}
func (j *coordinationJournal) persist() error {
	data := []byte(wire(j.manifest))
	if len(data) > coordinationSegmentBytes {
		return errors.New("COORDINATION_CAPACITY: journal manifest is full")
	}
	return coordinationAtomicBytes(filepath.Join(j.dir, "manifest.json"), data)
}
func (j *coordinationJournal) index(item coordinationIndexed) error {
	id := item.record.Input.TransitionID
	if _, found := j.transitions[id]; found {
		return errCoordinationJournalCorrupt
	}
	j.transitions[id] = item
	for _, resource := range item.record.Input.Resources {
		j.resources[resource]++
	}
	j.records = append(j.records, item)
	j.bytes += item.bytes
	return nil
}
func (j *coordinationJournal) prune(ms int64, incoming int) error {
	count := 0
	if incoming > 0 {
		count = 1
	}
	for (len(j.records) > 0 && ms-j.records[0].record.Time >= coordinationRetentionMS) || j.bytes+incoming > coordinationStoreBytes-coordinationReservedBytes || len(j.records)+count > coordinationStoreEvents {
		if len(j.manifest.Segments) == 0 {
			return errors.New("COORDINATION_CAPACITY: event cannot fit")
		}
		segment := j.manifest.Segments[0]
		end, retired := segment, 0
		for _, item := range j.records {
			if item.segment != segment {
				break
			}
			retired++
			end = item.record.Sequence
		}
		before := j.manifest
		j.manifest.Floor = max(end, j.manifest.Floor)
		j.manifest.Segments = j.manifest.Segments[1:]
		if err := j.persist(); err != nil {
			j.manifest = before
			return err
		}
		for _, item := range j.records[:retired] {
			delete(j.transitions, item.record.Input.TransitionID)
			j.bytes -= item.bytes
			for _, resource := range item.record.Input.Resources {
				j.resources[resource]--
				if j.resources[resource] == 0 {
					delete(j.resources, resource)
				}
			}
		}
		clear(j.records[:retired])
		j.records = j.records[retired:]
		if len(j.manifest.Segments) == 0 {
			j.tailBytes = 0
		}
		if err := os.Remove(j.segmentPath(segment)); err == nil {
			if indexSyncDirectory(j.dir) != nil {
				return errCoordinationJournalIO
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return errCoordinationJournalIO
		}
	}
	return nil
}
func (j *coordinationJournal) emit(input coordinationEventInput, ms int64) (object, error) {
	sequence := j.manifest.Next
	if input.ThreadRefs == nil {
		input.ThreadRefs = []coordinationThreadRef{}
	}
	if input.EvidenceRefs == nil {
		input.EvidenceRefs = []coordinationEvidenceRef{}
	}
	event, err := input.project(j.manifest.Epoch, sequence, ms)
	if err != nil {
		return nil, err
	}
	record := coordinationRecord{sequence, ms, input}
	data := []byte(wire(record) + "\n")
	eventBytes := len(wire(event))
	if len(data) > coordinationEventBytes || eventBytes > coordinationEventBytes {
		return nil, errors.New("COORDINATION_CAPACITY: projected event must fit 2 KiB")
	}
	if prior, ok := j.transitions[input.TransitionID]; ok {
		if wire(prior.record.Input) != wire(input) {
			return nil, errors.New("COORDINATION_TRANSITION_CONFLICT: retain the original transition payload")
		}
		return object{"eventId": event["eventId"], "sequence": prior.record.Sequence, "duplicate": true}, nil
	}
	if j.emissionSecond != ms/1000 {
		j.emissionSecond, j.emissions = ms/1000, 0
	}
	if j.emissions >= 100 {
		j.manifest.Dropped = saturatingIncrement(j.manifest.Dropped)
		if err := j.persist(); err != nil {
			return nil, err
		}
		return nil, errors.New("COORDINATION_RATE_LIMIT: retry the pending transition after one second")
	}
	if sequence == math.MaxUint64 {
		return nil, errors.New("COORDINATION_CAPACITY: sequence exhausted")
	}
	if err := j.prune(ms, len(data)); err != nil {
		return nil, err
	}
	before := j.manifest
	rotate := len(j.manifest.Segments) == 0 || j.tailBytes+len(data) > coordinationSegmentBytes
	if rotate {
		j.manifest.Segments = append(j.manifest.Segments, sequence)
	}
	j.manifest.Next++
	if err := j.persist(); err != nil {
		j.manifest = before
		return nil, err
	}
	segment := j.manifest.Segments[len(j.manifest.Segments)-1]
	file, err := os.OpenFile(j.segmentPath(segment), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, errCoordinationJournalIO
	}
	_, err = file.Write(data)
	if errors.Join(err, file.Sync(), file.Close()) != nil {
		return nil, errCoordinationJournalIO
	}
	if rotate {
		if indexSyncDirectory(j.dir) != nil {
			return nil, errCoordinationJournalIO
		}
		j.tailBytes = 0
	}
	j.tailBytes += len(data)
	j.emissions++
	err = j.index(coordinationIndexed{record: record, segment: segment, eventBytes: eventBytes, bytes: len(data)})
	return object{"eventId": event["eventId"], "sequence": sequence, "duplicate": false}, err
}
func (j *coordinationJournal) encode(cursor coordinationCursor) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(wire(cursor)))
	return payload + "." + hash([]byte(j.manifest.CursorKey+":"+payload))
}
func (j *coordinationJournal) decode(encoded string) (coordinationCursor, bool) {
	var cursor coordinationCursor
	payload, signature, found := strings.Cut(encoded, ".")
	if !found || len(encoded) > 2048 || signature != hash([]byte(j.manifest.CursorKey+":"+payload)) {
		return cursor, false
	}
	data, err := base64.RawURLEncoding.DecodeString(payload)
	valid := err == nil && decodeCoordinationRecord(data, &cursor) == nil && cursor.Epoch == j.manifest.Epoch
	return cursor, valid
}
func (j *coordinationJournal) coverage() object {
	state := "complete"
	if j.manifest.Gaps > 0 || j.manifest.Dropped > 0 {
		state = "partial"
	}
	return object{"state": state, "gaps": j.manifest.Gaps, "dropped": j.manifest.Dropped, "retainedAfterSequence": j.manifest.Floor, "retainedEvents": len(j.records), "retainedBytes": j.bytes}
}
func (j *coordinationJournal) pullBudget(reader coordinationReader) error {
	key := hash([]byte(wire(reader.identity())))
	now := time.Now()
	bucket, exists := j.readers[key]
	if !exists {
		if len(j.readers) >= 4096 {
			maps.DeleteFunc(j.readers, func(_ string, b coordinationBucket) bool { return now.Sub(b.at) >= time.Minute })
			if len(j.readers) >= 4096 {
				return errors.New("COORDINATION_CAPACITY: reader budget full; retry after one minute")
			}
		}
		bucket = coordinationBucket{tokens: 10, at: now}
	}
	bucket.tokens = min(10, bucket.tokens+now.Sub(bucket.at).Seconds())
	bucket.at = now
	if bucket.tokens < 1 {
		j.readers[key] = bucket
		return errors.New("COORDINATION_RATE_LIMIT: retry events after one second")
	}
	bucket.tokens--
	j.readers[key] = bucket
	return nil
}

func (j *coordinationJournal) query(reader coordinationReader, query coordinationQuery, ms int64) (object, error) {
	if err := j.pullBudget(reader); err != nil {
		return nil, err
	}
	if err := j.prune(ms, 0); err != nil {
		return nil, err
	}
	limit := 50
	if query.Limit != nil {
		limit = *query.Limit
	}
	if limit < 1 || limit > 200 || (query.Kinds != nil && (len(query.Kinds) == 0 || len(query.Kinds) > 16)) {
		return nil, errors.New("INVALID_ARGUMENT: events limit is 1..200 and kinds contains 1..16 kinds")
	}
	if query.Kinds != nil {
		for _, kind := range query.Kinds {
			if !slices.Contains(coordinationEventKinds[:], kind) {
				return nil, errors.New("INVALID_ARGUMENT: read guide for events")
			}
		}
		query.Kinds = slices.Clone(query.Kinds)
		slices.SortFunc(query.Kinds, func(a, b string) int {
			return slices.Index(coordinationEventKinds[:], a) - slices.Index(coordinationEventKinds[:], b)
		})
		query.Kinds = slices.Compact(query.Kinds)
	}
	var cursor coordinationCursor
	var decoded bool
	if query.Since != nil {
		cursor, decoded = j.decode(*query.Since)
	}
	if query.Resource != nil {
		resource := *query.Resource
		lane := coordinationLaneShorthand(resource)
		if lane != "" && decoded && cursor.Resource != nil && strings.HasPrefix(*cursor.Resource, "lane:") && strings.HasSuffix(*cursor.Resource, "/"+lane) {
			resource = *cursor.Resource
		} else {
			var err error
			resource, err = resolveCoordinationResource(resource, slices.Collect(maps.Keys(j.resources)))
			if err != nil {
				return nil, err
			}
		}
		query.Resource = &resource
	}
	scope, high := reader.scope(query), j.manifest.Next-1
	encode := func(after, snapshot uint64) string {
		return j.encode(coordinationCursor{j.manifest.Epoch, scope, query.Resource, after, snapshot})
	}
	oldest := encode(j.manifest.Floor, high)
	matches := func(item coordinationIndexed) bool {
		return (query.Resource == nil || slices.Contains(item.record.Input.Resources, *query.Resource)) &&
			(query.Kinds == nil || slices.Contains(query.Kinds, item.record.Input.Kind))
	}
	after, snapshot := high, high
	if query.Since != nil {
		var code string
		switch {
		case decoded && cursor.Scope != scope:
			code = "CURSOR_SCOPE_CHANGED"
		case !decoded || cursor.After < j.manifest.Floor || cursor.After > high || cursor.High > high || cursor.After > cursor.High:
			code = "CURSOR_EXPIRED"
		}
		if code != "" {
			args := object{"since": oldest, "limit": limit}
			if query.Resource != nil {
				args["resource"] = *query.Resource
			}
			if query.Kinds != nil {
				args["kinds"] = query.Kinds
			}
			return object{"state": "failed", "error": object{"code": code, "message": "Event replay has a gap; restart from resetCursor with the current filters"},
				"events": []any{}, "resetCursor": oldest, "oldestCursor": oldest, "nextCursor": oldest, "hasMore": false,
				"coverage": object{"state": "partial", "gap": code}, "observedAt": coordinationTimestamp(ms),
				"next": object{"via": "query", "op": "events", "args": args}}, nil
		}
		after = cursor.After
		if cursor.After != cursor.High {
			snapshot = cursor.High
		}
	} else {
		count, size := 0, 4096+coordinationCoverageBytes
		for _, item := range slices.Backward(j.records) {
			if !matches(item) {
				continue
			}
			count++
			size += item.eventBytes
			if count > limit || size > coordinationPageBytes {
				break
			}
			after = item.record.Sequence - 1
		}
	}
	events := []object{}
	size := 4096 + coordinationCoverageBytes
	position, more := after, false
	start := sort.Search(len(j.records), func(index int) bool { return j.records[index].record.Sequence > after })
	for _, item := range j.records[start:] {
		if item.record.Sequence > snapshot {
			break
		}
		if matches(item) {
			if len(events) == limit || size+item.eventBytes > coordinationPageBytes {
				more = true
				break
			}
			event, err := item.record.Input.project(j.manifest.Epoch, item.record.Sequence, item.record.Time)
			if err != nil {
				return nil, err
			}
			events = append(events, event)
			size += item.eventBytes
		}
		position = item.record.Sequence
	}
	if !more {
		position = snapshot
	}
	return object{"events": events, "nextCursor": encode(position, snapshot), "oldestCursor": oldest, "hasMore": more,
		"coverage": j.coverage(), "observedAt": coordinationTimestamp(ms)}, nil
}

func (j *coordinationJournal) recoveryEvents() ([]object, bool, error) {
	events := make([]object, 0, len(j.records))
	for _, item := range j.records {
		event, err := item.record.Input.project(j.manifest.Epoch, item.record.Sequence, item.record.Time)
		if err != nil {
			return nil, false, err
		}
		events = append(events, event)
	}
	return events, j.manifest.Floor > 0 || j.manifest.Gaps > 0, nil
}
