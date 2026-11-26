package core

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type appEnvironment struct {
	ReducedMotion  *bool     `json:"reducedMotion"`
	ColorScheme    *string   `json:"colorScheme"`
	Locale         *string   `json:"locale"`
	WindowWidth    *uint32   `json:"windowWidth"`
	WindowHeight   *uint32   `json:"windowHeight"`
	TaskPanelWidth *uint32   `json:"taskPanelWidth"`
	Presence       *string   `json:"presence"`
	Clock          *appClock `json:"clock"`
	ExpiresAt      *int64    `json:"expiresAt"`
}

type appClock struct {
	RealAt    int64   `json:"realAt"`
	VirtualAt int64   `json:"virtualAt"`
	Speed     float64 `json:"speed"`
	ID        string  `json:"id"`
}

var appEnvLock sync.Mutex

var appEnvFields = []string{"reducedMotion", "colorScheme", "locale", "windowWidth", "windowHeight", "taskPanelWidth", "presence", "clock", "expiresAt"}

const invalidAppEnvironment = `INVALID_APP_ENV: read guide({op:"app_env"}); use action read, set or clear and supported override values`

func saturatingClockAdd(a, b int64) int64 {
	switch {
	case b > 0 && a > math.MaxInt64-b:
		return math.MaxInt64
	case b < 0 && a < math.MinInt64-b:
		return math.MinInt64
	default:
		return a + b
	}
}

func clockDelay(deadline, now int64) int64 {
	if deadline <= now {
		return 0
	}
	if now < 0 && deadline > math.MaxInt64+now {
		return math.MaxInt64
	}
	return deadline - now
}

func clockMilliseconds(value float64) int64 {
	if value >= math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(value)
}

func (e appEnvironment) clockNow(real int64) int64 {
	if e.Clock == nil {
		return real
	}
	return saturatingClockAdd(e.Clock.VirtualAt, clockMilliseconds(float64(clockDelay(real, e.Clock.RealAt))*e.Clock.Speed))
}

func (e appEnvironment) realDeadline(deadline, real int64) (int64, bool) {
	remaining := clockDelay(deadline, e.clockNow(real))
	if remaining == 0 {
		return real, true
	}
	speed := e.speed()
	if speed <= 0 {
		return 0, false
	}
	return saturatingClockAdd(real, clockMilliseconds(math.Ceil(float64(remaining)/speed))), true
}

func (e appEnvironment) clockID() string {
	if e.Clock != nil {
		return e.Clock.ID
	}
	return "system"
}

func (e appEnvironment) presence(system bool) bool {
	if e.Presence == nil {
		return system
	}
	return *e.Presence == "present"
}

func (e appEnvironment) speed() float64 {
	if e.Clock != nil {
		return e.Clock.Speed
	}
	return 1.0
}

// The Rust boundary saves a JSON Value, so state and nested clock fields
// serialize in key order even though the decoded representation is typed.
func (e appEnvironment) value() object {
	var clock any
	if e.Clock != nil {
		clock = object{"realAt": e.Clock.RealAt, "virtualAt": e.Clock.VirtualAt, "speed": e.Clock.Speed, "id": e.Clock.ID}
	}
	return object{"reducedMotion": e.ReducedMotion, "colorScheme": e.ColorScheme, "locale": e.Locale, "windowWidth": e.WindowWidth,
		"windowHeight": e.WindowHeight, "taskPanelWidth": e.TaskPanelWidth, "presence": e.Presence, "clock": clock, "expiresAt": e.ExpiresAt}
}

func (e appEnvironment) snapshot(real int64) object {
	source := "system"
	if e.Clock != nil {
		source = "override"
	}
	return object{"active": e.ExpiresAt != nil, "expiresAt": e.ExpiresAt, "overrides": e.value(),
		"clock": object{"value": object{"nowMs": e.clockNow(real), "speed": e.speed()}, "source": source}, "realNowMs": real}
}

