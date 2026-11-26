package core

import (
	"context"
	"errors"
	"net/http"
	"sync"
)

type inProcess struct {
	generation generation
	slots      chan struct{}
	mu         sync.Mutex
	draining   bool
	pending    map[string]context.CancelFunc
	target     transportTarget
}

func newInProcess(target transportTarget) *inProcess {
	return &inProcess{generation: generation(newUUID()), slots: make(chan struct{}, maxInFlight),
		pending: make(map[string]context.CancelFunc), target: target}
}

func (p *inProcess) hello(version uint16) (frontDoorHello, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if version != frontDoorVersion {
		return frontDoorHello{}, errors.New("FRONT_DOOR_PROTOCOL_MISMATCH: Use matching front-door and Core protocol versions.")
	}
	readiness := "Ready"
	if p.draining {
		readiness = "Draining"
	}
	return frontDoorHello{frontDoorVersion, p.generation, readiness, maxRequestBytes, maxFrameBytes}, nil
}

func (p *inProcess) drain() {
	p.mu.Lock()
	p.draining = true
	p.mu.Unlock()
}

func (p *inProcess) cancel(frame frontDoorCancellation) error {
	if err := generationFence(p.generation, frame.Generation); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if stop := p.pending[frame.RequestID]; stop != nil {
		stop()
	}
	return nil
}

func (p *inProcess) admit(ctx context.Context, request frontDoorRequest) (any, error) {
	if request.Version != frontDoorVersion {
		return nil, errors.New("FRONT_DOOR_PROTOCOL_MISMATCH: Use matching front-door and Core protocol versions.")
	}
	if err := generationFence(p.generation, request.Generation); err != nil {
		return nil, err
	}
	remaining, err := request.Deadline.remaining()
	if err != nil {
		return nil, err
	}
	deadline, cancel := context.WithTimeout(ctx, remaining)
	defer cancel()
	p.mu.Lock()
	if p.draining {
		p.mu.Unlock()
		return nil, errors.New("FRONT_DOOR_CORE_DRAINING: Read current state after Core is ready.")
	}
	if _, exists := p.pending[request.ID]; exists {
		p.mu.Unlock()
		return nil, errors.New("FRONT_DOOR_DUPLICATE_REQUEST")
	}
	select {
	case p.slots <- struct{}{}:
	default:
		p.mu.Unlock()
		return nil, errors.New("FRONT_DOOR_BUSY: Wait for an admitted request to finish.")
	}
	p.pending[request.ID] = cancel
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, request.ID)
		<-p.slots
		p.mu.Unlock()
	}()
	value, err := p.dispatch(deadline, request)
	switch deadline.Err() {
	case context.Canceled:
		return nil, errors.New("FRONT_DOOR_CANCELLED: Request cancelled; Agent execution is unchanged.")
	case context.DeadlineExceeded:
		return nil, errors.New(frontDoorDeadlineExpired)
	}
	return value, err
}

func (p *inProcess) dispatch(ctx context.Context, request frontDoorRequest) (any, error) {
	if str(request.Context.Authority) != "Management" {
		return nil, errors.New("FRONT_DOOR_CONTEXT_MISMATCH")
	}
	body := obj(request.Body)
	if body == nil {
		body = object{}
	}
	if name, ok := request.Operation.(string); ok {
		switch name {
		case "Health":
			return p.target.management(ctx, "healthz", http.MethodGet, body)
		case "LocalControl":
			return p.target.management(ctx, "cli/control", http.MethodPost, body)
		case "Mcp", "PeerControl":
			return nil, errors.New(PortPending)
		}
	}
	if route, ok := obj(request.Operation)["Management"]; ok {
		return p.target.management(ctx, text(route, "route"), text(route, "method"), body)
	}
	return nil, errors.New("FRONT_DOOR_CONTEXT_MISMATCH")
}
