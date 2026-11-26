package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

var onRegisteredProjects func([]any)
var prepareProjectImage func([]byte, string, object) (object, []any, error)

type projectCatalogCache struct {
	mu     sync.Mutex
	readAt time.Time
	rows   []any
}

var projectCatalogs sync.Map

type projectProvider func(context.Context, string, any, time.Duration) (any, error)

func projectClient(s *service) projectProvider {
	return func(ctx context.Context, method string, args any, timeout time.Duration) (any, error) {
		return nativeControlRequest(ctx, s, method, args, timeout)
	}
}

func listNativeProjects(ctx context.Context, call projectProvider) ([]any, error) {
	rows := []any{}
	seen := map[string]bool{}
	var cursor any
	for {
		reply, err := call(ctx, "project/list", object{"cursor": cursor}, 60*time.Second)
		if err != nil {
			return nil, err
		}
		items := arr(field(reply, "data"))
		if items == nil {
			return nil, errors.New("invalid project list")
		}
		rows = append(rows, items...)
		cursor = field(reply, "nextCursor")
		if cursor == nil {
			if onRegisteredProjects != nil {
				onRegisteredProjects(rows)
			}
			return rows, nil
		}
		key := wire(cursor)
		if seen[key] {
			return nil, errors.New("project pagination did not advance")
		}
		seen[key] = true
	}
}

func cachedNativeProjects(ctx context.Context, s *service) ([]any, error) {
	value, _ := projectCatalogs.LoadOrStore(s, &projectCatalogCache{})
	cache := value.(*projectCatalogCache)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if time.Since(cache.readAt) >= 30*time.Second {
		at := time.Now()
		rows, err := listNativeProjects(ctx, projectClient(s))
		if err != nil {
			return nil, err
		}
		cache.rows, cache.readAt = rows, at
	}
	return cache.rows, nil
}

func localProjectName(projects []any, directory, projectID string) any {
	if projectID != "" {
		if project := find(projects, "id", projectID); project != nil {
			return project["name"]
		}
		return nil
	}
	depth, candidates := 0, 0
	var selected any
	for _, p := range projects {
		best := 0
		for _, row := range arr(field(p, "roots")) {
			root := text(row, "path")
			if root != "" && projectContains(root, directory) {
				parts := strings.FieldsFunc(filepath.Clean(root), func(r rune) bool { return r == '/' || operatingSystem == "windows" && r == '\\' })
				best = max(best, len(parts)+1)
			}
		}
		switch {
		case best > depth:
			depth, candidates, selected = best, 1, field(p, "name")
		case best > 0 && best == depth:
			candidates++
		}
	}
	if candidates == 1 {
		return selected
	}
	return nil
}

func projectBase(path string) string {
	base := filepath.Base(path)
	if base == "." || base == string(os.PathSeparator) || base == filepath.VolumeName(path) {
		return ""
	}
	return base
}

func projectContains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func projectPath(root, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(root, path)
}

func projectParentComponent(path string) bool {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || operatingSystem == "windows" && r == '\\' })
	return slices.Contains(parts, "..")
}

func projectRootError(roots []any) error {
	rows := []string{}
	for _, r := range roots {
		path := text(r, "path")
		name, ok := field(r, "name").(string)
		if !ok {
			name = projectBase(path)
			if name == "" {
				name = path
			}
		}
		rows = append(rows, fmt.Sprintf("%s (%s)", name, path))
	}
	return errors.New("Specify root; available roots: " + strings.Join(rows, ", "))
}

func selectProjectRoot(roots []any, selector string) (object, error) {
	if filepath.IsAbs(selector) || projectParentComponent(selector) {
		return nil, errors.New("root must be a root name or relative path without parent traversal")
	}
	search := filepath.ToSlash(filepath.Clean(selector))
	matches := []any{}
	for _, row := range roots {
		path := filepath.ToSlash(filepath.Clean(text(row, "path")))
		if field(row, "name") == selector || search == "." || path == search || strings.HasSuffix(path, "/"+search) {
			matches = append(matches, row)
		}
	}
	if len(matches) == 1 {
		return obj(matches[0]), nil
	}
	return nil, projectRootError(roots)
}

func selectRegisteredProject(catalog []any, id string) (object, error) {
	if project := find(catalog, "id", id); project != nil {
		return project, nil
	}
	candidates := []any{}
	for _, p := range catalog {
		if field(p, "name") == id {
			candidates = append(candidates, p)
		}
	}
	if len(candidates) == 1 {
		return obj(candidates[0]), nil
	}
	code := "PROJECT_NOT_FOUND"
	hint := fmt.Sprintf("No registered project matches %s. Select a registered project ID or unique name from query projects.", wire(id))
	if len(candidates) > 1 {
		code = "PROJECT_AMBIGUOUS"
		hint = fmt.Sprintf("The project name %s matches multiple registered projects. Select a project ID from query projects.", wire(id))
	}
	var match any
	var matchPath string
	count := 0
	for _, p := range catalog {
		for _, row := range arr(field(p, "roots")) {
			if path, ok := field(row, "path").(string); ok && projectBase(path) == id {
				match, matchPath, count = p, path, count+1
			}
		}
	}
	if count == 1 {
		hint += fmt.Sprintf(" The matching root %s belongs to project %s (ID %s). Retry with that registered ID or unique name.",
			wire(matchPath), wire(text(match, "name")), wire(text(match, "id")))
	}
	return nil, errors.New(wire(object{"code": code, "message": hint, "next": object{"via": "query", "op": "projects", "args": object{}, "hint": hint}}))
}

