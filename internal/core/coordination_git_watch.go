package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const coordinationGitRefLimit = 128
const coordinationGitByteLimit = 256 * 1024

var coordinationBaselines struct {
	sync.Mutex
	rows []object
}
var coordinationRetainedBaselines func() ([]object, error)

func observeCoordinationBaseline(row object) {
	coordinationBaselines.Lock()
	defer coordinationBaselines.Unlock()
	next := clone(row)
	for i, current := range coordinationBaselines.rows {
		if current["threadId"] == next["threadId"] && current["turnId"] == next["turnId"] {
			if next["endedAt"] == nil {
				next["endedAt"] = current["endedAt"]
			}
			coordinationBaselines.rows[i] = next
			return
		}
	}
	if len(coordinationBaselines.rows) >= 128 {
		coordinationBaselines.rows = slices.Delete(coordinationBaselines.rows, 0, 1)
		coordinationGap("baselines", "capacity")
	}
	coordinationBaselines.rows = append(coordinationBaselines.rows, next)
}

func endCoordinationBaseline(thread, turn string) {
	coordinationBaselines.Lock()
	defer coordinationBaselines.Unlock()
	for _, row := range coordinationBaselines.rows {
		if row["threadId"] == thread && row["turnId"] == turn && row["endedAt"] == nil {
			row["endedAt"] = now()
		}
	}
}

func coordinationBaselineActive() bool {
	coordinationBaselines.Lock()
	defer coordinationBaselines.Unlock()
	return slices.ContainsFunc(coordinationBaselines.rows, func(row object) bool { return row["endedAt"] == nil })
}

type coordinationGitCachedText struct {
	stamp *fileStamp
	text  string
}
type coordinationGitCachedRefs struct {
	stamp *fileStamp
	refs  map[string]string
}
type coordinationGitCachedEntries struct {
	stamp *fileStamp
	paths []string
}

type coordinationRefReader struct {
	files       map[string]coordinationGitCachedText
	packed      map[string]coordinationGitCachedRefs
	directories map[string]coordinationGitCachedEntries
	bytes       int
}

func (reader *coordinationRefReader) read(path string, cost *runtimeCost) (string, error) {
	stamp, err := readStamp(path)
	if err != nil {
		return "", err
	}
	if cached, ok := reader.files[path]; ok && stampSame(stamp, cached.stamp) {
		if cost != nil {
			cost.hits.Add(1)
		}
		return cached.text, nil
	}
	if cost != nil {
		cost.misses.Add(1)
	}
	var contents string
	if stamp != nil {
		file, err := os.Open(path)
		if err != nil {
			return "", err
		}
		data, err := io.ReadAll(io.LimitReader(file, coordinationGitByteLimit+1))
		_ = file.Close()
		if err != nil {
			return "", err
		}
		if cost != nil {
			cost.read.Add(uint64(len(data)))
			cost.parsed.Add(uint64(len(data)))
		}
		if len(data) > coordinationGitByteLimit {
			return "", errors.New("ref-bytes-capacity")
		}
		if !utf8.Valid(data) {
			return "", errors.New("invalid-ref")
		}
		contents = string(data)
	}
	if after, err := readStamp(path); err != nil || !stampSame(after, stamp) {
		return "", errors.New("refs-changing")
	}
	if reader.files == nil {
		reader.files = map[string]coordinationGitCachedText{}
	}
	reader.bytes -= len(reader.files[path].text)
	if len(reader.files) >= 8192 || reader.bytes+len(contents) > 16*1024*1024 {
		clear(reader.files)
		reader.bytes = 0
		coordinationGap("git", "ref-cache-capacity")
	}
	reader.bytes += len(contents)
	reader.files[path] = coordinationGitCachedText{stamp, contents}
	return contents, nil
}

