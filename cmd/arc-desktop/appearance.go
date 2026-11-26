package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type appearanceState struct {
	sync.Mutex
	current object
}

func appearancePath() string { return filepath.Join(core.DesktopStateDir(), "desktop-appearance.json") }

func validateAppearance(settings object) error {
	menu, menuOK := settings["showMenuBar"].(bool)
	dock, dockOK := settings["showDock"].(bool)
	if len(settings) != 2 || !menuOK || !dockOK || (!menu && !dock) {
		return errors.New("Invalid display settings")
	}
	return nil
}

func (s *DesktopService) installAppearance() error {
	s.appearance.Lock()
	defer s.appearance.Unlock()
	settings := object{"showMenuBar": true, "showDock": true}
	if err := readJSON(appearancePath(), &settings); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if settings["showMenuBar"] == false && settings["showDock"] == false {
		settings["showMenuBar"], settings["showDock"] = true, true
		if err := writeJSON(appearancePath(), settings); err != nil {
			return err
		}
	}
	if err := validateAppearance(settings); err != nil {
		return err
	}
	if err := s.applyAppearance(settings); err != nil {
		return err
	}
	s.appearance.current = settings
	return nil
}

func (s *DesktopService) applyAppearance(settings object) error {
	if err := s.setTrayVisible(settings["showMenuBar"] == true); err != nil {
		return err
	}
	if settings["showDock"] == true {
		mygo.App.Dock.Show()
	} else {
		mygo.App.Dock.Hide()
	}
	return nil
}

func (s *DesktopService) requestAppearance(ctx context.Context, method string, body object) (any, error) {
	s.appearance.Lock()
	defer s.appearance.Unlock()
	current := s.appearance.current
	if method == http.MethodGet {
		return current, nil
	}
	if method != http.MethodPut {
		return nil, errors.New("Unsupported display settings operation")
	}
	if err := validateAppearance(body); err != nil {
		return nil, err
	}
	err := onMain(ctx, func() error {
		if err := s.applyAppearance(body); err != nil {
			return err
		}
		if err := writeJSON(appearancePath(), body); err != nil {
			if current != nil {
				_ = s.applyAppearance(current)
			}
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.appearance.current = body
	return body, nil
}
