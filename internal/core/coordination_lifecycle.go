package core

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

var coordinationCommandOrigins struct {
	sync.Mutex
	rows [][2]string
}

func coordinationCommandEnvironment(params, origin object) {
	source, token := text(origin, "sourceId"), ""
	if source != "" {
		coordinationCommandOrigins.Lock()
		for _, row := range coordinationCommandOrigins.rows {
			if row[1] == source {
				token = row[0]
				break
			}
		}
		if token == "" {
			token = id()
			if len(coordinationCommandOrigins.rows) >= 256 {
				coordinationCommandOrigins.rows = slices.Delete(coordinationCommandOrigins.rows, 0, 1)
			}
			coordinationCommandOrigins.rows = append(coordinationCommandOrigins.rows, [2]string{token, source})
		}
		coordinationCommandOrigins.Unlock()
	}
	env := obj(params["env"])
	if env == nil {
		env = object{}
		params["env"] = env
	}
	env["ARC_TOOLING_ORIGIN"], env["ARC_STATE_DIR"] = token, root()
}

func coordinationCommandSource(body object) string {
	token := text(body, "toolingOrigin")
	coordinationCommandOrigins.Lock()
	defer coordinationCommandOrigins.Unlock()
	for _, row := range coordinationCommandOrigins.rows {
		if row[0] == token {
			return row[1]
		}
	}
	return ""
}

type coordinationLifecycleReport struct {
	TransitionID  string  `json:"transitionId"`
	Kind          string  `json:"kind"`
	Repository    string  `json:"repository"`
	Lane          *string `json:"lane"`
	Instance      *string `json:"instance"`
	PID           *uint32 `json:"pid"`
	ExitCode      *int32  `json:"exitCode"`
	ToolingOrigin *string `json:"toolingOrigin"`
}

var coordinationProjectCatalog func(context.Context, *service) ([]object, error)
var coordinationLifecycleAdmission = make(chan struct{}, 1)
var coordinationLifecycleWriter sync.Mutex
var coordinationLifecycleProjector sync.Mutex

func readCoordinationLifecycle(ctx context.Context, id string) (object, error) {
	if !coordinationIdentifier(id) {
		return nil, invalidCoordinationIdentifier()
	}
	path := filepath.Join(root(), "coordination/tooling", id+".json")
	value, err := load(path)
	if err != nil {
		return nil, err
	}
	coordinationLifecycleProjector.Lock()
	err = coordinationProject(ctx, path, obj(value))
	coordinationLifecycleProjector.Unlock()
	if err != nil {
		return nil, err
	}
	list := arr(field(value, "coordinationPending"))
	if len(list) == 0 || arr(field(list[0], "resources")) == nil {
		return nil, errors.New("COORDINATION_STORAGE: invalid lifecycle resources")
	}
	resources := coordinationResourceStrings(field(list[0], "resources"))
	result := bulletinWarnings(ctx, resources, text(value, "initiatingSource"))
	result["transitionId"], result["state"], result["kind"], result["coverage"] = id, "observed", field(list[0], "kind"), "readback-confirmed"
	return result, nil
}

