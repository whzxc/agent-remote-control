package main

import (
	"context"
	"maps"
	"slices"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/core"
)

type importJob struct {
	store string
	state object
}

type sourceJobs struct {
	mu   sync.Mutex
	jobs map[string]*importJob
}

func (j *sourceJobs) inFlight(account string) object {
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[account]
	if job != nil && job.state["status"] == "importing" {
		return maps.Clone(job.state)
	}
	return nil
}

func (j *sourceJobs) start(ctx context.Context, account, store string, worker func(context.Context) (object, error)) object {
	j.mu.Lock()
	defer j.mu.Unlock()
	if job := j.jobs[account]; job != nil && job.state["status"] == "importing" {
		return maps.Clone(job.state)
	}
	if j.jobs == nil {
		j.jobs = make(map[string]*importJob)
	}
	job := &importJob{store, core.DesktopSourceImportState(account, true, false, nil)}
	j.jobs[account] = job
	go func() {
		state, err := worker(ctx)
		if err != nil {
			state = core.DesktopSourceImportState(account, false, false, err)
		}
		j.mu.Lock()
		defer j.mu.Unlock()
		job.state = state
	}()
	return maps.Clone(job.state)
}

func (j *sourceJobs) forget(account string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.jobs, account)
}

func (j *sourceJobs) metadata(views []object) object {
	j.mu.Lock()
	defer j.mu.Unlock()
	byAccount := map[string]object{}
	for _, row := range views {
		byAccount[stringAt(row, "accountId")] = maps.Clone(row)
	}
	for account, job := range j.jobs {
		row := byAccount[account]
		status := stringAt(job.state, "status")
		if (status == "signed-in-pending" || status == "not-imported") &&
			(row["status"] == "signed-in" || row["status"] == "expired") {
			delete(j.jobs, account)
			continue
		}
		if row == nil {
			row = object{"accountId": account, "storeId": job.store, "open": false, "url": nil, "active": false}
			byAccount[account] = row
		}
		for _, field := range []string{"status", "reason", "hint", "detectedAccountId"} {
			row[field] = job.state[field]
		}
		switch status {
		case "importing", "import-blocked", "import-mismatch", "import-unverified":
			row["url"], row["active"] = nil, false
		}
	}
	result := make([]object, 0, len(byAccount))
	for _, account := range slices.Sorted(maps.Keys(byAccount)) {
		result = append(result, byAccount[account])
	}
	return object{"containers": result}
}
