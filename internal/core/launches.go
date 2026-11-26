package core

import (
	"errors"
	"sync"
	"sync/atomic"
)

type launches struct {
	closed      atomic.Bool
	publication sync.Mutex
}

func (l *launches) close() {
	l.closed.Store(true)
	l.publication.Lock()
	l.publication.Unlock()
}

func (l *launches) run(action func() error) error {
	l.publication.Lock()
	defer l.publication.Unlock()
	if l.closed.Load() {
		return errors.New("CORE_SHUTTING_DOWN: retry after Core restarts")
	}
	return action()
}