func reportCoordinationLifecycle(ctx context.Context, s *service, body object) (object, error) {
	var report coordinationLifecycleReport
	if err := decodeCoordinationRecord([]byte(wire(body)), &report); err != nil || report.Repository == "" || report.Kind == "" {
		return nil, errors.New("INVALID_ARGUMENT: read coordination.observe local schema")
	}
	if !coordinationIdentifier(report.TransitionID) {
		return nil, invalidCoordinationIdentifier()
	}
	path := filepath.Join(root(), "coordination/tooling", report.TransitionID+".json")
	digest := hash([]byte(wire(body)))
	conflict := errors.New("COORDINATION_TRANSITION_CONFLICT: retain the original tooling report")
	if value, err := load(path); err == nil {
		if field(value, "digest") != digest {
			return nil, conflict
		}
		return readCoordinationLifecycle(ctx, report.TransitionID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	select {
	case coordinationLifecycleAdmission <- struct{}{}:
	default:
		return nil, errors.New("COVERAGE_GAP: local observation busy; retry the same transition")
	}
	deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	type outcome struct {
		resources []string
		err       error
	}
	result := make(chan outcome, 1)
	go func() {
		defer func() { <-coordinationLifecycleAdmission }()
		resources, err := verifyCoordinationLifecycle(deadline, s, report)
		result <- outcome{resources, err}
	}()
	var resources []string
	select {
	case <-deadline.Done():
		return nil, errors.New("COVERAGE_GAP: local reporting deadline exceeded; original tooling operation is unaffected")
	case observed := <-result:
		if observed.err != nil {
			return nil, observed.err
		}
		resources = observed.resources
	}
	if deadline.Err() != nil {
		return nil, errors.New("COVERAGE_GAP: local reporting deadline exceeded; original tooling operation is unaffected")
	}
	input := newCoordinationEvent(report.TransitionID, report.Kind, resources)
	status := "succeeded"
	if report.Kind == "isolated.started" {
		status = "running"
	} else if report.ExitCode != nil && *report.ExitCode != 0 {
		status = "failed"
	}
	input.Origin, input.Status = &coordinationPrincipal{Type: "local-authority"}, &status
	coordinationLifecycleWriter.Lock()
	value, err := load(path)
	switch {
	case err == nil && field(value, "digest") != digest:
		err = conflict
	case errors.Is(err, os.ErrNotExist):
		var source any
		if id := coordinationCommandSource(body); id != "" {
			source = id
		}
		err = coordinationDurable(path, object{"digest": digest, "initiatingSource": source, "coordinationPending": []coordinationEventInput{input}})
	}
	coordinationLifecycleWriter.Unlock()
	if err != nil {
		return nil, err
	}
	return readCoordinationLifecycle(ctx, report.TransitionID)
}

func verifyCoordinationLifecycle(ctx context.Context, service *service, report coordinationLifecycleReport) ([]string, error) {
	projects, err := coordinationProjectCatalog(ctx, service)
	if err != nil {
		return nil, err
	}
	repository, err := filepath.EvalSymlinks(report.Repository)
	if err != nil {
		return nil, errors.New("COVERAGE_GAP: repository unavailable")
	}
	matches := []string{}
	for _, project := range projects {
		if slices.ContainsFunc(arr(project["roots"]), func(root any) bool {
			path, err := filepath.EvalSymlinks(text(root, "path"))
			return err == nil && path == repository
		}) {
			matches = append(matches, text(project, "id"))
		}
	}
	if len(matches) != 1 {
		return nil, errors.New("COVERAGE_GAP: tooling repository needs one registered parent project")
	}
	reader := coordinationRefReader{}
	common, err := reader.common(repository, nil)
	if err != nil {
		return nil, err
	}
	refs, err := reader.refs(common, nil)
	if err != nil {
		return nil, err
	}
	project, err := coordinationResource("project:" + matches[0] + "/main")
	if err != nil {
		return nil, err
	}
	resources := []string{project}
	switch report.Kind {
	case "lane.created", "lane.landed", "lane.removed":
		if report.Lane == nil {
			return nil, errors.New("INVALID_ARGUMENT: lane required")
		}
		lane, err := coordinationResource("lane:" + matches[0] + "/" + *report.Lane)
		if err != nil {
			return nil, err
		}
		resources = append(resources, lane)
		branch := "refs/heads/wt/" + *report.Lane
		worktrees, err := coordinationLocalGit(ctx, report.Repository, "worktree", "list", "--porcelain")
		if err != nil {
			return nil, err
		}
		present := slices.Contains(strings.Split(worktrees, "\n"), "branch "+branch)
		switch {
		case report.Kind == "lane.created" && (!present || refs[branch] == ""):
			return nil, errors.New("COVERAGE_GAP: lane creation readback failed")
		case report.Kind == "lane.removed" && (present || refs[branch] != ""):
			return nil, errors.New("COVERAGE_GAP: lane removal readback failed")
		case report.Kind == "lane.landed":
			if refs[branch] == "" {
				return nil, errors.New("COVERAGE_GAP: lane ref missing")
			}
			if refs["refs/heads/main"] == "" {
				return nil, errors.New("COVERAGE_GAP: main ref missing")
			}
			if _, err := coordinationLocalGit(ctx, report.Repository, "merge-base", "--is-ancestor", refs[branch], refs["refs/heads/main"]); err != nil {
				return nil, errors.New("COVERAGE_GAP: land ancestry unavailable")
			}
		}
	case "isolated.started", "isolated.exited":
		if report.Instance == nil {
			return nil, errors.New("INVALID_ARGUMENT: instance required")
		}
		if !coordinationIdentifier(*report.Instance) {
			return nil, invalidCoordinationIdentifier()
		}
		resources = append(resources, "isolated:"+*report.Instance)
		if report.PID == nil {
			return nil, errors.New("INVALID_ARGUMENT: pid required")
		}
		if *report.PID == 0 || *report.PID > math.MaxInt32 {
			return nil, errors.New("INVALID_ARGUMENT: process ID")
		}
		running, err := coordinationProcessAlive(*report.PID)
		if err != nil {
			return nil, err
		}
		if running != (report.Kind == "isolated.started") {
			return nil, errors.New("COVERAGE_GAP: process lifecycle readback disagrees")
		}
		if report.Kind == "isolated.exited" && report.ExitCode == nil {
			return nil, errors.New("COVERAGE_GAP: exit code unavailable")
		}
	default:
		return nil, errors.New("INVALID_ARGUMENT: only lane and isolated lifecycle observations are supported")
	}
	return resources, nil
}

func init() {
	registerRoute("POST", "coordination/observe", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		return reportCoordinationLifecycle(ctx, s, body)
	})
	registerRoutePattern("GET", `coordination/observations/([^/]+)`, func(ctx context.Context, _ *service, _ object, ids []string) (any, error) {
		return readCoordinationLifecycle(ctx, ids[0])
	})
}
