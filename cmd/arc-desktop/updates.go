package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

// The build supplies the same public key as MyGo, to verify the download
// before the renderer offers restart. No updater is enabled in development.
var updatePublicKey string
var updateBase = "https://github.com/whzxc/agent-remote-control/releases/latest/download/"

type updateState struct {
	sync.Mutex
	next   int
	offers map[int]*updateOffer
	guard  io.Closer
}

type updateOffer struct {
	update *mygo.Update
	source *updateSource
}

type updateSource struct {
	client    *http.Client
	manifest  []byte
	raw       object
	url       string
	size      int64
	signature string
	cached    string
}

type updateProgress struct {
	RID        int   `json:"rid"`
	Total      int64 `json:"total"`
	Downloaded int64 `json:"downloaded"`
}

var UpdateDownloadEvent = mygo.NewEvent[updateProgress]("arc:update-download")

func (s *DesktopService) checkUpdate(ctx context.Context) (any, error) {
	if (bundleID != productionID && !isUpdateFixture()) || !mygo.Updater.Enabled() {
		return nil, nil
	}
	if _, err := updaterKey(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	client, err := s.core.UpdateHTTPClient(ctx)
	if err != nil {
		return nil, err
	}
	source := &updateSource{client: client}
	name := "update-" + runtime.GOOS + "-" + runtime.GOARCH + ".json"
	reader, err := source.fetch(ctx, strings.TrimRight(updateBase, "/")+"/"+name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer reader.Close()
	manifest, err := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(manifest) > 1<<20 {
		return nil, errors.New("mygo: checking for updates: manifest exceeds 1 MiB")
	}
	var fields struct {
		URL       string
		Size      int64
		Signature string
	}
	if err := json.Unmarshal(manifest, &fields); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(manifest, &source.raw); err != nil {
		return nil, err
	}
	source.url, source.size, source.signature = fields.URL, fields.Size, fields.Signature
	// Download the signed full archive once. Install uses those same bytes after
	// AC power/network changes or while the Core proxy owner is being replaced.
	installManifest := make(map[string]json.RawMessage)
	if err := json.Unmarshal(manifest, &installManifest); err != nil {
		return nil, err
	}
	delete(installManifest, "deltas")
	source.manifest, err = json.Marshal(installManifest)
	if err != nil {
		return nil, err
	}
	s.updates.Lock()
	defer s.updates.Unlock()
	mygo.Updater.SetSource(source)
	update, err := mygo.Updater.Check(ctx)
	mygo.Updater.SetSource(nil)
	if err != nil || update == nil {
		return nil, err
	}
	if s.updates.offers == nil {
		s.updates.offers = make(map[int]*updateOffer)
	}
	s.updates.next++
	rid := s.updates.next
	s.updates.offers[rid] = &updateOffer{update, source}
	var date, notes any
	if !update.Date.IsZero() {
		date = update.Date.Format(time.RFC3339)
	}
	if _, exists := source.raw["notes"]; exists {
		notes = update.Notes
	}
	return object{"rid": rid, "currentVersion": core.DesktopVersion(), "version": update.Version, "date": date, "body": notes, "rawJson": source.raw}, nil
}

func (s *updateSource) Manifest(context.Context, bool) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(s.manifest)), nil
}

func (s *updateSource) Open(_ context.Context, target string) (io.ReadCloser, error) {
	if target != s.url || s.cached == "" {
		return nil, errors.New("Update archive is not ready.")
	}
	return os.Open(s.cached)
}

func (s *updateSource) fetch(ctx context.Context, target string) (io.ReadCloser, error) {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "https" && !updateFixtureURL(parsed)) || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("Invalid update URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	client := *s.client
	client.CheckRedirect = func(req *http.Request, previous []*http.Request) error {
		if len(previous) >= 10 || req.URL.Scheme != "https" && !updateFixtureURL(req.URL) {
			return errors.New("Invalid update redirect")
		}
		return nil
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode/100 == 2 {
		return response.Body, nil
	}
	_ = response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, os.ErrNotExist
	}
	return nil, fmt.Errorf("Update server returned %s", response.Status)
}

