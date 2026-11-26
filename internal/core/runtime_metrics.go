package core

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

var runtimeWorkNames = [...]string{"status", "accounts", "activity", "notificationObserve", "notificationDelivery", "desktopFrame"}

type runtimeWorkCounter struct {
	calls, inFlight, total, max atomic.Uint64
}

var runtimeWorkCounters [len(runtimeWorkNames)]runtimeWorkCounter
var runtimeMetricsStarted = sync.OnceValue(time.Now)

func beginRuntimeWork(name string) func() {
	runtimeMetricsStarted()
	for i, known := range runtimeWorkNames {
		if name != known {
			continue
		}
		counter := &runtimeWorkCounters[i]
		counter.calls.Add(1)
		counter.inFlight.Add(1)
		started := time.Now()
		return func() {
			elapsed := uint64(time.Since(started).Microseconds())
			counter.total.Add(elapsed)
			for previous := counter.max.Load(); elapsed > previous && !counter.max.CompareAndSwap(previous, elapsed); previous = counter.max.Load() {
			}
			counter.inFlight.Add(^uint64(0))
		}
	}
	panic("Unknown runtime work " + name)
}

var runtimeObservationKeys = [...]string{
	"completedPasses", "bindingsScanned", "bindingsReused", "historyReads", "ownershipDiscoveries",
	"pendingReconciliations", "reconciliationExhausted", "retiredBindings", "unattributedBindings",
}
var runtimeObservationPhases = [...]string{"scan", "history", "process", "ownership", "ownerDiscovery"}

type runtimeObservationSample struct {
	counts [len(runtimeObservationKeys)]uint64
	wall   [len(runtimeObservationPhases)]uint64
}

func (sample runtimeObservationSample) snapshot() object {
	result, phases := object{}, object{}
	for i, key := range runtimeObservationKeys {
		result[key] = sample.counts[i]
	}
	for i, phase := range runtimeObservationPhases {
		phases[phase] = float64(sample.wall[i]) / 1000
	}
	result["phaseWallMs"] = phases
	return result
}

type runtimeObservationPass struct {
	sample runtimeObservationSample
}

var runtimeObservation struct {
	sync.Mutex
	current      *runtimeObservationPass
	last, totals runtimeObservationSample
}

func beginRuntimeObservation() *runtimeObservationPass {
	runtimeObservation.Lock()
	defer runtimeObservation.Unlock()
	pass := &runtimeObservationPass{}
	runtimeObservation.current = pass
	return pass
}

func (pass *runtimeObservationPass) add(key string, count uint64) {
	runtimeObservation.Lock()
	defer runtimeObservation.Unlock()
	for i, known := range runtimeObservationKeys {
		if key == known {
			pass.sample.counts[i] += count
			return
		}
	}
	panic("Unknown runtime observation counter " + key)
}

func (pass *runtimeObservationPass) timePhase(phase string) func() {
	started := time.Now()
	for i, known := range runtimeObservationPhases {
		if phase == known {
			return func() {
				runtimeObservation.Lock()
				defer runtimeObservation.Unlock()
				pass.sample.wall[i] += uint64(time.Since(started).Microseconds())
			}
		}
	}
	panic("Unknown runtime observation phase " + phase)
}

func (pass *runtimeObservationPass) finish() {
	runtimeObservation.Lock()
	defer runtimeObservation.Unlock()
	for i, count := range pass.sample.counts {
		runtimeObservation.totals.counts[i] += count
	}
	for i, wall := range pass.sample.wall {
		runtimeObservation.totals.wall[i] += wall
	}
	runtimeObservation.last = pass.sample
	if runtimeObservation.current == pass {
		runtimeObservation.current = nil
	}
}

func runtimeObservationSnapshot() object {
	runtimeObservation.Lock()
	defer runtimeObservation.Unlock()
	var current any
	if pass := runtimeObservation.current; pass != nil {
		current = pass.sample.snapshot()
	}
	return object{"currentPass": current, "lastPass": runtimeObservation.last.snapshot(), "totals": runtimeObservation.totals.snapshot()}
}

var notificationBindingDiagnostics func() object
var runtimeDesktopDiagnostics func(*service) object
var runtimeTimelineDiagnostics func(*nativeEvents) (int, int)

func runtimeMetrics(ctx context.Context, request operationRequest) (any, error) {
	started := runtimeMetricsStarted()
	var work []object
	for i, name := range runtimeWorkNames {
		counter := &runtimeWorkCounters[i]
		work = append(work, object{
			"name": name, "calls": counter.calls.Load(), "inFlight": counter.inFlight.Load(),
			"totalWallMs": float64(counter.total.Load()) / 1000, "maxWallMs": float64(counter.max.Load()) / 1000,
		})
	}
	var buildID, bindings, instance any
	if build, err := processBuildID(); err == nil {
		buildID = build
	}
	if notificationBindingDiagnostics != nil {
		bindings = notificationBindingDiagnostics()
	}
	desktop := object{"connected": false, "pendingRequests": 0, "owners": 0, "snapshots": nil}
	events := object{"rows": 0, "wireBytes": 0, "timelines": 0, "timelineEntries": 0, "pendingInteractions": 0}
	if s := request.service; s != nil {
		instance = s.metadata["instance"]
		if runtimeDesktopDiagnostics != nil {
			desktop = runtimeDesktopDiagnostics(s)
		}
		s.events.Lock()
		events["rows"], events["wireBytes"], events["pendingInteractions"] = len(s.events.rows), s.events.bytes, len(s.events.pending)
		if runtimeTimelineDiagnostics != nil {
			events["timelines"], events["timelineEntries"] = runtimeTimelineDiagnostics(&s.events)
		}
		s.events.Unlock()
	}
	costs := &runtimeCosts
	if scope, ok := ctx.Value(runtimeCostKey{}).(runtimeCostContext); ok {
		costs = scope.set
	}
	return object{
		"schemaVersion": 1, "pid": os.Getpid(), "observedAt": now(), "buildId": buildID, "elapsedMs": time.Since(started).Milliseconds(),
		"process": runtimeProcessMetrics(), "work": work, "notificationObserve": runtimeObservationSnapshot(), "cost": costs.snapshot(),
		"indexWatches": watchDiagnostics(), "caches": object{"json": cacheDiagnostics(), "notificationBindings": bindings},
		"instance": instance, "desktopIpc": desktop, "events": events,
	}, nil
}

func runtimeProcessUnavailable(err error) object {
	return object{"state": "unavailable", "cpuTotalMs": nil, "residentBytes": nil, "physicalFootprintBytes": nil, "error": err.Error()}
}

func init() {
	registerOperation("runtime_metrics", runtimeMetrics, nil)
	registerRoute("GET", "runtime/metrics", func(ctx context.Context, service *service, _ object, _ []string) (any, error) {
		return runtimeMetrics(ctx, operationRequest{service: service})
	})
	registerServiceStartup(func(context.Context, *service) error { runtimeMetricsStarted(); return nil })
}
