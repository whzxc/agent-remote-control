package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type sourceState struct {
	mutation sync.Mutex
	jobs     sourceJobs
	// AppKit owns the native views and per-store operations.
	views    map[string]*sourceContainer
	clearing map[string]*sourceRemoval
	imports  map[string]<-chan struct{}
}

type sourceContainer struct {
	host                   *mygo.Window
	view                   *nativeSourceView
	store, status, current string
	safari                 bool
	changed                time.Time
}

func sourceMain(ctx context.Context, fn func() error) error {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := onMain(wait, fn)
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("SRC_MAIN_THREAD_TIMEOUT")
	}
	if errors.Is(err, context.Canceled) {
		return errors.New("SRC_MAIN_THREAD_UNAVAILABLE")
	}
	return err
}

func (s *sourceState) checkBarrier(store string) error {
	if s.clearing[store] != nil {
		return errors.New("SRC_STORE_CLEAR_PENDING: Retry src_login_clear to confirm data store removal before opening or importing")
	}
	if done := s.imports[store]; done != nil {
		select {
		case <-done:
			delete(s.imports, store)
		default:
			return errors.New("SRC_IMPORT_BLOCKED: Cookie writes are still pending; wait before retrying")
		}
	}
	return nil
}

func (s *sourceState) create(args object, reset bool) (*sourceContainer, error) {
	account, store := stringAt(args, "accountId"), stringAt(args, "storeId")
	safari := args["safariUserAgent"] == true
	if err := s.checkBarrier(store); err != nil {
		return nil, err
	}
	var host *mygo.Window
	if existing := s.views[account]; existing != nil {
		if existing.store != store {
			return nil, errors.New("SRC_CONTAINER_IDENTITY_CHANGED: Close the account window and retry")
		}
		if !reset {
			if existing.safari != safari {
				return nil, errors.New("SRC_UA_REOPEN_REQUIRED: Close the account window to apply the saved UA setting")
			}
			return existing, nil
		}
		existing.view.close()
		host = existing.host
	} else {
		host = newSourceWindow(stringAt(args, "title"))
		host.OnClosed(func() {
			if existing := s.views[account]; existing != nil && existing.host == host {
				existing.view.close()
				delete(s.views, account)
			}
		})
	}
	view, err := createSourceView(host, store, safari)
	if err != nil {
		host.Destroy()
		return nil, err
	}
	result := &sourceContainer{host: host, view: view, store: store, safari: safari, status: "not-imported", changed: time.Now()}
	s.views[account] = result
	return result, nil
}

func (s *sourceState) navigate(account, url string) (object, error) {
	container := s.views[account]
	if container == nil {
		return nil, errors.New("SRC_WINDOW_CLOSED")
	}
	if err := s.checkBarrier(container.store); err != nil {
		return nil, err
	}
	container.current, container.changed = "", time.Now()
	if err := container.view.navigate(url); err != nil {
		return nil, err
	}
	container.host.Show()
	container.host.Focus()
	return object{"accountId": account, "status": container.status}, nil
}

func (s *sourceState) metadata() object {
	views := make([]object, 0, len(s.views))
	for account, container := range s.views {
		if url := container.view.currentURL(); url != container.current {
			container.current, container.changed = url, time.Now()
		}
		switch {
		case core.DesktopSourceExpired(container.current):
			container.status = "expired"
		case core.DesktopSourceAllowed(container.current) && container.view.finished && time.Since(container.changed) >= 5*time.Second:
			container.status = "signed-in"
		}
		active := container.host.IsFocused() && container.host.IsVisible() && !container.host.IsMinimized()
		views = append(views, object{"accountId": account, "storeId": container.store, "status": container.status,
			"url": core.DesktopSourceReference(container.current), "active": active, "open": true})
	}
	return s.jobs.metadata(views)
}

func (s *DesktopService) installSources() {
	if !core.DesktopSourceSupported() {
		return
	}
	s.sources.views = make(map[string]*sourceContainer)
	s.sources.clearing = make(map[string]*sourceRemoval)
	s.sources.imports = make(map[string]<-chan struct{})
	go func() {
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-tick.C:
				var body object
				err := sourceMain(s.ctx, func() error { body = s.sources.metadata(); return nil })
				if err == nil {
					_, _ = s.core.Request(s.ctx, "src-conversations/observe", http.MethodPost, body)
				}
			}
		}
	}()
}

