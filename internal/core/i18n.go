package core

import (
	"os"
	"strings"
	"sync"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/ui/locales"
)

func locale() string {
	prefs := readPreferences()
	switch language := text(prefs, "language"); language {
	case "en", "zh-CN":
		return language
	}
	if resolved, ok := prefs["resolved-language"].(string); ok {
		return resolved
	}
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		value, ok := os.LookupEnv(name)
		if !ok {
			continue
		}
		language := strings.ToLower(strings.ReplaceAll(value, "_", "-"))
		for _, prefix := range []string{"zh-cn", "zh-sg", "zh-hans"} {
			if strings.HasPrefix(language, prefix) {
				return "zh-CN"
			}
		}
		break
	}
	return "en"
}

var localeMessages = sync.OnceValue(func() map[string]object {
	rows := make(map[string]object)
	for _, locale := range []string{"en", "zh-CN"} {
		content, err := locales.Files.ReadFile(locale + ".json")
		if err != nil {
			panic(err)
		}
		var values object
		if err := canonjson.Unmarshal(content, &values); err != nil {
			panic(err)
		}
		rows[locale] = values
	}
	return rows
})

func localized(locale, key string) string {
	messages := localeMessages()
	if locale == "zh-CN" {
		if value, ok := messages[locale][key].(string); ok {
			return value
		}
	}
	if value, ok := messages["en"][key].(string); ok {
		return value
	}
	return key
}
