//go:build !darwin

package main

import "context"

type sourceState struct{}

func (s *DesktopService) sourceRequest(context.Context, string, object) (any, error) {
	return object{"status": "unsupported", "profiles": []object{}}, nil
}

func (s *DesktopService) installSources() {}