func (s *DesktopService) sourceRequest(ctx context.Context, route string, args object) (any, error) {
	if !core.DesktopSourceSupported() {
		return object{"status": "unsupported", "profiles": []object{}}, nil
	}
	state := &s.sources
	switch route {
	case "src-containers/status":
		var result object
		err := sourceMain(ctx, func() error { result = state.metadata(); return nil })
		if err != nil {
			return nil, err
		}
		return result, nil
	case "src-containers/profiles":
		profiles, err := chromeProfiles()
		if err != nil {
			return nil, fmt.Errorf("SRC_IMPORT_BLOCKED: %w", err)
		}
		return object{"profiles": profiles}, nil
	}
	if !state.mutation.TryLock() {
		return nil, errors.New("SRC_CONTAINER_BUSY: Another window mutation is in progress; read src_conversations before retrying")
	}
	defer state.mutation.Unlock()
	account, store := stringAt(args, "accountId"), stringAt(args, "storeId")
	if route == "src-containers/clear" {
		return state.clear(ctx, account, store)
	}
	url := core.DesktopSourceOpenURL(stringAt(args, "url"))
	if url == "" {
		return nil, errors.New("SRC_URL_INVALID")
	}
	if running := state.jobs.inFlight(account); running != nil {
		return running, nil
	}
	if route == "src-containers/import" {
		if err := chromeProfileExists(stringAt(args, "profile")); err != nil {
			return nil, fmt.Errorf("SRC_IMPORT_BLOCKED: %w", err)
		}
		return state.jobs.start(s.ctx, account, store, func(ctx context.Context) (object, error) {
			return state.performImport(ctx, args)
		}), nil
	}
	var result object
	err := sourceMain(ctx, func() error {
		if _, err := state.create(args, false); err != nil {
			return err
		}
		var err error
		result, err = state.navigate(account, url)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *sourceState) clear(ctx context.Context, account, store string) (any, error) {
	if s.jobs.inFlight(account) != nil {
		return nil, errors.New("SRC_CONTAINER_BUSY: Wait for the in-flight import to finish before clearing its data store")
	}
	var removal *sourceRemoval
	err := sourceMain(ctx, func() error {
		if pending := s.clearing[store]; pending != nil {
			select {
			case <-pending.done:
				if pending.err == nil {
					removal = pending
					return nil
				}
				delete(s.clearing, store)
			default:
				removal = pending
				return nil
			}
		}
		if err := s.checkBarrier(store); err != nil {
			return err
		}
		if container := s.views[account]; container != nil {
			if container.store != store {
				return errors.New("SRC_CONTAINER_IDENTITY_CHANGED: Close the account window and retry")
			}
			container.view.close()
			container.host.Destroy()
		}
		var err error
		removal, err = removeSourceStore(store)
		if err == nil {
			s.clearing[store] = removal
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	select {
	case <-removal.done:
		if removal.err != nil {
			return nil, removal.err
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		return nil, errors.New("SRC_STORE_CLEAR_TIMEOUT: Native website data removal is unconfirmed; retry clear before importing")
	}
	if err := sourceMain(ctx, func() error { delete(s.clearing, store); return nil }); err != nil {
		return nil, err
	}
	s.jobs.forget(account)
	return object{"accountId": account, "status": "not-imported"}, nil
}

func (s *sourceState) performImport(ctx context.Context, args object) (object, error) {
	account, store := stringAt(args, "accountId"), stringAt(args, "storeId")
	if err := sourceMain(ctx, func() error { return s.checkBarrier(store) }); err != nil {
		return nil, err
	}
	cookies, err := importChrome(ctx, stringAt(args, "profile"))
	if err != nil {
		return nil, err
	}
	defer clearChromeRows(cookies)
	guard, err := core.DesktopSourceImportGuard(account, lastActiveOrg(cookies), args["knownAccounts"], args["allowUnverified"] == true)
	if guard != nil || err != nil {
		return guard, err
	}
	var done <-chan struct{}
	err = sourceMain(ctx, func() error {
		container, err := s.create(args, true)
		if err != nil {
			return err
		}
		done, err = container.view.installCookies(cookies)
		if err == nil {
			s.imports[store] = done
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	select {
	case <-done:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		return nil, errors.New("cookie-write-timeout")
	}
	err = sourceMain(ctx, func() error {
		_, err := s.navigate(account, stringAt(args, "url"))
		return err
	})
	if err != nil {
		return nil, err
	}
	return core.DesktopSourceImportState(account, false, len(cookies) > 0, nil), nil
}