func resolveRegisteredProjectRoot(ctx context.Context, project object, selector *string, forExecution bool) (object, error) {
	roots := arr(project["roots"])
	if roots == nil {
		return nil, errors.New("project has no directories")
	}
	if selector != nil {
		return selectProjectRoot(roots, *selector)
	}
	if len(roots) == 1 {
		return obj(roots[0]), nil
	}
	if forExecution {
		return nil, projectRootError(roots)
	}
	named := []any{}
	for _, row := range roots {
		if projectBase(text(row, "path")) == text(project, "name") {
			named = append(named, row)
		}
	}
	if len(named) == 1 {
		return obj(named[0]), nil
	}
	repos := []any{}
	for _, candidate := range roots {
		path := text(candidate, "path")
		top, err := projectGit(ctx, path, "rev-parse", "--show-toplevel")
		if err != nil {
			continue
		}
		root, err := canonicalProjectPath(path)
		if err != nil {
			continue
		}
		if actual, err := canonicalProjectPath(strings.TrimSpace(top)); err == nil && actual == root {
			repos = append(repos, candidate)
		}
	}
	if len(repos) == 1 {
		return obj(repos[0]), nil
	}
	return nil, projectRootError(roots)
}

func canonicalProjectPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

func resolveProjectRoot(ctx context.Context, s *service, ref string, selector *string, forExecution bool, call projectProvider) (object, error) {
	if ref == "" {
		return nil, errors.New("PROJECT_REQUIRED_FOR_RELATIVE_PATH")
	}
	path, projectID, name := ref, ref, projectBase(ref)
	if filepath.IsAbs(ref) {
		if selector != nil {
			if _, err := selectProjectRoot([]any{object{"path": ref}}, *selector); err != nil {
				return nil, err
			}
		}
	} else {
		var rows []any
		var err error
		if call != nil {
			rows, err = listNativeProjects(ctx, call)
		} else {
			rows, err = cachedNativeProjects(ctx, s)
		}
		if err != nil {
			return nil, err
		}
		project, err := selectRegisteredProject(rows, ref)
		if err != nil {
			return nil, err
		}
		selected, err := resolveRegisteredProjectRoot(ctx, project, selector, forExecution)
		if err != nil {
			return nil, err
		}
		path, projectID, name = text(selected, "path"), text(project, "id"), text(project, "name")
	}
	if !forExecution {
		if err := checkProtectedPath(path); err != nil {
			return nil, err
		}
	}
	actual, err := canonicalProjectPath(path)
	if err != nil {
		return nil, err
	}
	if !forExecution {
		if err := checkProtectedPath(actual); err != nil {
			return nil, err
		}
	}
	if info, err := os.Stat(actual); err != nil || !info.IsDir() {
		return nil, errors.New("project must be a directory")
	}
	return object{"id": projectID, "name": name, "root": actual}, nil
}

func resolveProjectArgs(ctx context.Context, s *service, args object) (object, error) {
	return resolveProjectRoot(ctx, s, text(args, "project"), optionalProjectString(args["root"]), false, nil)
}

func optionalProjectString(value any) *string {
	if text, ok := value.(string); ok {
		return &text
	}
	return nil
}

func projectWorkingDirectory(ctx context.Context, s *service, args object) (any, error) {
	if value, ok := args["cwd"]; ok {
		return value, nil
	}
	project, err := resolveProjectRoot(ctx, s, text(args, "project"), optionalProjectString(args["root"]), true, nil)
	return project["root"], err
}

func dispatchProject(ctx context.Context, s *service, args object, call projectProvider) (object, *string, error) {
	project, err := resolveProjectRoot(ctx, s, text(args, "project"), optionalProjectString(args["root"]), false, call)
	if err != nil {
		return nil, nil, err
	}
	if id := text(project, "id"); !filepath.IsAbs(id) {
		return project, &id, nil
	}
	if call == nil {
		call = projectClient(s)
	}
	rows, err := listNativeProjects(ctx, call)
	if err != nil {
		return nil, nil, err
	}
	matched := map[string]bool{}
	for _, row := range rows {
		for _, r := range arr(field(row, "roots")) {
			if path, err := canonicalProjectPath(text(r, "path")); err == nil && path == project["root"] {
				matched[text(row, "id")] = true
			}
		}
	}
	if len(matched) == 1 {
		for id := range matched {
			return project, &id, nil
		}
	}
	return project, nil, nil
}

func projectGitMarker(root string) bool {
	ceilings := filepath.SplitList(os.Getenv("GIT_CEILING_DIRECTORIES"))
	for path := root; ; path = filepath.Dir(path) {
		if path != root && slices.Contains(ceilings, path) {
			return false
		}
		if _, err := os.Lstat(filepath.Join(path, ".git")); err == nil {
			return true
		}
		if filepath.Dir(path) == path {
			return false
		}
	}
}

type projectGitBuffer struct {
	bytes.Buffer
	limited bool
}

func (b *projectGitBuffer) Write(data []byte) (int, error) {
	room := max(0, 16*1024*1024-b.Len())
	_, _ = b.Buffer.Write(data[:min(room, len(data))])
	b.limited = b.limited || len(data) > room
	return len(data), nil
}

