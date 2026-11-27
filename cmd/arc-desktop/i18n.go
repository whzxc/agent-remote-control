package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/whzxc/agent-remote-control/ui/locales"
)

var translations = sync.OnceValue(func() map[bool]map[string]string {
	data := make(map[bool]map[string]string)
	for chinese, name := range map[bool]string{false: "en.json", true: "zh-CN.json"} {
		raw, err := locales.Files.ReadFile(name)
		if err != nil {
			logError(err)
			continue
		}
		var catalog map[string]string
		logError(json.Unmarshal(raw, &catalog))
		data[chinese] = catalog
	}
	return data
})

func (s *DesktopService) translate(key string) string {
	catalog := translations()
	return fallback(catalog[s.locale.Load()][key], fallback(catalog[false][key], key))
}

func (s *DesktopService) setLocale(ctx context.Context, locale, resolved string) error {
	s.locale.Store(locale == "zh-CN")
	if previous, ok := s.resolvedLocale.Load().(string); ok && previous == resolved {
		return nil
	}
	if _, err := s.request(ctx, "preferences", http.MethodPut, object{"values": object{"resolved-language": resolved}}); err != nil {
		return err
	}
	s.resolvedLocale.Store(resolved)
	return nil
}
