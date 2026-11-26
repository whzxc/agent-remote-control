package core

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"sync"
	"time"
)

const coreDraining = "FRONT_DOOR_CORE_DRAINING: Read current state after Core is ready."
const privateCancelled = "FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged."

type privateAdmission struct {
	cancel        context.CancelCauseFunc
	write, stream bool
}

type inProcess struct {
	generation            generation
	slots, streams        chan struct{}
	mu                    sync.Mutex
	draining, maintenance bool
	pending               map[string]privateAdmission
	active                sync.WaitGroup
	target                transportTarget
}

func newInProcess(target transportTarget) *inProcess {
	return &inProcess{generation: generation(newUUID()), slots: make(chan struct{}, maxInFlight), streams: make(chan struct{}, maxInFlight),
		pending: make(map[string]privateAdmission), target: target}
}

func (p *inProcess) hello(version uint16) (frontDoorHello, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if version != frontDoorVersion {
		return frontDoorHello{}, errors.New("FRONT_DOOR_PROTOCOL_MISMATCH: Use matching front-door and Core protocol versions.")
	}
	readiness := "Ready"
	if p.draining || p.maintenance {
		readiness = "Draining"
	}
	return frontDoorHello{frontDoorVersion, p.generation, readiness, maxRequestBytes, maxFrameBytes}, nil
}

func (p *inProcess) drain() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.draining = true
	for _, request := range p.pending {
		if request.stream {
			request.cancel(errors.New(coreDraining))
		}
	}
}

func (p *inProcess) cancel(frame frontDoorCancellation) error {
	if err := generationFence(p.generation, frame.Generation); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if request, ok := p.pending[frame.RequestID]; ok {
		request.cancel(errors.New(privateCancelled))
	}
	return nil
}

