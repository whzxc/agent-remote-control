package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type subscriptionSlot struct {
	view       subscriptionProviderSnapshot
	generation uint64
	due        time.Time
	failures   uint32
	resetSeen  []string
	cancel     context.CancelFunc
}

type subscriptionResolved struct {
	reading          subscriptionReading
	source, observed string
}

type subscriptionsManager struct {
	mu            sync.Mutex
	claudeMu      sync.Mutex
	worker        sync.WaitGroup
	context       context.Context
	cancel        context.CancelFunc
	settings      subscriptionSettings
	slots         map[string]*subscriptionSlot
	latest        subscriptionSnapshot
	wake          chan struct{}
	permits       chan struct{}
	stopped       bool
	recentProfile string
	recentClaude  subscriptionResolved
}

var subscriptionsManagers sync.Map
var subscriptionAgentInventory func(context.Context, *service, bool) (any, error)

func subscriptionProvider(id string) *subscriptionRegistration {
	index := slices.IndexFunc(subscriptionProviders, func(r subscriptionRegistration) bool { return r.id == id })
	if index < 0 {
		return nil
	}
	return &subscriptionProviders[index]
}

func subscriptionSettingsPath() string { return filepath.Join(root(), "subscriptions/settings.json") }

func parseSubscriptionSettings(value any) (subscriptionSettings, error) {
	settings := defaultSubscriptionSettings()
	obj := obj(value)
	if enabled, ok := obj["enabled"].(bool); ok {
		settings.Enabled = enabled
	} else {
		return settings, errors.New("invalid subscription settings")
	}
	if _, set := obj["refreshMinutes"]; set {
		n, ok := uintValue(obj["refreshMinutes"])
		if !ok {
			return settings, errors.New("invalid subscription settings")
		}
		settings.RefreshMinutes = n
	}
	if providers, set := obj["agentProviders"]; set {
		if canonjson.Unmarshal([]byte(wire(providers)), &settings.AgentProviders) != nil || settings.AgentProviders == nil {
			return settings, errors.New("invalid subscription settings")
		}
	}
	for agent, providers := range settings.AgentProviders {
		if providers == nil {
			return settings, errors.New("invalid subscription settings")
		}
		if strings.TrimSpace(agent) == "" || slices.ContainsFunc(providers, func(id string) bool { return subscriptionProvider(id) == nil }) {
			return settings, errors.New("invalid agent provider association")
		}
	}
	if !slices.Contains([]uint64{1, 3, 5, 10}, settings.RefreshMinutes) {
		return settings, errors.New("invalid subscription refresh interval")
	}
	return settings, nil
}

func subscriptionAgents(settings subscriptionSettings, provider subscriptionRegistration) []string {
	var list []string
	for agent, providers := range settings.AgentProviders {
		if slices.Contains(providers, provider.id) {
			list = append(list, agent)
		}
	}
	slices.Sort(list)
	if _, ok := settings.AgentProviders[provider.agent]; !ok {
		list = append(list, provider.agent)
	}
	if list == nil {
		list = []string{}
	}
	return list
}

