package core

import (
	"context"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRelayDeploymentDistinguishesMissingWorkers(t *testing.T) {
	// Contract: only the Cloudflare response for a missing Worker permits local removal.
	for _, tc := range []struct {
		status int
		body   object
		absent bool
		fails  bool
	}{
		{http.StatusOK, object{"success": true}, false, false},
		{http.StatusNotFound, object{"success": false, "errors": []any{object{"code": uint64(10007)}}}, true, false},
		{http.StatusNotFound, object{"success": false, "errors": []any{object{"code": uint64(7003)}}}, false, true},
	} {
		got, err := relayWorkerMissingFromResponse(tc.status, tc.body)
		if got != tc.absent || (err != nil) != tc.fails {
			t.Fatalf("status %d, %v: missing=%v error=%v", tc.status, tc.body, got, err)
		}
	}
}

func TestRelayDeploymentAcceptsOnlyExpectedLoginAndWorkerOrigins(t *testing.T) {
	// Algorithmic core: deployment output can contain arbitrary URLs alongside the managed login and Worker URLs.
	if got := relayLoginURL("Visit https://bad.invalid/oauth2/auth https://dash.cloudflare.com/oauth2/auth?state=test"); got != "https://dash.cloudflare.com/oauth2/auth?state=test" {
		t.Fatalf("login URL %q", got)
	}
	if got := relayLoginURL("Visit https://evil.invalid/oauth2/auth"); got != "" {
		t.Fatalf("unexpected login URL %q", got)
	}
	if got := relayDeployedAddress("https://other.team.workers.dev https://arc-relay.team.workers.dev", "arc-relay"); got != "https://arc-relay.team.workers.dev" {
		t.Fatalf("Worker URL %q", got)
	}
	if got := relayDeployedAddress("https://other.team.workers.dev", "arc-relay"); got != "" {
		t.Fatalf("unexpected Worker URL %q", got)
	}
}

func TestRelayToolReapsChildrenAndPreservesLoginErrors(t *testing.T) {
	// Recurring bug class: lifecycle owned deployment subprocess exits, descendant pipes and login cancellation.
	if runtime.GOOS == "windows" {
		t.Skip("fixture shell requires /bin/sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	job := &relayJob{status: object{}}
	run := func(context context.Context, script string, login bool) (string, error) {
		return relayRunTool(context, nativeCommand(context, "/bin/sh", "-c", script), job, login, false)
	}
	out, err := run(ctx, "printf 'stdout\\n'; printf 'stderr\\n' >&2; sleep 10 &", false)
	if err != nil || !strings.Contains(out, "stdout") || !strings.Contains(out, "stderr") {
		t.Fatalf("tool output %q: %v", out, err)
	}
	_, err = run(ctx, "printf '{\"loggedIn\":false}'; exit 1", false)
	if err == nil || err.Error() != relayWranglerLoginRequired {
		t.Fatalf("login requirement: %v", err)
	}
	_, err = run(ctx, "test ! -t 0 && test ! -t 1 || exit 1; printf 'Visit https://dash.cloudflare.com/oauth2/auth?state=test'; echo ' port is already in use' >&2; exit 7", true)
	if err == nil || !strings.Contains(err.Error(), "callback port is already in use") || job.snapshot()["loginUrl"] != "https://dash.cloudflare.com/oauth2/auth?state=test" {
		t.Fatalf("callback conflict: %v, progress %v", err, job.snapshot())
	}
	short, stop := context.WithTimeout(ctx, 30*time.Millisecond)
	defer stop()
	if _, err := run(short, "sleep 10", true); err == nil {
		t.Fatal("silent login survived cancellation")
	}
}