func (p *inProcess) begin(ctx context.Context, request frontDoorRequest, stream bool) (context.Context, func(), error) {
	if request.Version != frontDoorVersion {
		return nil, nil, errors.New("FRONT_DOOR_PROTOCOL_MISMATCH: Use matching front-door and Core protocol versions.")
	}
	if err := generationFence(p.generation, request.Generation); err != nil {
		return nil, nil, err
	}
	remaining, err := request.Deadline.remaining()
	if err != nil {
		return nil, nil, err
	}
	if request.ID == "" {
		return nil, nil, errors.New("FRONT_DOOR_REQUEST_MISMATCH")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.draining || p.maintenance {
		return nil, nil, errors.New(coreDraining)
	}
	if _, exists := p.pending[request.ID]; exists {
		return nil, nil, errors.New("FRONT_DOOR_DUPLICATE_REQUEST")
	}
	slots := p.slots
	if stream {
		slots = p.streams
	}
	select {
	case slots <- struct{}{}:
	default:
		return nil, nil, errors.New("FRONT_DOOR_BUSY: Wait for an admitted request to finish.")
	}
	deadline, end := context.WithTimeout(ctx, remaining)
	wait, cancel := context.WithCancelCause(deadline)
	p.pending[request.ID] = privateAdmission{cancel: cancel, write: isPrivateWrite(request), stream: stream}
	p.active.Add(1)
	return wait, func() {
		end()
		cancel(nil)
		p.mu.Lock()
		delete(p.pending, request.ID)
		<-slots
		p.active.Done()
		p.mu.Unlock()
	}, nil
}

func privateOutcome(ctx context.Context) error {
	switch ctx.Err() {
	case context.Canceled:
		cause := context.Cause(ctx)
		if cause == context.Canceled {
			return errors.New(privateCancelled)
		}
		return cause
	case context.DeadlineExceeded:
		return errors.New(frontDoorDeadlineExpired)
	default:
		return nil
	}
}

func (p *inProcess) admit(ctx context.Context, request frontDoorRequest) (any, error) {
	wait, done, err := p.begin(ctx, request, false)
	if err != nil {
		return nil, err
	}
	defer done()
	if privateFixtureAdmitted != nil {
		if err := privateFixtureAdmitted(request); err != nil {
			return nil, err
		}
	}
	value, err := p.dispatch(wait, request)
	if interrupted := privateOutcome(wait); interrupted != nil {
		return nil, interrupted
	}
	return value, err
}

var privateFixtureAdmitted func(frontDoorRequest) error
var browserSnapshotComparison func(any) any

func (p *inProcess) snapshotStream(ctx context.Context, request frontDoorRequest, send func(frontDoorStream) error) error {
	wait, done, err := p.begin(ctx, request, true)
	if err != nil {
		return err
	}
	defer done()
	kind := text(field(request.Operation, "Snapshot"), "kind")
	if kind == "" {
		return errors.New(contextMismatch)
	}
	interval := 2 * time.Second
	if kind == "Activity" {
		interval = time.Second
	} else if kind == "Subscriptions" {
		interval = 15 * time.Second
	}
	frames := time.NewTicker(interval)
	defer frames.Stop()
	authority := time.NewTicker(2 * time.Second)
	defer authority.Stop()
	last := time.Now()
	var sequence uint64
	var previous string
	for {
		if err := privateOutcome(wait); err != nil {
			return err
		}
		snapshot, err := p.dispatch(wait, request)
		if err != nil {
			return err
		}
		comparison := snapshot
		switch kind {
		case "Activity":
			filtered := maps.Clone(obj(snapshot))
			delete(filtered, "observedAt")
			comparison = filtered
		case "Browser":
			if browserSnapshotComparison != nil {
				comparison = browserSnapshotComparison(snapshot)
			}
		}
		changed := kind != "Activity" && kind != "Browser" || wire(comparison) != previous
		if changed || time.Since(last) >= 15*time.Second {
			var body any
			if changed {
				previous, body = wire(comparison), snapshot
			}
			if err := validatePrivateAuthority(wait, request.Context.Authority); err != nil {
				return err
			}
			if err := send(frontDoorStream{Generation: p.generation, RequestID: request.ID, Sequence: sequence, Body: body}); err != nil {
				return err
			}
			sequence++
			last = time.Now()
		}
	poll:
		for {
			select {
			case <-wait.Done():
				return privateOutcome(wait)
			case <-frames.C:
				break poll
			case <-authority.C:
				if err := validatePrivateAuthority(wait, request.Context.Authority); err != nil {
					return err
				}
			}
		}
	}
}

type frontDoorMaintenance struct {
	endpoint   *inProcess
	endedReads int
}

func (p *inProcess) enterMaintenance() (frontDoorMaintenance, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.draining || p.maintenance {
		return frontDoorMaintenance{}, errors.New("FRONT_DOOR_CORE_DRAINING: Core is already draining.")
	}
	p.maintenance = true
	state := frontDoorMaintenance{endpoint: p}
	for id, pending := range p.pending {
		if !pending.write {
			pending.cancel(errors.New(wire(object{"code": -32603,
				"message": "FRONT_DOOR_CORE_DRAINING: Front-door maintenance ended this read. Issue a new authorized read after Core is ready.",
				"data":    object{"requestId": id, "next": object{"via": "query", "op": "guide", "args": object{"topic": "loop"}}}})))
			state.endedReads++
		}
	}
	return state, nil
}

func (m frontDoorMaintenance) close() {
	m.endpoint.mu.Lock()
	defer m.endpoint.mu.Unlock()
	m.endpoint.maintenance = false
}

func (m frontDoorMaintenance) outstandingWrites() int {
	m.endpoint.mu.Lock()
	defer m.endpoint.mu.Unlock()
	outstanding := 0
	for _, request := range m.endpoint.pending {
		if request.write {
			outstanding++
		}
	}
	return outstanding
}

func (m frontDoorMaintenance) drain(ctx context.Context) (frontDoorDrainAck, error) {
	wait, cancel := context.WithTimeout(ctx, drainTimeout)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if m.outstandingWrites() == 0 {
			return frontDoorDrainAck{Generation: m.endpoint.generation}, nil
		}
		select {
		case <-wait.Done():
			return frontDoorDrainAck{}, errors.New("FRONT_DOOR_DRAIN_DEADLINE: Admitted writes remain; read their original receipts.")
		case <-ticker.C:
		}
	}
}