func newSubscriptions(parent context.Context) (*subscriptionsManager, error) {
	settings := defaultSubscriptionSettings()
	value, err := load(subscriptionSettingsPath())
	if err == nil {
		settings, err = parseSubscriptionSettings(value)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	manager := &subscriptionsManager{context: ctx, cancel: cancel, settings: settings, slots: map[string]*subscriptionSlot{}, wake: make(chan struct{}, 1), permits: make(chan struct{}, 3)}
	for _, provider := range subscriptionProviders {
		view := subscriptionProviderSnapshot{
			ProviderID: provider.id, AgentID: provider.agent, AgentIDs: subscriptionAgents(settings, provider), Name: provider.name, State: "idle",
			Windows: []quotaWindow{}, BlockedPoolIDs: []string{}, AcceptsKey: provider.acceptsKey,
		}
		if provider.acceptsKey && skillFile(subscriptionCredentialPath(provider.id)) {
			source := "saved-key"
			view.HasCredential, view.CredentialSource = true, &source
		}
		restoreSubscriptionReading(&view)
		view.Eligible = view.ObservedAt != nil
		manager.slots[provider.id] = &subscriptionSlot{view: view, due: time.Now()}
	}
	manager.latest = subscriptionSnapshot{InstanceID: id(), Settings: settings, Providers: []subscriptionProviderSnapshot{}}
	return manager, nil
}

func getSubscriptions(s *service) (*subscriptionsManager, error) {
	if manager, ok := subscriptionsManagers.Load(s); ok {
		return manager.(*subscriptionsManager), nil
	}
	return nil, errors.New("unknown subscription route")
}

func subscriptionProviderInterval(id string, minutes uint64) time.Duration {
	if id == "antigravity" {
		minutes = max(minutes, 10)
	}
	return time.Duration(max(minutes, 1)) * time.Minute
}

func clearSubscriptionReading(view *subscriptionProviderSnapshot) {
	view.Windows, view.BlockedPoolIDs = []quotaWindow{}, []string{}
	view.ObservedAt, view.RawUsage, view.AccountBlocked, view.DisplayWindowID = nil, nil, nil, nil
}

func invalidateSubscription(slot *subscriptionSlot) {
	slot.generation++
	if slot.cancel != nil {
		slot.cancel()
		slot.cancel = nil
	}
	clearSubscriptionReading(&slot.view)
	slot.view.Refreshing, slot.view.State, slot.view.Error = false, "idle", nil
	slot.failures, slot.due, slot.resetSeen = 0, time.Now(), nil
}

func subscriptionReadingAge(observed *string, now time.Time) (time.Duration, bool) {
	if observed == nil {
		return 0, false
	}
	at, err := time.Parse(time.RFC3339Nano, *observed)
	return now.Sub(at), err == nil
}

func expireSubscriptionView(view *subscriptionProviderSnapshot, now time.Time) bool {
	age, valid := subscriptionReadingAge(view.ObservedAt, now)
	if !valid {
		return false
	}
	if view.Error != nil && age >= 24*time.Hour {
		clearSubscriptionReading(view)
		view.State = "unavailable"
		return true
	}
	if age >= 15*time.Minute && view.State == "ready" {
		view.State = "stale"
	}
	return false
}

func applySubscriptionReading(slot *subscriptionSlot, result subscriptionResolved) {
	view := &slot.view
	view.HasCredential, view.CredentialSource, view.Source = true, &result.source, &result.source
	view.Windows, view.RawUsage, view.AccountBlocked, view.BlockedPoolIDs = result.reading.windows, result.reading.rawUsage, result.reading.accountBlocked, result.reading.blockedPoolIDs
	view.ObservedAt, view.State, view.Error = &result.observed, "ready", nil
	slot.failures = 0
	persistSubscriptionReading(*view)
}

func subscriptionWeeklyWindow(windows []quotaWindow, pool string) *string {
	eligible := func(w quotaWindow) bool {
		return slices.Contains([]string{"weekly", "weekly_all", "weekly_scoped", "seven_day", "10080 min", "604800 s"}, w.Label) || strings.HasPrefix(w.Label, "seven_day_")
	}
	if !slices.ContainsFunc(windows, func(w quotaWindow) bool { return eligible(w) && w.PoolID == pool }) {
		pool = ""
		for _, w := range windows {
			if eligible(w) && (pool == "" || w.PoolID < pool) {
				pool = w.PoolID
			}
		}
	}
	var best *quotaWindow
	for _, window := range windows {
		if !eligible(window) || window.PoolID != pool {
			continue
		}
		if best == nil || window.UsedPercent > best.UsedPercent || window.UsedPercent == best.UsedPercent && window.ID < best.ID {
			best = &window
		}
	}
	if best == nil {
		return nil
	}
	return &best.ID
}

func (manager *subscriptionsManager) publishLocked() {
	rows := make([]subscriptionProviderSnapshot, 0, len(subscriptionProviders))
	at := time.Now()
	for _, provider := range subscriptionProviders {
		slot := manager.slots[provider.id]
		view := slot.view
		view.Windows = slices.DeleteFunc(slices.Clone(view.Windows), func(w quotaWindow) bool { return !quotaWindowActive(w, at) })
		view.DisplayWindowID = subscriptionWeeklyWindow(view.Windows, provider.defaultPool)
		rows = append(rows, view)
	}
	if !reflect.DeepEqual(rows, manager.latest.Providers) || !reflect.DeepEqual(manager.settings, manager.latest.Settings) {
		manager.latest.Revision++
		manager.latest.Providers, manager.latest.Settings = rows, manager.settings
	}
}

func (manager *subscriptionsManager) snapshot() (object, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.expireLocked()
	manager.publishLocked()
	var output object
	err := canonjson.Unmarshal([]byte(wire(manager.latest)), &output)
	return output, err
}

func (manager *subscriptionsManager) expireLocked() {
	now := time.Now()
	for id, slot := range manager.slots {
		if expireSubscriptionView(&slot.view, now) {
			removeSubscriptionReading(id)
		}
	}
}

func (manager *subscriptionsManager) notify() {
	select {
	case manager.wake <- struct{}{}:
	default:
	}
}

func (manager *subscriptionsManager) inventory(value any) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, slot := range manager.slots {
		agentFound, eligible := false, false
		standalone := standaloneSubscriptionAvailable(slot.view.ProviderID)
		for _, agent := range arr(field(value, "agents")) {
			if !slices.Contains(slot.view.AgentIDs, text(agent, "agent")) {
				continue
			}
			agentFound = true
			eligible = eligible || field(agent, "enabled") == true && (field(agent, "installed") == true || standalone)
		}
		if !agentFound {
			eligible = standalone
		}
		if eligible == slot.view.Eligible {
			continue
		}
		slot.view.Eligible = eligible
		invalidateSubscription(slot)
		if eligible {
			restoreSubscriptionReading(&slot.view)
		} else {
			removeSubscriptionReading(slot.view.ProviderID)
		}
	}
	manager.publishLocked()
}