func (reader *coordinationRefReader) gitDir(root string, cost *runtimeCost) (string, error) {
	git := filepath.Join(root, ".git")
	if info, err := os.Stat(git); err == nil && info.IsDir() {
		return git, nil
	}
	pointer, err := reader.read(git, cost)
	if err != nil {
		return "", err
	}
	relative, ok := strings.CutPrefix(strings.TrimSpace(pointer), "gitdir: ")
	if !ok {
		return "", errors.New("unreachable")
	}
	if filepath.IsAbs(relative) {
		return relative, nil
	}
	return filepath.Join(root, relative), nil
}

func (reader *coordinationRefReader) common(root string, cost *runtimeCost) (string, error) {
	git, err := reader.gitDir(root, cost)
	if err != nil {
		return "", err
	}
	value, err := reader.read(filepath.Join(git, "commondir"), cost)
	if err != nil {
		return "", err
	}
	switch value = strings.TrimSpace(value); {
	case filepath.IsAbs(value):
		git = value
	case value != "":
		git = filepath.Join(git, value)
	}
	if path, err := filepath.EvalSymlinks(git); err == nil {
		return filepath.Abs(path)
	}
	return "", errors.New("unreachable")
}

func coordinationWatchedRef(name string) bool {
	if name == "refs/heads/main" {
		return true
	}
	lane, ok := strings.CutPrefix(name, "refs/heads/wt/")
	return ok && coordinationIdentifier(lane)
}

func insertCoordinationRef(refs map[string]string, name, oid string) error {
	if !coordinationOIDPattern.MatchString(oid) {
		return errors.New("invalid-object-id")
	}
	refs[name] = oid
	if len(refs) > coordinationGitRefLimit {
		return errors.New("ref-count-capacity")
	}
	return nil
}

func (reader *coordinationRefReader) refs(common string, cost *runtimeCost) (map[string]string, error) {
	packed := filepath.Join(common, "packed-refs")
	stamp, err := readStamp(packed)
	if err != nil {
		return nil, err
	}
	value, exists := reader.packed[packed]
	if !exists || !stampSame(value.stamp, stamp) {
		raw, err := reader.read(packed, cost)
		if err != nil {
			return nil, err
		}
		refs := map[string]string{}
		for line := range strings.Lines(raw) {
			if cost != nil {
				cost.rows.Add(1)
			}
			if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "^") {
				continue
			}
			oid, name, ok := strings.Cut(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), " ")
			if ok && coordinationWatchedRef(name) {
				if err := insertCoordinationRef(refs, name, oid); err != nil {
					return nil, err
				}
			}
		}
		value = coordinationGitCachedRefs{stamp, refs}
		if reader.packed == nil {
			reader.packed = map[string]coordinationGitCachedRefs{}
		}
		if len(reader.packed) >= 256 {
			clear(reader.packed)
		}
		reader.packed[packed] = value
	}
	refs := maps.Clone(value.refs)
	heads := filepath.Join(common, "refs", "heads")
	main, err := reader.read(filepath.Join(heads, "main"), cost)
	if err != nil {
		return nil, err
	}
	if main != "" {
		if err := insertCoordinationRef(refs, "refs/heads/main", strings.TrimSpace(main)); err != nil {
			return nil, err
		}
	}
	dir := filepath.Join(heads, "wt")
	stamp, err = readStamp(dir)
	if err != nil {
		return nil, err
	}
	known, exists := reader.directories[dir]
	if !exists || !stampSame(known.stamp, stamp) {
		paths := []string{}
		if stamp != nil {
			file, err := os.Open(dir)
			if err != nil {
				return nil, errors.New("unreachable")
			}
			entries, err := file.ReadDir(coordinationGitRefLimit + 1)
			_ = file.Close()
			if err != nil && !errors.Is(err, io.EOF) {
				return nil, errors.New("unreachable")
			}
			for _, entry := range entries {
				if entry.IsDir() {
					return nil, errors.New("nested-lane-unsupported")
				}
				paths = append(paths, filepath.Join(dir, entry.Name()))
			}
			if len(paths) > coordinationGitRefLimit {
				return nil, errors.New("ref-count-capacity")
			}
		}
		if after, err := readStamp(dir); err != nil || !stampSame(stamp, after) {
			return nil, errors.New("refs-changing")
		}
		known = coordinationGitCachedEntries{stamp, paths}
		if reader.directories == nil {
			reader.directories = map[string]coordinationGitCachedEntries{}
		}
		if len(reader.directories) >= 256 {
			clear(reader.directories)
		}
		reader.directories[dir] = known
	}
	for _, path := range known.paths {
		name := filepath.Base(path)
		if !utf8.ValidString(name) {
			return nil, errors.New("invalid-ref")
		}
		if strings.HasSuffix(name, ".lock") || !coordinationIdentifier(name) {
			continue
		}
		if cost != nil {
			if stamp, err := readStamp(path); err == nil && !stampSame(stamp, reader.files[path].stamp) {
				cost.rows.Add(1)
			}
		}
		oid, err := reader.read(path, cost)
		if err != nil {
			return nil, err
		}
		if oid != "" {
			if err := insertCoordinationRef(refs, "refs/heads/wt/"+name, strings.TrimSpace(oid)); err != nil {
				return nil, err
			}
		}
	}
	return refs, nil
}