func (p *inProcess) dispatch(ctx context.Context, request frontDoorRequest) (any, error) {
	body := obj(request.Body)
	if body == nil {
		body = object{}
	}
	authority := request.Context.Authority
	if str(request.Operation) == "Mcp" {
		if forwarded := obj(field(authority, "Ingress")); forwarded != nil {
			if service, ok := p.target.(*service); ok {
				source, err := privateIngressSource(ctx, service, forwarded)
				if err != nil {
					return nil, err
				}
				return dispatchMCP(ctx, service, source, body)
			}
			ingress := text(forwarded, "ingress_id")
			principal := forwarded["principal"]
			if ingress != "" && text(principal, "type") == "ingress" && text(principal, "ingressId") == ingress && forwarded["header"] == nil {
				return p.target.mcp(ctx, ingress, body)
			}
			return nil, errors.New(contextMismatch)
		}
	}
	if err := validatePrivateAuthority(ctx, authority); err != nil {
		return nil, err
	}
	management := str(authority) == "Management"
	switch str(request.Operation) {
	case "Health":
		if management {
			return p.target.management(ctx, "healthz", http.MethodGet, body)
		}
	case "LocalControl":
		if management {
			return p.target.management(ctx, "cli/control", http.MethodPost, body)
		}
	case "PeerControl":
		if peer := obj(field(authority, "Peer")); peer != nil {
			service, ok := p.target.(*service)
			if !ok || peerControlRequest == nil {
				return nil, errors.New(PortPending)
			}
			return peerControlRequest(ctx, service, text(peer, "device_id"), body)
		}
	case "Mcp":
		if source := obj(field(authority, "Mcp")); source != nil {
			service, ok := p.target.(*service)
			if !ok {
				return nil, errors.New(contextMismatch)
			}
			if resolveAuthenticatedMCP == nil {
				return nil, errors.New(PortPending)
			}
			configured, err := resolveAuthenticatedMCP(ctx, service, text(source, "ingress_id"), text(source, "source_id"))
			if err != nil {
				return nil, err
			}
			configured.origin = obj(source["origin"])
			return dispatchMCP(ctx, service, configured, body)
		}
	}
	if route, ok := obj(request.Operation)["Management"]; ok {
		name, method := text(route, "route"), text(route, "method")
		if !management {
			if obj(field(authority, "Browser")) == nil {
				return nil, errors.New(contextMismatch)
			}
			if err := authorizeBrowserRoute(name, method, body); err != nil {
				return nil, err
			}
			if name == "status" {
				name = "browser/snapshot"
			}
		}
		return p.target.management(ctx, name, method, body)
	}
	if entry, ok := obj(request.Operation)["Authority"]; ok && management {
		return handleSourceAuthority(ctx, text(entry, "op"), body)
	}
	if entry, ok := obj(request.Operation)["Snapshot"]; ok {
		browser := obj(field(authority, "Browser")) != nil
		if !management && !browser {
			return nil, errors.New(contextMismatch)
		}
		switch text(entry, "kind") {
		case "Status":
			if browser {
				return nil, errors.New("FRONT_DOOR_BROWSER_FORBIDDEN")
			}
			return p.target.management(ctx, "status", http.MethodGet, body)
		case "Browser":
			return p.target.management(ctx, "browser/snapshot", http.MethodGet, body)
		case "Subscriptions":
			return p.target.management(ctx, "subscriptions", http.MethodGet, body)
		case "Activity":
			return p.target.management(ctx, "agents/activity", http.MethodGet, body)
		}
	}
	return nil, errors.New(contextMismatch)
}