func updaterKey() (ed25519.PublicKey, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(updatePublicKey))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid update public key")
	}
	return ed25519.PublicKey(key), nil
}

type countingWriter struct {
	writer  io.Writer
	report  func(int64)
	written int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.written += int64(n)
	w.report(w.written)
	return n, err
}

func (s *DesktopService) downloadUpdate(ctx context.Context, window *mygo.Window, rid int) error {
	ctx, cancel := context.WithTimeout(ctx, 360*time.Second)
	defer cancel()
	s.updates.Lock()
	defer s.updates.Unlock()
	offer := s.updates.offers[rid]
	if offer == nil {
		return errors.New("Unknown update")
	}
	source := offer.source
	if source.cached != "" {
		return nil
	}
	if source.size <= 0 || source.size == int64(^uint64(0)>>1) {
		return errors.New("Invalid update archive size")
	}
	body, err := source.fetch(ctx, source.url)
	if err != nil {
		return err
	}
	defer body.Close()
	dir := filepath.Join(core.DesktopStateDir(), "app", "updates")
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, "archive-*")
	if err != nil {
		return err
	}
	defer func() {
		_ = file.Close()
		if source.cached == "" {
			_ = os.Remove(file.Name())
		}
	}()
	digest := sha256.New()
	last := time.Time{}
	counter := &countingWriter{writer: io.MultiWriter(file, digest), report: func(written int64) {
		if time.Since(last) >= 100*time.Millisecond || written == source.size {
			last = time.Now()
			_ = UpdateDownloadEvent.Emit(window, updateProgress{rid, source.size, written})
		}
	}}
	if _, err := io.Copy(counter, io.LimitReader(body, source.size+1)); err != nil {
		return err
	}
	if counter.written != source.size {
		return errors.New("Invalid update archive size")
	}
	key, err := updaterKey()
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.DecodeString(source.signature)
	if err != nil || !ed25519.Verify(key, digest.Sum(nil), signature) {
		return errors.New("the update is not signed with the app's key")
	}
	if err := file.Close(); err != nil {
		return err
	}
	source.cached = file.Name()
	return nil
}

func (s *DesktopService) closeUpdate(rid int) error {
	s.updates.Lock()
	defer s.updates.Unlock()
	offer := s.updates.offers[rid]
	if offer == nil {
		return nil
	}
	delete(s.updates.offers, rid)
	if path := offer.source.cached; path != "" {
		return os.Remove(path)
	}
	return nil
}

func (s *DesktopService) installUpdate(ctx context.Context, rid int) error {
	s.updates.Lock()
	defer s.updates.Unlock()
	offer := s.updates.offers[rid]
	if offer == nil || offer.source.cached == "" {
		return errors.New("Update archive is not ready.")
	}
	if s.closing.Swap(true) {
		return errors.New("The app is already shutting down.")
	}
	wait, cancel := context.WithTimeout(context.WithoutCancel(ctx), 120*time.Second)
	defer cancel()
	err := s.core.Shutdown(wait)
	if err == nil {
		s.updates.guard, err = core.PrepareDesktopUpdate(wait)
	}
	if err == nil {
		err = offer.update.Install(wait, nil)
	}
	if err != nil {
		if s.updates.guard != nil {
			_ = s.updates.guard.Close()
			s.updates.guard = nil
		}
		s.core.Resume()
		s.closing.Store(false)
		return err
	}
	mygo.App.Relaunch()
	return nil
}

func (s *DesktopService) cleanUpdates() {
	s.updates.Lock()
	defer s.updates.Unlock()
	for _, offer := range s.updates.offers {
		if path := offer.source.cached; path != "" {
			_ = os.Remove(path)
		}
	}
	// An installed update retains the replacement lock until process exit.
}