func projectGitBytes(ctx context.Context, root string, identity bool, args ...string) ([]byte, error) {
	null := os.DevNull
	gitArgs := []string{"--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + null,
		"-c", "core.attributesFile=" + null, "-c", "diff.external=", "-c", "color.ui=false", "-C", root}
	gitArgs = append(gitArgs, args...)
	wait, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := nativeCommand(wait, "git", gitArgs...)
	cmd.WaitDelay = time.Second
	cmd.Env = []string{}
	for _, name := range []string{"PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CEILING_DIRECTORIES", "SYSTEMROOT", "TEMP", "TMP"} {
		if value, set := os.LookupEnv(name); set {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "LC_ALL=C", "GIT_NO_LAZY_FETCH=1")
	if !identity {
		cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL="+null)
	}
	var stdout, stderr projectGitBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := startOwnedChild(cmd); err != nil {
		return nil, err
	}
	err := cmd.Wait()
	if wait.Err() != nil {
		return nil, errors.New("GIT_TIMEOUT")
	}
	if stdout.limited || stderr.limited {
		return nil, errors.New("GIT_OUTPUT_LIMIT")
	}
	if err == nil {
		return stdout.Bytes(), nil
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return nil, err
	}
	code := exit.ExitCode()
	switch {
	case args[0] == "config" && code == 1:
		return []byte{}, nil
	case args[0] == "merge-base" && slices.Contains(args, "--is-ancestor") && code == 1:
		return nil, errors.New("GIT_NOT_ANCESTOR")
	case strings.Contains(stderr.String(), "not a git repository") && !projectGitMarker(root):
		return nil, errors.New("NOT_GIT_REPOSITORY")
	case args[0] == "show-ref" && slices.Contains(args, "--quiet") && code == 1:
		return nil, errors.New("GIT_REF_MISSING")
	case args[0] == "-c":
		return nil, fmt.Errorf("GIT_WRITE_FAILED: %s\n%s", projectRunePrefix(stderr.String(), 4096), projectRunePrefix(stdout.String(), 4096))
	default:
		return nil, errors.New("GIT_QUERY_FAILED")
	}
}

func projectRunePrefix(value string, limit int) string {
	value = strings.ToValidUTF8(value, "�")
	runes := []rune(value)
	return string(runes[:min(limit, len(runes))])
}

func projectGitString(ctx context.Context, root string, identity bool, args ...string) (string, error) {
	data, err := projectGitBytes(ctx, root, identity, args...)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(data) {
		return "", errors.New("invalid utf-8 sequence")
	}
	return string(data), nil
}

func projectGit(ctx context.Context, root string, args ...string) (string, error) {
	return projectGitString(ctx, root, false, args...)
}

func projectGitUnborn(ctx context.Context, root string) bool {
	head, err := projectGit(ctx, root, "symbolic-ref", "HEAD")
	if err != nil {
		return false
	}
	_, err = projectGit(ctx, root, "show-ref", "--verify", "--quiet", strings.TrimSpace(head))
	return err != nil && err.Error() == "GIT_REF_MISSING"
}

func projectGitWrite(ctx context.Context, s *service, args object) (object, error) {
	project, err := resolveProjectArgs(ctx, s, args)
	if err != nil {
		return nil, err
	}
	root := text(project, "root")
	if _, err := projectGit(ctx, root, "rev-parse", "--git-dir"); err != nil {
		return nil, err
	}
	operation := text(args, "operation")
	permitted, ok := map[string][]string{
		"add": {"paths", "all"}, "unstage": {"paths", "all"}, "commit": {"message"}, "branch": {"branch"}, "switch": {"branch", "create"},
		"stash_push": {"message"}, "stash_pop": {},
	}[operation]
	if !ok {
		return nil, errors.New("unsupported Git write operation")
	}
	for key := range args {
		if !slices.Contains([]string{"project", "root", "operation", "requestId"}, key) && !slices.Contains(permitted, key) {
			return nil, errors.New("argument does not apply to Git operation")
		}
	}
	if operation == "stash_pop" {
		config, err := projectGit(ctx, root, "config", "--name-only", "--get-regexp", `^merge\..*\.driver$`)
		if err != nil {
			return nil, err
		}
		if config != "" {
			return nil, errors.New("stash_pop does not support configured external merge drivers")
		}
	}
	cmd := []string{"-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
		"-c", "submodule.recurse=false", "-c", "rerere.enabled=false"}
	filters, err := projectGit(ctx, root, "config", "--null", "--name-only", "--get-regexp", `^filter\.`)
	if err != nil {
		return nil, err
	}
	for key := range strings.SplitSeq(filters, "\x00") {
		if index := strings.LastIndex(key, "."); index >= 0 {
			driver := key[:index]
			for _, setting := range []string{"clean=", "smudge=", "process=", "required=false"} {
				cmd = append(cmd, "-c", driver+"."+setting)
			}
		}
	}
	if operation == "commit" || operation == "stash_push" {
		for _, key := range []string{"user.name", "user.email"} {
			value, err := projectGitString(ctx, root, true, "config", "--get", key)
			if err != nil {
				return nil, err
			}
			value = strings.TrimRight(value, "\r\n")
			if strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("configure %s in repository or user Git config before committing", key)
			}
			cmd = append(cmd, "-c", key+"="+value)
		}
	}
	switch operation {
	case "add", "unstage":
		raw, havePaths := args["paths"].([]any)
		all := args["all"] == true
		if all == havePaths || havePaths && len(raw) == 0 {
			return nil, errors.New("provide either nonempty paths or all=true")
		}
		paths := []string{}
		if all {
			paths = append(paths, ".")
		} else {
			for _, value := range raw {
				path, ok := value.(string)
				if !ok || path == "" || strings.ContainsRune(path, 0) {
					return nil, errors.New("invalid Git path")
				}
				if filepath.IsAbs(path) || projectParentComponent(path) || filepath.VolumeName(path) != "" {
					return nil, errors.New("Git paths must stay relative to project")
				}
				paths = append(paths, path)
			}
		}
		if operation == "add" {
			cmd = append(cmd, "add", "--all", "--")
		} else if _, err := projectGit(ctx, root, "rev-parse", "--verify", "HEAD"); err == nil {
			cmd = append(cmd, "restore", "--staged", "--")
		} else {
			if !projectGitUnborn(ctx, root) {
				return nil, errors.New("cannot verify unborn Git branch")
			}
			cmd = append(cmd, "rm", "--cached", "--force", "-r", "--ignore-unmatch", "--")
		}
		cmd = append(cmd, paths...)
	case "commit":
		message := text(args, "message")
		if strings.TrimSpace(message) == "" || strings.ContainsRune(message, 0) {
			return nil, errors.New("commit message is required")
		}
		cmd = append(cmd, "commit", "--no-gpg-sign", "--cleanup=verbatim", "-m", message)
	case "branch", "switch":
		branch := text(args, "branch")
		if branch == "" || strings.HasPrefix(branch, "-") || strings.HasPrefix(branch, "@") || branch == "HEAD" {
			return nil, errors.New("a literal local branch name is required")
		}
		if _, err := projectGit(ctx, root, "check-ref-format", "refs/heads/"+branch); err != nil {
			return nil, err
		}
		switch {
		case operation == "branch":
			cmd = append(cmd, "branch", "--no-track", "--", branch)
		case args["create"] == true:
			cmd = append(cmd, "switch", "--no-track", "-c", branch, "--")
		default:
			cmd = append(cmd, "switch", "--no-guess", branch, "--")
		}
	case "stash_push":
		cmd = append(cmd, "stash", "push")
		if message, ok := args["message"].(string); ok {
			cmd = append(cmd, "-m", message)
		}
	case "stash_pop":
		cmd = append(cmd, "stash", "pop")
	}
	result, err := projectGit(ctx, root, cmd...)
	if err != nil {
		return nil, err
	}
	return object{"project": project, "operation": operation, "text": result}, nil
}