type coordinationRefSnapshot struct {
	common, head, identity string
	refs                   map[string]string
}

func (reader *coordinationRefReader) snapshot(root string, cost *runtimeCost) (coordinationRefSnapshot, error) {
	var result coordinationRefSnapshot
	common, err := reader.common(root, cost)
	if err != nil {
		return result, err
	}
	refs, err := reader.refs(common, cost)
	if err != nil {
		return result, err
	}
	git, err := reader.gitDir(root, cost)
	if err != nil {
		return result, err
	}
	head, err := reader.read(filepath.Join(git, "HEAD"), cost)
	if err != nil {
		return result, err
	}
	stamp, err := readStamp(common)
	if err != nil || stamp == nil {
		return result, errors.New("unreachable")
	}
	identity := "Err(Error { kind: Unsupported, message: \"creation time is not available\" })"
	if stamp.Identity != nil {
		identity = fmt.Sprintf("%d:%d", uint64(stamp.Identity[0]), uint64(stamp.Identity[1]))
	} else if stamp.Created != nil {
		identity = fmt.Sprintf("Ok(SystemTime { intervals: %d })", (stamp.Created.Seconds+11644473600)*10000000+int64(stamp.Created.Nanos/100))
	}
	return coordinationRefSnapshot{common, head, identity, refs}, nil
}

func correlateCoordinationRef(rows []object, common, branch string, old *string, since string, ancestry bool) *coordinationAttribution {
	threads := []string{}
	candidates := 0
	if ancestry {
		for _, row := range rows {
			head := axOptional(row["head"])
			thread := text(row, "threadId")
			if row["commonDir"] == common && row["ref"] == branch && samePointer(head, old) && text(row, "capturedAt") != "" &&
				(row["endedAt"] == nil || text(row, "endedAt") >= since) && coordinationIdentifier(thread) {
				candidates++
				threads = append(threads, thread)
			}
		}
	}
	confidence := "unknown"
	if candidates == 1 {
		confidence = "correlated"
	} else if candidates > 1 {
		confidence = "ambiguous"
	}
	threads = axSet(threads)
	return &coordinationAttribution{confidence, threads[:min(16, len(threads))]}
}

type coordinationGitWatcher struct {
	reader   coordinationRefReader
	inflight chan struct{}
	bootSeen map[string]string
}

var coordinationGitState coordinationGitWatcher

func (watcher *coordinationGitWatcher) readSnapshot(ctx context.Context, root string) (coordinationRefSnapshot, error) {
	if watcher.inflight != nil {
		select {
		case <-watcher.inflight:
		default:
			return coordinationRefSnapshot{}, errors.New("filesystem-read-in-progress")
		}
	}
	type result struct {
		value coordinationRefSnapshot
		err   error
	}
	output := make(chan result, 1)
	done := make(chan struct{})
	watcher.inflight = done
	cost := currentRuntimeCost(ctx)
	go func() {
		defer close(done)
		snapshot, err := watcher.reader.snapshot(root, cost)
		output <- result{snapshot, err}
	}()
	select {
	case response := <-output:
		<-done
		return response.value, response.err
	case <-ctx.Done():
		return coordinationRefSnapshot{}, ctx.Err()
	}
}