func (manager *subscriptionsManager) run(s *service) {
	var inventoryDue time.Time
	for manager.context.Err() == nil {
		now := time.Now()
		if subscriptionAgentInventory != nil {
			full := !now.Before(inventoryDue)
			if inventory, err := subscriptionAgentInventory(manager.context, s, full); err == nil && inventory != nil {
				manager.inventory(inventory)
			}
			if full {
				inventoryDue = time.Now().Add(180 * time.Second)
			}
		} else if !now.Before(inventoryDue) {
			// Cached readings stay eligible until the native inventory takes ownership.
			if !runtimeFixture {
				manager.inventory(nil)
			}
			inventoryDue = time.Now().Add(180 * time.Second)
		}
		manager.mu.Lock()
		manager.expireLocked()
		enabled := manager.settings.Enabled
		for _, slot := range manager.slots {
			if !enabled || !slot.view.Eligible || slot.cancel != nil {
				continue
			}
			for _, window := range slot.view.Windows {
				if window.ResetsAt == nil || slices.Contains(slot.resetSeen, *window.ResetsAt) {
					continue
				}
				if reset, err := time.Parse(time.RFC3339Nano, *window.ResetsAt); err == nil && !reset.After(now) {
					slot.resetSeen = append(slot.resetSeen, *window.ResetsAt)
					if slot.due.After(now) {
						slot.due = now
					}
					break
				}
			}
			if !slot.due.After(now) {
				manager.refreshLocked(slot)
			}
		}
		manager.publishLocked()
		manager.mu.Unlock()
		if enabled {
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-manager.context.Done():
			case <-manager.wake:
			case <-timer.C:
			}
			timer.Stop()
		} else {
			select {
			case <-manager.context.Done():
			case <-manager.wake:
			}
		}
	}
}

func (manager *subscriptionsManager) stop() {
	manager.cancel()
	manager.mu.Lock()
	manager.stopped = true
	for _, slot := range manager.slots {
		invalidateSubscription(slot)
	}
	manager.mu.Unlock()
	manager.worker.Wait()
}