func projectState(ctx context.Context, project object) (object, error) {
	root := text(project, "root")
	empty := func() object {
		return object{"project": project["id"], "root": root, "git": false, "sha": nil, "statusHash": nil, "observedAt": now()}
	}
	objects, err := os.Stat(filepath.Join(root, "objects"))
	if !projectGitMarker(root) && !(skillFile(filepath.Join(root, "HEAD")) && err == nil && objects.IsDir()) {
		return empty(), nil
	}
	if _, err := projectGit(ctx, root, "rev-parse", "--git-dir"); err != nil {
		if err.Error() == "NOT_GIT_REPOSITORY" {
			return empty(), nil
		}
		return nil, err
	}
	var sha any
	if value, err := projectGit(ctx, root, "rev-parse", "--verify", "HEAD"); err == nil {
		sha = strings.TrimSpace(value)
	} else if !projectGitUnborn(ctx, root) {
		return nil, err
	}
	branch, err := projectGit(ctx, root, "branch", "--show-current")
	if err != nil {
		return nil, err
	}
	raw, err := projectGit(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all")
	if err != nil {
		return nil, err
	}
	parts := strings.Split(raw, "\x00")
	changes := []any{}
	count := 0
	for i := 0; i < len(parts); i++ {
		row := parts[i]
		if len(row) < 3 {
			continue
		}
		code, path := row[:2], row[3:]
		var original any
		if strings.ContainsAny(code, "RC") && i+1 < len(parts) {
			i++
			original = parts[i]
		}
		count++
		if len(changes) < 200 {
			changes = append(changes, object{"status": code, "path": path, "originalPath": original})
		}
	}
	return object{"project": project["id"], "root": root, "git": true, "sha": sha, "branch": strings.TrimSpace(branch), "dirty": raw != "",
		"statusHash": hash([]byte(raw)), "changesTruncated": count > 200, "changes": changes, "observedAt": now()}, nil
}

func projectFiles(ctx context.Context, root, prefix string, ignored bool, treeDepth *int) ([]string, bool, error) {
	args := []string{"ls-files", "--cached", "--others", "-z"}
	if !ignored {
		args = append(args, "--exclude-standard")
	}
	data, err := projectGit(ctx, root, args...)
	truncated := false
	set := map[string]bool{}
	if err == nil {
		for name := range strings.SplitSeq(data, "\x00") {
			if name != "" {
				set[name] = true
			}
		}
	} else if err.Error() == "NOT_GIT_REPOSITORY" {
		if treeDepth != nil {
			remaining := 10000
			dir := projectPath(root, prefix)
			truncated, err = walkProjectFiles(ctx, root, dir, treeDepth, &remaining, set)
			if err != nil {
				return nil, false, err
			}
			if truncated {
				clear(set)
				remaining = 10000
				shallow := 1
				if _, err := walkProjectFiles(ctx, root, dir, &shallow, &remaining, set); err != nil {
					return nil, false, err
				}
			}
		} else if _, err := walkProjectFiles(ctx, root, root, nil, nil, set); err != nil {
			return nil, false, err
		}
	} else {
		return nil, false, err
	}
	result := make([]string, 0, len(set))
	for name := range set {
		if prefix == "" || name == prefix || strings.HasPrefix(name, prefix+"/") {
			result = append(result, name)
		}
	}
	slices.Sort(result)
	return result, truncated, nil
}

func walkProjectFiles(ctx context.Context, root, dir string, depth, remaining *int, set map[string]bool) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if err := checkProtectedPath(dir); err != nil {
		return false, err
	}
	rows, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if remaining != nil {
			if *remaining == 0 {
				return true, nil
			}
			*remaining--
		}
		path := filepath.Join(dir, row.Name())
		name, err := filepath.Rel(root, path)
		if err != nil {
			return false, err
		}
		name = strings.ReplaceAll(name, "\\", "/")
		if row.IsDir() {
			if depth == nil {
				if _, err := walkProjectFiles(ctx, root, path, nil, nil, set); err != nil {
					return false, err
				}
			} else {
				set[name+"/"] = true
				if *depth > 1 {
					next := *depth - 1
					if cut, err := walkProjectFiles(ctx, root, path, &next, remaining, set); cut || err != nil {
						return cut, err
					}
				}
			}
		} else {
			set[name] = true
		}
		if len(set) > 100000 {
			return false, errors.New("Directory is too large. Narrow the scope.")
		}
	}
	return false, nil
}

func projectIOReason(err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return errors.New("NOT_FOUND")
	case errors.Is(err, os.ErrPermission):
		return errors.New("PERMISSION_DENIED")
	default:
		return errors.New("READ_ERROR")
	}
}

