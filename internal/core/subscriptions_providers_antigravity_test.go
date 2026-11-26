package core

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveAntigravityDaemonQuotaProtocol(t *testing.T) {
	// Contract: Antigravity quota reads discover only live local daemon records and use the daemon's authenticated wire protocol.
	home := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("x-codeium-csrf-token") != "live-token" || r.Header.Get("Connect-Protocol-Version") != "1" {
			http.Error(w, "invalid daemon request", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/GetUserStatus") {
			_, _ = w.Write([]byte(`{"userStatus":{"userTier":{"name":"Fixture Plan"}}}`))
		} else if strings.HasSuffix(r.URL.Path, "/RetrieveUserQuotaSummary") {
			_, _ = w.Write([]byte(`{"groups":[{"buckets":[
				{"bucketId":"gemini-weekly","remainingFraction":0.75},{"bucketId":"gemini-5h","remainingFraction":0.75},
				{"bucketId":"3p-weekly","remainingFraction":0.75},{"bucketId":"3p-5h","remainingFraction":0.75}
			]}]}`))
		} else {
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	dead := filepath.Join(home, ".gemini/antigravity/daemon/dead.json")
	live := filepath.Join(home, ".gemini/antigravity-cli/daemon/live.json")
	if err := save(dead, object{"pid": 2147483647, "httpPort": port, "csrfToken": "dead-token"}); err != nil {
		t.Fatal(err)
	}
	if err := save(live, object{"pid": os.Getpid(), "httpPort": port, "httpsPort": port, "csrfToken": "live-token"}); err != nil {
		t.Fatal(err)
	}
	endpoints := antigravityQuotaEndpoints(home)
	if len(endpoints) != 2 || endpoints[0].scheme != "http" || endpoints[1].scheme != "https" || endpoints[0].csrf != "live-token" || endpoints[1].csrf != "live-token" {
		t.Fatalf("unexpected discovered endpoints: %v", endpoints)
	}
	client := server.Client()
	client.Timeout = 2 * time.Second
	reading, failure := queryAntigravitySubscription(t.Context(), client, endpoints)
	if failure != nil || text(reading.rawUsage, "plan") != "Fixture Plan" || len(reading.windows) != 4 {
		t.Fatalf("unexpected quota result: %v %v", reading, failure)
	}
	for _, window := range reading.windows {
		if window.UsedPercent != 25 {
			t.Errorf("unexpected used percent: %v", window)
		}
	}
	if _, failure := queryAntigravitySubscription(t.Context(), client, nil); failure == nil || failure.Code != "client-not-running" {
		t.Fatalf("unexpected stopped client result: %v", failure)
	}
}