func (manager *subscriptionsManager) refreshLocked(slot *subscriptionSlot) {
	if manager.stopped || slot.cancel != nil || !slot.view.Eligible {
		return
	}
	if slot.view.Error != nil && slot.view.Error.RetryAt != nil {
		if at, err := time.Parse(time.RFC3339Nano, *slot.view.Error.RetryAt); err == nil && at.After(time.Now()) {
			return
		}
	}
	job, cancel := context.WithCancel(manager.context)
	slot.cancel = cancel
	slot.view.Refreshing = true
	at := now()
	slot.view.LastAttemptAt = &at
	generation, id := slot.generation, slot.view.ProviderID
	manager.worker.Go(func() {
		defer cancel()
		select {
		case manager.permits <- struct{}{}:
		case <-job.Done():
			return
		}
		defer func() { <-manager.permits }()
		wait, cancel := context.WithTimeout(job, 120*time.Second)
		defer cancel()
		var result subscriptionResolved
		var failure *subscriptionFailure
		if id == "claude-code" {
			result, failure = manager.readClaude(wait)
		} else {
			result.reading, result.source, failure = readRegisteredSubscription(wait, id)
			result.observed = now()
		}
		if wait.Err() != nil {
			failure = subscriptionError("network-error")
		}
		manager.mu.Lock()
		defer manager.mu.Unlock()
		if slot.generation != generation {
			return
		}
		slot.cancel = nil
		slot.view.Refreshing = false
		slot.due = time.Now().Add(subscriptionProviderInterval(id, manager.settings.RefreshMinutes))
		if failure == nil {
			applySubscriptionReading(slot, result)
		} else {
			slot.failures++
			slot.view.HasCredential = failure.Code != "credentials-missing"
			slot.view.State = "unavailable"
			if len(slot.view.Windows) > 0 {
				slot.view.State = "stale"
			}
			slot.due = time.Now().Add(min((time.Minute << min(slot.failures, 5)), 30*time.Minute))
			slot.view.Error = failure
		}
		manager.expireLocked()
		manager.publishLocked()
	})
}

func resolveClaudeSubscription(reading subscriptionReading, failure *subscriptionFailure, profile func() (subscriptionResolved, *subscriptionFailure, bool)) (subscriptionResolved, *subscriptionFailure) {
	if failure == nil {
		if len(reading.windows) > 0 {
			return subscriptionResolved{reading, "claude-login", now()}, nil
		}
		failure = subscriptionError("no-limits-reported")
	}
	if failure.Code != "no-limits-reported" && failure.Code != "credentials-missing" {
		return subscriptionResolved{}, failure
	}
	if resolved, err, available := profile(); available {
		return resolved, err
	}
	return subscriptionResolved{}, failure
}

func profileSubscriptionQuota(reading subscriptionReading, failure *subscriptionFailure, observed string) object {
	quota := object{"state": "ready", "source": "claude-profile", "observedAt": observed, "windows": reading.windows,
		"accountBlocked": reading.accountBlocked, "blockedPoolIds": reading.blockedPoolIDs}
	if failure != nil {
		quota = object{"state": "unavailable", "source": "claude-profile", "observedAt": observed, "windows": []any{}, "error": failure}
	}
	result := object{}
	if err := canonjson.Unmarshal([]byte(wire(quota)), &result); err != nil {
		panic(err)
	}
	return result
}

func (manager *subscriptionsManager) readClaude(ctx context.Context) (subscriptionResolved, *subscriptionFailure) {
	manager.claudeMu.Lock()
	defer manager.claudeMu.Unlock()
	reading, failure := readNativeClaudeSubscription(ctx)
	return resolveClaudeSubscription(reading, failure, func() (subscriptionResolved, *subscriptionFailure, bool) {
		profile, err := defaultSignedInClaudeAccount()
		if err != nil || profile == "" {
			return subscriptionResolved{}, nil, false
		}
		if manager.recentProfile == profile {
			if age, valid := subscriptionReadingAge(&manager.recentClaude.observed, time.Now()); valid && age < 3*time.Minute {
				return manager.recentClaude, nil, true
			}
		}
		reading, failure := readClaudeProfileSubscription(ctx, profile)
		observed := now()
		if err := saveProviderAccountQuota(profile, profileSubscriptionQuota(reading, failure, observed)); err != nil {
			recordLog("WARN", err.Error(), nil)
		}
		result := subscriptionResolved{reading, "claude-profile", observed}
		if failure == nil {
			manager.recentProfile, manager.recentClaude = profile, result
		}
		return result, failure, true
	})
}