func projectReadBytes(root, name string) ([]byte, error) {
	path := projectPath(root, name)
	if err := checkProtectedPath(path); err != nil {
		return nil, err
	}
	if actual, err := canonicalProjectPath(path); err == nil {
		if err := checkProtectedPath(actual); err != nil {
			return nil, err
		}
	}
	before, err := readStamp(path)
	if err != nil {
		return nil, projectIOReason(err)
	}
	if before == nil {
		return nil, errors.New("NOT_FOUND")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, projectIOReason(err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("NOT_REGULAR_FILE")
	}
	const limit = 16 * 1024 * 1024
	if before.Length > limit {
		return nil, errors.New("FILE_TOO_LARGE")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, projectIOReason(err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, projectIOReason(err)
	}
	if len(data) > limit {
		return nil, errors.New("FILE_TOO_LARGE")
	}
	after, err := readStamp(path)
	if err != nil {
		return nil, projectIOReason(err)
	}
	if after == nil {
		return nil, errors.New("NOT_FOUND")
	}
	if !stampSame(before, after) {
		return nil, errors.New("FILE_CHANGED_DURING_READ")
	}
	return data, nil
}

func reviewProjectPath(workspace, name string) error {
	actual := projectPath(workspace, name)
	if !projectContains(workspace, actual) {
		return errors.New("OUTSIDE_WORKSPACE")
	}
	private, _ := canonicalProjectPath(root())
	for {
		target, err := canonicalProjectPath(actual)
		if err == nil {
			if private != "" && projectContains(private, target) {
				return errors.New("PRIVATE_RUNTIME_STATE")
			}
			if !projectContains(workspace, target) {
				return errors.New("OUTSIDE_WORKSPACE")
			}
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return projectIOReason(err)
		}
		parent := filepath.Dir(actual)
		if parent == actual {
			return errors.New("OUTSIDE_WORKSPACE")
		}
		actual = parent
	}
	if projectParentComponent(name) {
		return errors.New("PARENT_PATH_RESTRICTED")
	}
	return nil
}

func projectFilteredPaths(root string, paths []string, review bool, skips map[string]int) []string {
	if !review {
		return paths
	}
	out := []string{}
	for _, name := range paths {
		if err := reviewProjectPath(root, name); err != nil {
			skips[err.Error()]++
		} else {
			out = append(out, name)
		}
	}
	return out
}

func projectFilteredState(root string, source object, review bool, skips map[string]int) {
	if !review {
		return
	}
	if changes := arr(source["changes"]); changes != nil {
		source["changes"] = slices.DeleteFunc(slices.Clone(changes), func(row any) bool {
			for _, key := range []string{"path", "originalPath"} {
				if name, ok := field(row, key).(string); ok {
					if err := reviewProjectPath(root, name); err != nil {
						skips[err.Error()]++
						return true
					}
				}
			}
			return false
		})
	}
}

func projectRevision(ctx context.Context, root, rev string) (string, error) {
	value, err := projectGit(ctx, root, "rev-parse", "--verify", "--end-of-options", rev+"^{commit}")
	return strings.TrimSpace(value), err
}

func projectMetadata(path string) object {
	info, err := os.Lstat(path)
	if err != nil {
		return object{"error": err.Error()}
	}
	kind := "other"
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		kind = "symlink"
	case info.IsDir():
		kind = "directory"
	case info.Mode().IsRegular():
		kind = "file"
	}
	var created any
	if _, birth := platform.FileIdentity(path, info); !birth.IsZero() {
		created = subscriptionTimestamp(birth)
	}
	return object{"type": kind, "size": info.Size(), "readonly": info.Mode().Perm()&0o222 == 0,
		"modifiedAt": subscriptionTimestamp(info.ModTime()), "createdAt": created}
}

func sortedProjectSet(set map[string]bool) []string {
	list := make([]string, 0, len(set))
	for name := range set {
		list = append(list, name)
	}
	slices.Sort(list)
	return list
}

func projectBound(value any, fallback int) int {
	return int(min(uintOr(value, uint64(fallback)), uint64(int(^uint(0)>>1))))
}

func overviewProject(ctx context.Context, project object, review bool, skips map[string]int) (object, error) {
	root := text(project, "root")
	paths, _, err := projectFiles(ctx, root, "", false, nil)
	if err != nil {
		return nil, err
	}
	paths = projectFilteredPaths(root, paths, review, skips)
	roots := map[string]bool{}
	entries := []string{}
	for _, path := range paths {
		part, _, _ := strings.Cut(path, "/")
		roots[part] = true
		if strings.HasSuffix(path, "README.md") && len(entries) < 31 {
			entries = append(entries, path)
		}
	}
	top := sortedProjectSet(roots)
	return object{"listingHash": hash([]byte(strings.Join(paths, "\x00"))), "truncated": len(top) > 100 || len(entries) > 30,
		"name": project["name"], "topLevel": top[:min(100, len(top))], "documentEntrypoints": entries[:min(30, len(entries))]}, nil
}

func projectTree(ctx context.Context, root, path string, args object, review bool, skips map[string]int) (object, error) {
	prefix := strings.TrimRight(path, "/")
	depth := projectBound(args["depth"], 2)
	paths, truncated, err := projectFiles(ctx, root, prefix, args["includeIgnored"] == true, &depth)
	if err != nil {
		return nil, err
	}
	paths = projectFilteredPaths(root, paths, review, skips)
	actualDepth := depth
	if prefix != "" {
		actualDepth += strings.Count(prefix, "/") + 1
	}
	entries := map[string]bool{}
	for _, name := range paths {
		parts := strings.Split(name, "/")
		if actualDepth < len(parts) {
			name = strings.Join(parts[:actualDepth], "/") + "/"
		}
		entries[name] = true
	}
	rows := sortedProjectSet(entries)
	offset := min(projectBound(args["offset"], 0), len(rows))
	end := offset + min(projectBound(args["limit"], 100), len(rows)-offset)
	selected := rows[offset:end]
	entryMetadata := make([]object, 0, len(selected))
	for _, name := range selected {
		entryMetadata = append(entryMetadata, object{"path": name, "metadata": projectMetadata(projectPath(root, strings.TrimRight(name, "/")))})
	}
	var next any
	if end < len(rows) {
		next = end
	}
	if truncated {
		depth = 1
	}
	return object{"path": path, "truncated": truncated, "depth": depth, "entries": selected, "metadata": projectMetadata(projectPath(root, path)),
		"entryMetadata": entryMetadata, "total": len(rows), "listingHash": hash([]byte(strings.Join(rows, "\x00"))), "nextOffset": next}, nil
}

func recognizableProjectImage(data []byte, path string) bool {
	kind := projectBinaryKind(data, "")
	if slices.Contains([]string{"Png", "Jpeg", "Gif", "WebP"}, kind) {
		return true
	}
	if kind != "" {
		return false
	}
	return slices.Contains([]string{".png", ".jpg", ".jpeg", ".gif", ".webp"}, strings.ToLower(filepath.Ext(path)))
}

func projectBinaryKind(data []byte, path string) string {
	for _, signature := range []struct{ head, kind string }{
		{"\x89PNG\r\n\x1a\n", "Png"}, {"\xff\xd8\xff", "Jpeg"}, {"GIF87a", "Gif"}, {"GIF89a", "Gif"}, {"%PDF-", "pdf"}, {"PK\x03\x04", "zip"},
		{"BM", "Bmp"}, {"II*\x00", "Tiff"}, {"MM\x00*", "Tiff"}, {"\x00\x00\x01\x00", "Ico"},
	} {
		if bytes.HasPrefix(data, []byte(signature.head)) {
			return signature.kind
		}
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return "WebP"
	}
	ext := strings.TrimPrefix(filepath.Ext(path), ".")
	if ext == "" && path != "" {
		return "unknown"
	}
	return ext
}

func projectText(data []byte, path string) (string, error) {
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", fmt.Errorf("BINARY_FILE: type=%s, bytes=%d", projectBinaryKind(data, path), len(data))
	}
	return string(data), nil
}