func (watcher *coordinationGitWatcher) scan(ctx context.Context, project, key, rootPath, dir string) error {
	snapshot, err := watcher.readSnapshot(ctx, rootPath)
	if err != nil {
		return err
	}
	repository := hash([]byte(project + ":" + snapshot.common))
	path := filepath.Join(dir, repository+".json")
	checkpoint := filepath.Join(dir, repository+".checkpoint.json")
	oldValue, err := cachedJSONWithRuntimeCost(path, currentRuntimeCost(ctx))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	old := obj(oldValue)
	if old != nil {
		if err := coordinationProjectAt(ctx, path, checkpoint, old); err != nil {
			return err
		}
	}
	previous := map[string]string{}
	_ = unmarshalJSON([]byte(wire(old["refs"])), &previous)
	since, seen := watcher.bootSeen[repository]
	continuous := seen && old["identity"] == snapshot.identity
	pending := []coordinationEventInput{}
	if old["refs"] != nil && old["identity"] == snapshot.identity && !maps.Equal(previous, snapshot.refs) {
		coordinationBaselines.Lock()
		baselines := make([]object, 0, len(coordinationBaselines.rows))
		for _, row := range coordinationBaselines.rows {
			baselines = append(baselines, clone(row))
		}
		coordinationBaselines.Unlock()
		if coordinationRetainedBaselines != nil {
			retained, err := coordinationRetainedBaselines()
			if err != nil {
				return err
			}
			for _, row := range retained {
				if len(baselines) >= 128 {
					break
				}
				if !slices.ContainsFunc(baselines, func(other object) bool {
					return row["threadId"] == other["threadId"] && row["turnId"] == other["turnId"]
				}) {
					baselines = append(baselines, row)
				}
			}
		}
		names := slices.Collect(maps.Keys(previous))
		names = append(names, slices.Collect(maps.Keys(snapshot.refs))...)
		for _, name := range axSet(names) {
			before, had := previous[name]
			after, has := snapshot.refs[name]
			if before == after {
				continue
			}
			var old, newOID *string
			if had {
				old = &before
			}
			if has {
				newOID = &after
			}
			movement := "unknown"
			switch {
			case !had:
				movement = "created"
			case !has:
				movement = "deleted"
			case coordinationLocalGit != nil:
				_, err := coordinationLocalGit(ctx, rootPath, "merge-base", "--is-ancestor", before, after)
				if err == nil {
					movement = "moved"
					if err := observeCoordinationFixes(ctx, rootPath, snapshot.common, name, before, after, continuous, baselines, filepath.Join(dir, "quality-correlations.json")); err != nil {
						return err
					}
				} else if err.Error() == "GIT_NOT_ANCESTOR" {
					movement = "non-fast-forward"
				}
			}
			resource := "project:" + project + "/main"
			if lane, ok := strings.CutPrefix(name, "refs/heads/wt/"); ok {
				resource = "lane:" + project + "/" + lane
			}
			input := newCoordinationEvent(id(), "git.ref-moved", []string{resource})
			input.Origin = &coordinationPrincipal{Type: "arc"}
			input.Observation = &coordinationObservation{OldOID: old, NewOID: newOID, Movement: &movement}
			input.Attribution = correlateCoordinationRef(baselines, snapshot.common, name, old, since, continuous && movement == "moved")
			pending = append(pending, input)
		}
	} else if old["refs"] != nil && old["identity"] != snapshot.identity {
		coordinationGap(key, "repository-replaced")
	}
	head := strings.TrimSpace(snapshot.head)
	headState := "unavailable"
	if ref, ok := strings.CutPrefix(head, "ref: "); ok {
		switch {
		case snapshot.refs[ref] != "":
			headState = "attached"
		case coordinationWatchedRef(ref):
			headState = "unborn"
		default:
			headState = "unwatched-branch"
		}
	} else if coordinationOIDPattern.MatchString(head) {
		headState = "detached"
	}
	coordinationHeadState(key, headState)
	if old["refs"] == nil || !maps.Equal(previous, snapshot.refs) || old["identity"] != snapshot.identity || old["headState"] != headState || len(pending) > 0 {
		row := clone(object{"refs": snapshot.refs, "identity": snapshot.identity, "headState": headState, "observedAt": now(), "coordinationPending": pending})
		if err := coordinationDurable(path, row); err != nil {
			return err
		}
		if err := coordinationProjectAt(ctx, path, checkpoint, row); err != nil {
			return err
		}
	}
	if watcher.bootSeen == nil {
		watcher.bootSeen = map[string]string{}
	}
	watcher.bootSeen[repository] = now()
	return nil
}