func (manager *subscriptionsManager) refreshClaudeProfile(ctx context.Context, profile string, force bool) error {
	manager.claudeMu.Lock()
	defer manager.claudeMu.Unlock()
	rows, err := readAccounts()
	if err != nil {
		return err
	}
	account := ownerOfAccountProfile(rows, profile)
	if account == nil {
		return errors.New("ACCOUNT_PROFILE_NOT_FOUND")
	}
	observed := text(account["quota"], "observedAt")
	if age, valid := subscriptionReadingAge(&observed, time.Now()); !force && valid && age < 3*time.Minute {
		return nil
	}
	reading, failure := readClaudeProfileSubscription(ctx, profile)
	observed = now()
	if err := saveProviderAccountQuota(profile, profileSubscriptionQuota(reading, failure, observed)); err != nil {
		return err
	}
	selected, err := defaultSignedInClaudeAccount()
	if err != nil {
		return err
	}
	if failure == nil && selected == profile {
		result := subscriptionResolved{reading, "claude-profile", observed}
		manager.mu.Lock()
		if !manager.stopped {
			slot := manager.slots["claude-code"]
			slot.generation++
			if slot.cancel != nil {
				slot.cancel()
				slot.cancel = nil
			}
			slot.view.Refreshing, slot.view.LastAttemptAt = false, &observed
			slot.due = time.Now().Add(subscriptionProviderInterval("claude-code", manager.settings.RefreshMinutes))
			applySubscriptionReading(slot, result)
			manager.publishLocked()
		}
		manager.mu.Unlock()
		manager.recentProfile, manager.recentClaude = profile, result
	}
	return nil
}

func (manager *subscriptionsManager) changeSettings(input object) (object, error) {
	settings, err := parseSubscriptionSettings(input)
	if err != nil {
		return nil, err
	}
	manager.mu.Lock()
	value := object{"enabled": settings.Enabled, "refreshMinutes": settings.RefreshMinutes, "agentProviders": settings.AgentProviders}
	err = save(subscriptionSettingsPath(), value)
	if err == nil {
		for _, provider := range subscriptionProviders {
			slot := manager.slots[provider.id]
			slot.view.AgentIDs = subscriptionAgents(settings, provider)
			if manager.settings.RefreshMinutes != settings.RefreshMinutes && slot.view.Error == nil {
				slot.due = time.Now().Add(subscriptionProviderInterval(provider.id, settings.RefreshMinutes))
			}
			if manager.settings.Enabled != settings.Enabled {
				invalidateSubscription(slot)
			}
			if !settings.Enabled {
				removeSubscriptionReading(provider.id)
			}
		}
		manager.settings = settings
		manager.publishLocked()
	}
	manager.mu.Unlock()
	if err != nil {
		return nil, err
	}
	manager.notify()
	return manager.snapshot()
}

func (manager *subscriptionsManager) refreshProvider(body object) (object, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if id, ok := body["providerId"].(string); ok {
		slot := manager.slots[id]
		if slot == nil {
			return nil, errors.New("unknown subscription provider")
		}
		if !slot.view.Eligible {
			return nil, errors.New("provider is not eligible")
		}
		manager.refreshLocked(slot)
	} else {
		for _, id := range sortedSubscriptionIDs(manager.slots) {
			manager.refreshLocked(manager.slots[id])
		}
	}
	manager.publishLocked()
	return object{"accepted": true, "revision": manager.latest.Revision}, nil
}