func projectReadCommitFile(ctx context.Context, root, file, revision string) ([]byte, error) {
	entry, err := projectGit(ctx, root, "ls-tree", revision, "--", file)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(entry, "100644 blob ") && !strings.HasPrefix(entry, "100755 blob ") {
		return nil, errors.New("No readable regular files in this commit")
	}
	fields := strings.Fields(entry)
	if len(fields) < 3 {
		return nil, errors.New("invalid git object")
	}
	oid := fields[2]
	size, err := projectGit(ctx, root, "cat-file", "-s", oid)
	if err != nil {
		return nil, err
	}
	n, err := strconv.ParseUint(strings.TrimSpace(size), 10, 64)
	if err != nil || n > 16*1024*1024 {
		return nil, errors.New("File is too large")
	}
	return projectGitBytes(ctx, root, false, "cat-file", "blob", oid)
}

func projectRead(ctx context.Context, root, file string, args object) (object, []any, error) {
	revision := "working"
	var data []byte
	var err error
	if rev, ok := args["revision"].(string); ok {
		revision, err = projectRevision(ctx, root, rev)
		if err == nil {
			data, err = projectReadCommitFile(ctx, root, file, revision)
		}
	} else {
		data, err = projectReadBytes(root, file)
	}
	if err != nil {
		return nil, nil, err
	}
	if recognizableProjectImage(data, file) {
		return prepareProjectImage(data, file, args)
	}
	content, err := projectText(data, file)
	if err != nil {
		return nil, nil, err
	}
	lines := strings.Split(content, "\n")
	start := max(1, projectBound(args["startLine"], 1))
	count := projectBound(args["lineCount"], 160)
	begin := min(start-1, len(lines))
	end := begin + min(count, len(lines)-begin)
	display := []string{}
	for i, line := range lines[begin:end] {
		display = append(display, fmt.Sprintf("%d: %s", start+i, line))
	}
	var next any
	if end < len(lines) {
		next = end + 1
	}
	return object{"path": file, "revision": revision, "sha256": hash([]byte(content)), "startLine": start,
		"totalLines": len(lines), "nextLine": next, "text": strings.Join(display, "\n"), "truncated": false}, nil, nil
}

func rustProjectLines(content string) []string {
	if content == "" {
		return []string{}
	}
	list := strings.Split(content, "\n")
	if list[len(list)-1] == "" {
		list = list[:len(list)-1]
	}
	for i := range list {
		if i+1 < len(list) || strings.HasSuffix(content, "\n") {
			list[i] = strings.TrimSuffix(list[i], "\r")
		}
	}
	return list
}

func projectSearch(ctx context.Context, root, file string, args object, review bool, skips map[string]int) (object, error) {
	paths, _, err := projectFiles(ctx, root, file, args["includeIgnored"] == true, nil)
	if err != nil {
		return nil, err
	}
	paths = projectFilteredPaths(root, paths, review, skips)
	query := text(args, "query")
	sensitive := args["caseSensitive"] == true
	if !sensitive {
		query = lowerProviderText(query)
	}
	contains := func(value string) bool {
		if !sensitive {
			value = lowerProviderText(value)
		}
		return strings.Contains(value, query)
	}
	results := []any{}
	index, limit := projectBound(args["offset"], 0), projectBound(args["limit"], 30)
	bytes, scanned, skipped := 0, 0, 0
	for index < len(paths) && len(results) < limit && scanned < 1500 && bytes < 256*1024*1024 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path := paths[index]
		index++
		data, err := projectReadBytes(root, path)
		var content string
		if err == nil {
			content, err = projectText(data, path)
		}
		if err != nil {
			skipped++
			skips[err.Error()]++
			continue
		}
		bytes += len(content)
		scanned++
		count, complete := 0, true
		matches := []any{}
		for i, line := range rustProjectLines(content) {
			if !contains(line) {
				continue
			}
			count++
			if count <= 5 {
				matches = append(matches, object{"line": i + 1, "text": projectRunePrefix(line, 500)})
			}
			complete = complete && count <= 5 && utf8.RuneCountInString(line) <= 500
		}
		if count > 0 || contains(path) {
			result := object{"path": path, "matches": matches, "matchesComplete": complete, "totalMatches": count}
			if args["view"] == "full" {
				result["sha256"] = hash([]byte(content))
			}
			results = append(results, result)
		}
	}
	var next any
	if index < len(paths) {
		next = index
	}
	view := "raw"
	if review {
		view = "review"
	}
	return object{"query": args["query"], "results": results, "scanned": scanned, "skipped": skipped, "listingHash": hash([]byte(strings.Join(paths, "\x00"))),
		"nextOffset": next, "readNext": object{"via": "query", "op": "read", "args": object{"project": args["project"], "path": "<result.path>", "view": view}}}, nil
}

func projectNonemptyFields(raw, separator string) []string {
	fields := strings.Split(raw, separator)
	return slices.DeleteFunc(fields, func(s string) bool { return s == "" })
}