func pollCoordinationGit(ctx context.Context) error {
	cost := currentRuntimeCost(ctx)
	snapshot, err := cachedJSONWithRuntimeCost(filepath.Join(root(), "coordination/projects.json"), cost)
	projects := arr(field(snapshot, "projects"))
	if err != nil || projects == nil {
		coordinationGap("git", "project-catalog-unavailable")
		return err
	}
	coordinationCoverage.Lock()
	if coordinationCoverage.rows == nil {
		coordinationCoverage.rows = map[string]object{}
	}
	coordinationCoverage.rows["projectRegistry"] = object{"state": "last-upstream-read", "observedAt": field(snapshot, "observedAt")}
	coordinationCoverage.Unlock()
	coordinationGap("git", "observed")
	if len(projects) > 32 {
		coordinationGap("git", "project-count-capacity")
	}
	projects = projects[:min(32, len(projects))]
	cost.scanSet.Store(uint64(len(projects)))
	dir := filepath.Join(root(), "coordination/ref-watch")
	count := 0
	for _, project := range projects {
		cost.rows.Add(1)
		id := text(project, "id")
		if !coordinationIdentifier(id) {
			continue
		}
		roots := arr(field(project, "roots"))
		for index, repo := range roots[:min(8, len(roots))] {
			cost.rows.Add(1)
			count++
			if count > 32 {
				coordinationGap("git", "root-count-capacity")
				return nil
			}
			bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
			key := fmt.Sprintf("%s-%d", id, index)
			err := coordinationGitState.scan(bounded, id, key, text(repo, "path"), dir)
			cancel()
			state := "observed"
			if err != nil {
				clear(coordinationGitState.bootSeen)
				state = "unreachable-or-ref-capacity"
				if errors.Is(err, context.DeadlineExceeded) {
					state = "deadline"
				}
			}
			coordinationGap(key, state)
			if ctx.Err() != nil {
				return ctx.Err()
			}
		}
	}
	return nil
}

var coordinationCatalogWrite sync.Mutex

func observeCoordinationProjects(projects []object) {
	coordinationCatalogWrite.Lock()
	defer coordinationCatalogWrite.Unlock()
	reader := coordinationRefReader{}
	rows := []object{}
	for _, project := range projects[:min(33, len(projects))] {
		roots := arr(project["roots"])
		paths := []object{}
		for _, raw := range roots[:min(9, len(roots))] {
			path := text(raw, "path")
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil {
				resolved = path
			}
			var common any
			if value, err := reader.common(path, nil); err == nil {
				common = value
			}
			paths = append(paths, object{"path": resolved, "commonDir": common})
		}
		rows = append(rows, object{"id": project["id"], "name": project["name"], "roots": paths})
	}
	if err := coordinationDurable(filepath.Join(root(), "coordination/projects.json"), object{"projects": rows, "observedAt": now()}); err != nil {
		coordinationGap("git", "project-catalog-persistence-failed")
	}
}

func init() {
	coordinationGitCommon = func(root string) (string, error) { reader := coordinationRefReader{}; return reader.common(root, nil) }
	coordinationGitTerminal = endCoordinationBaseline
	coordinationGitPoll = pollCoordinationGit
	coordinationGitActive = coordinationBaselineActive
}