func changeAppEnvironment(next appEnvironment, args object, real int64) (appEnvironment, error) {
	invalid := errors.New(invalidAppEnvironment)
	if next.ExpiresAt != nil && *next.ExpiresAt <= real {
		next = appEnvironment{}
	}
	if args == nil {
		return next, invalid
	}
	for key := range args {
		if key != "action" && key != "ttlMs" && (key == "expiresAt" || !slices.Contains(appEnvFields, key)) {
			return next, invalid
		}
	}
	action, exists := args["action"].(string)
	if !exists {
		action = "read"
	}
	switch action {
	case "clear", "read":
		_, hasAction := args["action"]
		if len(args) > 1 || len(args) == 1 && !hasAction {
			return next, invalid
		}
		if action == "clear" {
			next = appEnvironment{}
		}
		return next, nil
	case "set":
	default:
		return next, invalid
	}
	ttl := uint64(900000)
	if value, exists := args["ttlMs"]; exists {
		ttl = uintOr(value, 0)
		if ttl < 1 || ttl > 3600000 {
			return next, invalid
		}
	}
	if value, exists := args["reducedMotion"]; exists {
		motion, ok := value.(bool)
		if !ok {
			return next, invalid
		}
		next.ReducedMotion = &motion
	}
	for _, rule := range []struct {
		key     string
		allowed []string
		target  **string
	}{
		{"colorScheme", []string{"light", "dark"}, &next.ColorScheme},
		{"locale", []string{"en", "zh-CN"}, &next.Locale},
		{"presence", []string{"present", "absent", "follow-system"}, &next.Presence},
	} {
		if value, exists := args[rule.key]; exists {
			name := str(value)
			if !slices.Contains(rule.allowed, name) {
				return next, invalid
			}
			*rule.target = &name
			if name == "follow-system" {
				*rule.target = nil
			}
		}
	}
	for key, dest := range map[string]**uint32{"windowWidth": &next.WindowWidth, "windowHeight": &next.WindowHeight, "taskPanelWidth": &next.TaskPanelWidth} {
		if value, exists := args[key]; exists {
			width := uintOr(value, 0)
			if width < 320 || width > 3840 {
				return next, invalid
			}
			size := uint32(width)
			*dest = &size
		}
	}
	if value, exists := args["clock"]; exists {
		edit := obj(value)
		if len(edit) == 0 {
			return next, invalid
		}
		for key := range edit {
			if !slices.Contains([]string{"freeze", "advanceMs", "speed"}, key) {
				return next, invalid
			}
		}
		clock := appClock{RealAt: real, VirtualAt: real, Speed: 1}
		if next.Clock != nil {
			clock = *next.Clock
			clock.VirtualAt, clock.RealAt = next.clockNow(real), real
		} else {
			clock.ID = id()
		}
		if speed, exists := edit["speed"]; exists {
			switch speed := speed.(type) {
			case json.Number:
				clock.Speed, _ = speed.Float64()
			case float64:
				clock.Speed = speed
			case int:
				clock.Speed = float64(speed)
			default:
				return next, invalid
			}
			if math.IsNaN(clock.Speed) || clock.Speed < 0 || clock.Speed > 100 {
				return next, invalid
			}
		}
		if value, exists := edit["freeze"]; exists {
			freeze, ok := value.(bool)
			if !ok {
				return next, invalid
			}
			switch {
			case freeze:
				clock.Speed = 0
			case edit["speed"] == nil:
				clock.Speed = 1
			}
		}
		if value, exists := edit["advanceMs"]; exists {
			ms, ok := uintValue(value)
			if !ok || ms > 604800000 {
				return next, invalid
			}
			clock.VirtualAt += int64(ms)
		}
		next.Clock = &clock
	}
	expires := real + int64(ttl)
	next.ExpiresAt = &expires
	return next, nil
}

func loadAppEnvironment(dir string, real int64) (appEnvironment, error) {
	path := filepath.Join(dir, "app-env.json")
	value, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		return appEnvironment{}, nil
	}
	if err != nil {
		return appEnvironment{}, err
	}
	fields := obj(value)
	if fields == nil {
		return appEnvironment{}, errors.New(invalidAppEnvironment)
	}
	for _, key := range keys(fields) {
		if !slices.Contains(appEnvFields, key) {
			return appEnvironment{}, errors.New(invalidAppEnvironment)
		}
	}
	var env appEnvironment
	if err := unmarshalJSON([]byte(wire(value)), &env); err != nil {
		return appEnvironment{}, err
	}
	if env.ExpiresAt == nil || *env.ExpiresAt <= real {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return appEnvironment{}, err
		}
		recordLog("info", "app_env overrides expired; following system", nil)
		return appEnvironment{}, nil
	}
	return env, nil
}

func readAppEnvironment() (appEnvironment, error) {
	appEnvLock.Lock()
	defer appEnvLock.Unlock()
	return loadAppEnvironment(root(), time.Now().UnixMilli())
}

func controlAppEnvironment(args object) (object, error) {
	appEnvLock.Lock()
	defer appEnvLock.Unlock()
	real := time.Now().UnixMilli()
	env, err := loadAppEnvironment(root(), real)
	if err != nil {
		return nil, err
	}
	next, err := changeAppEnvironment(env, args, real)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(root(), "app-env.json")
	switch action := text(args, "action"); action {
	case "clear":
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		recordLog("info", "app_env "+action+": "+wire(next.snapshot(real)), nil)
	case "set":
		if err := save(path, next.value()); err != nil {
			return nil, err
		}
		recordLog("info", "app_env "+action+": "+wire(next.snapshot(real)), nil)
	}
	return next.snapshot(real), nil
}

func init() {
	registerOperation("app_env", func(_ context.Context, request operationRequest) (any, error) {
		return controlAppEnvironment(request.args)
	}, nil)
	registerRoute("GET", "app/env", func(context.Context, *service, object, []string) (any, error) {
		return controlAppEnvironment(object{"action": "read"})
	})
}