func projectGitShow(ctx context.Context, root string, args object, review bool, skips map[string]int) (object, error) {
	revision := "HEAD"
	if value, ok := args["revision"].(string); ok {
		revision = value
	}
	rev, err := projectRevision(ctx, root, revision)
	if err != nil {
		return nil, err
	}
	raw, err := projectGit(ctx, root, "diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", rev)
	if err != nil {
		return nil, err
	}
	paths := projectFilteredPaths(root, projectNonemptyFields(raw, "\x00"), review, skips)
	metadata, err := projectGit(ctx, root, "show", "-s", "--format=%H%n%cs%n%s", rev)
	if err != nil {
		return nil, err
	}
	hidden := 0
	for _, n := range skips {
		hidden += n
	}
	return object{"revision": rev, "text": metadata, "truncated": false, "paths": paths[:min(200, len(paths))], "truncatedPaths": len(paths) > 200, "hiddenPaths": hidden}, nil
}

func projectGitDiffCommand(ctx context.Context, root string, args object) ([]string, error) {
	_, revision := args["revision"].(string)
	if _, base := args["baseRevision"].(string); base && !revision {
		return nil, errors.New("baseRevision requires revision")
	}
	staged := args["staged"] == true
	if staged && revision {
		return nil, errors.New("staged cannot be combined with revision")
	}
	cmd := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--unified=3"}
	if staged {
		cmd = append(cmd, "--cached")
	}
	for _, name := range []string{"baseRevision", "revision"} {
		if value, ok := args[name].(string); ok {
			rev, err := projectRevision(ctx, root, value)
			if err != nil {
				return nil, err
			}
			cmd = append(cmd, rev)
		}
	}
	return cmd, nil
}

func projectReviewDiffPaths(ctx context.Context, root, file string, cmd []string, skips map[string]int) ([]string, error) {
	pathArgs := slices.Clone(cmd[:slices.Index(cmd, "--")+1])
	pathArgs = slices.DeleteFunc(pathArgs, func(arg string) bool { return arg == "--no-renames" })
	pathArgs = slices.Insert(pathArgs, 1, "--name-status", "-z", "--find-renames")
	raw, err := projectGit(ctx, root, pathArgs...)
	if err != nil {
		return nil, err
	}
	fields := projectNonemptyFields(raw, "\x00")
	safe := []string{}
	for i := 0; i < len(fields); {
		width := 2
		if strings.HasPrefix(fields[i], "R") || strings.HasPrefix(fields[i], "C") {
			width = 3
		}
		if i+width > len(fields) {
			return nil, errors.New("INVALID_GIT_PATH_METADATA")
		}
		pair := fields[i+1 : i+width]
		allowed := projectFilteredPaths(root, pair, true, skips)
		if len(allowed) == len(pair) {
			for _, path := range pair {
				if file == "" || path == file || strings.HasPrefix(path, file+"/") {
					safe = append(safe, path)
				}
			}
		}
		i += width
	}
	return safe, nil
}

func projectDiffStats(ctx context.Context, root string, cmd []string, data object) error {
	patch := text(data, "text")
	if len(patch) <= 12000 {
		return nil
	}
	cmd = slices.DeleteFunc(slices.Clone(cmd), func(a string) bool { return a == "--unified=3" })
	cmd = slices.Insert(cmd, 1, "--numstat", "-z")
	stats, err := projectGit(ctx, root, cmd...)
	if err != nil {
		return err
	}
	files := []any{}
	for _, row := range projectNonemptyFields(stats, "\x00") {
		fields := strings.SplitN(row, "\t", 3)
		if len(fields) != 3 {
			continue
		}
		count := func(raw string) any {
			if value, err := strconv.ParseUint(raw, 10, 64); err == nil {
				return value
			}
			return nil
		}
		files = append(files, object{"path": fields[2], "added": count(fields[0]), "removed": count(fields[1]), "binary": fields[0] == "-"})
	}
	paged, err := pageOutput(object{"text": patch, "files": files}, 12000)
	if err != nil {
		return err
	}
	end := 12000
	for !utf8.RuneStart(patch[end]) {
		end--
	}
	data["text"], data["truncated"], data["files"] = patch[:end], true, files[:min(50, len(files))]
	if paths, ok := data["paths"].([]string); ok {
		data["paths"], data["truncatedPaths"] = paths[:min(50, len(paths))], len(paths) > 50
	}
	data["filesTotal"], data["filesTruncated"] = len(files), len(files) > 50
	data["output"] = object{"outputId": field(paged, "outputId"), "offset": 0, "nextAction": "control_output", "format": "JSON with complete diff and file statistics"}
	return nil
}