func sortedSubscriptionIDs(slots map[string]*subscriptionSlot) []string {
	ids := make([]string, 0, len(slots))
	for id := range slots {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (manager *subscriptionsManager) storeCredential(body object) (object, error) {
	id := text(body, "providerId")
	provider := subscriptionProvider(id)
	if provider == nil || !provider.acceptsKey {
		return nil, errors.New("provider does not accept a key")
	}
	manager.mu.Lock()
	path := subscriptionCredentialPath(id)
	var err error
	switch body["action"] {
	case "set":
		key := strings.TrimSpace(text(body, "key"))
		if key == "" || len(key) > 8192 || strings.ContainsFunc(key, func(r rune) bool { return r < 33 || r > 126 }) {
			err = errors.New("invalid subscription key")
		} else {
			err = save(path, object{"key": key})
		}
	case "clear":
		if err = os.Remove(path); errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		if err != nil {
			err = errors.New("could not clear subscription key")
		}
	default:
		err = errors.New("explicit set or clear required")
	}
	if err == nil {
		slot := manager.slots[id]
		invalidateSubscription(slot)
		removeSubscriptionReading(id)
		slot.view.HasCredential, slot.view.CredentialSource = skillFile(path), nil
		if slot.view.HasCredential {
			source := "saved-key"
			slot.view.CredentialSource = &source
		}
		manager.publishLocked()
	}
	manager.mu.Unlock()
	if err != nil {
		return nil, err
	}
	manager.notify()
	return manager.snapshot()
}

func codexDispatchSubscriptionQuota(value any) object {
	groups := obj(field(value, "rateLimitsByLimitId"))
	if groups == nil {
		if group := obj(field(value, "rateLimits")); group != nil {
			id, ok := group["limitId"].(string)
			if !ok {
				id = "codex"
			}
			groups = object{id: group}
		}
	}
	pools := []any{}
	for _, id := range keys(groups) {
		group := groups[id]
		pool := object{"id": id}
		for _, name := range []string{"rateLimitReachedType", "spendControlReached", "credits"} {
			if v := field(group, name); v != nil {
				pool[name] = v
			}
		}
		for _, slot := range []string{"primary", "secondary"} {
			if window := obj(field(group, slot)); window != nil {
				projection := object{}
				for _, key := range []string{"usedPercent", "windowDurationMins", "resetsAt"} {
					if v := window[key]; v != nil {
						projection[key] = v
					}
				}
				pool[slot] = projection
			}
		}
		pools = append(pools, pool)
	}
	return object{"ordinaryUsageAllowed": field(value, "ordinaryUsageAllowed"), "pools": pools}
}

func init() {
	registerServiceStartup(func(ctx context.Context, s *service) error {
		manager, err := newSubscriptions(ctx)
		if err != nil {
			return err
		}
		subscriptionsManagers.Store(s, manager)
		manager.worker.Go(func() { manager.run(s) })
		s.cleanup = append(s.cleanup, func() { manager.stop(); subscriptionsManagers.Delete(s) })
		return nil
	})
	httpRoute := func(handle func(*subscriptionsManager, object) (object, error)) managementHandler {
		return func(_ context.Context, s *service, body object, _ []string) (any, error) {
			manager, err := getSubscriptions(s)
			if err != nil {
				return nil, err
			}
			return handle(manager, body)
		}
	}
	registerRoute("GET", "subscriptions", httpRoute(func(m *subscriptionsManager, _ object) (object, error) { return m.snapshot() }))
	registerRoute("PUT", "subscriptions/settings", httpRoute((*subscriptionsManager).changeSettings))
	registerRoute("POST", "subscriptions/refresh", httpRoute((*subscriptionsManager).refreshProvider))
	registerRoute("PUT", "subscriptions/credentials", httpRoute((*subscriptionsManager).storeCredential))
	accountSubscriptionSnapshot = func(s *service) (any, error) {
		manager, err := getSubscriptions(s)
		if err != nil {
			return nil, err
		}
		return manager.snapshot()
	}
	refreshAccountSubscription = func(_ context.Context, s *service, id string) error {
		manager, err := getSubscriptions(s)
		if err != nil {
			return err
		}
		_, err = manager.refreshProvider(object{"providerId": id})
		return err
	}
	refreshAccountClaudeQuota = func(ctx context.Context, s *service, profile string, force bool) error {
		manager, err := getSubscriptions(s)
		if err != nil {
			return err
		}
		return manager.refreshClaudeProfile(ctx, profile, force)
	}
}