func projectGitQuery(ctx context.Context, root, file string, args object, review bool, skips map[string]int) (object, error) {
	var cmd []string
	var err error
	switch args["operation"] {
	case "show":
		return projectGitShow(ctx, root, args, review, skips)
	case "log":
		rev := "HEAD"
		if value, ok := args["revision"].(string); ok {
			rev = value
		}
		commit, err := projectRevision(ctx, root, rev)
		if err != nil {
			return nil, err
		}
		cmd = []string{"log", fmt.Sprintf("-%d", projectBound(args["limit"], 10)), "--format=%H %cs %s", commit}
	case "diff":
		cmd, err = projectGitDiffCommand(ctx, root, args)
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("Unknown Git query")
	}
	cmd = append(cmd, "--")
	if file != "" {
		cmd = append(cmd, file)
	}
	data := object{"truncated": false}
	if args["operation"] == "diff" && review {
		safe, err := projectReviewDiffPaths(ctx, root, file, cmd, skips)
		if err != nil {
			return nil, err
		}
		data["paths"] = safe
		if len(safe) == 0 {
			data["text"] = ""
			return data, nil
		}
		cmd = append(cmd[:slices.Index(cmd, "--")+1], safe...)
	}
	result, err := projectGit(ctx, root, cmd...)
	if err != nil {
		return nil, err
	}
	data["text"] = result
	if args["operation"] == "diff" {
		if err := projectDiffStats(ctx, root, cmd, data); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func queryProject(ctx context.Context, s *service, action string, args object) (object, error) {
	if _, path := args["path"]; action == "git" && args["operation"] == "show" && path {
		return nil, errors.New(wire(invalidArguments("git", "path", "git show returns commit metadata and does not accept path. Use git operation:diff with baseRevision:<commit>^, revision:<commit> and path to read a file's commit diff.")))
	}
	requestedPath := text(args, "path")
	_, revision := args["revision"]
	_, hasProject := args["project"]
	if (action == "read" || action == "tree" || action == "search") && filepath.IsAbs(requestedPath) && !revision && (action != "read" || !hasProject) {
		if _, project := args["project"].(string); project && args["view"] == "review" {
			original, err := resolveProjectArgs(ctx, s, args)
			if err != nil {
				return nil, err
			}
			if err := reviewProjectPath(text(original, "root"), requestedPath); err != nil {
				return nil, err
			}
		}
		args = maps.Clone(args)
		if action == "read" {
			name := projectBase(requestedPath)
			if name == "" {
				return nil, errors.New("INVALID_PATH")
			}
			args["project"], args["path"] = filepath.Dir(requestedPath), name
		} else {
			args["project"], args["path"] = requestedPath, ""
		}
	}
	project, err := resolveProjectArgs(ctx, s, args)
	if err != nil {
		return nil, err
	}
	root := text(project, "root")
	started := now()
	review, includeSource := args["view"] == "review", args["includeSource"] == true
	if review {
		if err := reviewProjectPath(root, ""); err != nil {
			return nil, err
		}
	}
	status := action == "git" && args["operation"] == "status"
	var source object
	if includeSource || status {
		source, err = projectState(ctx, project)
		if err != nil {
			if status {
				return nil, err
			}
			source = object{"error": err.Error()}
		}
	}
	skips, sourceSkips := map[string]int{}, map[string]int{}
	projectFilteredState(root, source, review, sourceSkips)
	file := text(args, "path")
	if strings.ContainsRune(file, 0) {
		return nil, errors.New("invalid path")
	}
	if review && file != "" {
		if err := reviewProjectPath(root, file); err != nil {
			return nil, err
		}
	}
	var data object
	var images []any
	switch action {
	case "overview":
		data, err = overviewProject(ctx, project, review, skips)
	case "tree":
		data, err = projectTree(ctx, root, file, args, review, skips)
	case "read":
		data, images, err = projectRead(ctx, root, file, args)
	case "search":
		data, err = projectSearch(ctx, root, file, args, review, skips)
	case "git":
		if status {
			data, skips = clone(source), maps.Clone(sourceSkips)
		} else {
			data, err = projectGitQuery(ctx, root, file, args, review, skips)
		}
	default:
		return nil, errors.New("Unknown project query")
	}
	if err != nil {
		return nil, err
	}
	if action == "read" && args["revision"] == nil {
		data["metadata"] = projectMetadata(projectPath(root, file))
	}
	if (action == "read" || action == "tree") && filepath.IsAbs(requestedPath) {
		data["path"] = requestedPath
	}
	if includeSource {
		paged := data["nextLine"] != nil || data["nextOffset"] != nil
		partialSnippets := slices.ContainsFunc(arr(data["results"]), func(result any) bool { return field(result, "matchesComplete") == false })
		coverage, sourceCoverage := "complete", "complete"
		if paged || partialSnippets || len(skips) > 0 || data["changesTruncated"] == true || data["truncatedPaths"] == true || data["truncated"] == true || data["state"] == "restricted" {
			coverage = "partial"
		}
		if source["changesTruncated"] == true || len(sourceSkips) > 0 {
			sourceCoverage = "partial"
		}
		data["coverage"] = object{"state": coverage, "paged": paged, "snippetsComplete": !partialSnippets, "skippedByReason": skips}
		view := "raw"
		if review {
			view = "review"
		}
		source["consistency"], source["statusHashScope"], source["observationStartedAt"], source["observationEndedAt"], source["view"] = "best-effort", "git-status-text-not-workspace-content", started, now(), view
		source["coverage"] = object{"state": sourceCoverage, "skippedByReason": sourceSkips}
	}
	if expected, ok := args["expectedHash"].(string); ok {
		actual := data["listingHash"]
		if action == "read" {
			actual = data["sha256"]
		}
		if actual != expected {
			return nil, errors.New("CONTENT_CHANGED_RESTART_PAGINATION")
		}
	}
	result := object{"data": data}
	if includeSource {
		result["source"] = source
	}
	if len(images) > 0 {
		result["_connectorImageContent"] = images
	}
	return result, nil
}

func init() {
	resolveContextProject = func(ctx context.Context, s *service, reference string) (object, error) {
		return resolveProjectRoot(ctx, s, reference, nil, false, nil)
	}
	readContextWorkspace = func(ctx context.Context, s *service, args object) (object, error) {
		return queryProject(ctx, s, "git", args)
	}
	registerServiceStartup(func(_ context.Context, s *service) error {
		s.cleanup = append(s.cleanup, func() { projectCatalogs.Delete(s) })
		return nil
	})
	registerOperation("projects", func(ctx context.Context, request operationRequest) (any, error) {
		projects, err := listNativeProjects(ctx, projectClient(request.service))
		if err != nil {
			return nil, err
		}
		return object{"observedAt": now(), "source": "codex-app-server:project/list", "projects": projects}, nil
	}, nil)
	for _, action := range []string{"overview", "tree", "search", "read", "git"} {
		registerOperation(action, func(ctx context.Context, request operationRequest) (any, error) {
			result, err := queryProject(ctx, request.service, action, request.args)
			if err != nil {
				return nil, err
			}
			if action == "overview" {
				permissions, err := request.service.management(ctx, "permissions", "GET", object{})
				if err != nil {
					return nil, err
				}
				result["permissions"] = permissions
			}
			return result, nil
		}, nil)
	}
	registerOperation("git_write", func(ctx context.Context, request operationRequest) (any, error) {
		return runControlMutation(ctx, request, "git_write", request.args, func(ctx context.Context, row object) (any, error) {
			row["submissionStage"] = "submitting"
			if err := coreReceiptStore().checkpoint(ctx, row); err != nil {
				return nil, err
			}
			return projectGitWrite(ctx, request.service, obj(row["arguments"]))
		})
	}, nil)
}
