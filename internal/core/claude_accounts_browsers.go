package core

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type claudeLoginBrowser struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	path, profile string
}

func newClaudeBrowser(path, name string) claudeLoginBrowser {
	return claudeLoginBrowser{ID: hash([]byte(path)), Name: name, path: path}
}

func collectClaudeApps(directory string, depth int, apps *[]string) {
	rows, _ := os.ReadDir(directory)
	for _, row := range rows {
		path := filepath.Join(directory, row.Name())
		if filepath.Ext(path) == ".app" {
			*apps = append(*apps, path)
		} else if row.IsDir() && depth > 0 {
			collectClaudeApps(path, depth-1, apps)
		}
	}
}

func discoverClaudeBrowsers(ctx context.Context) ([]claudeLoginBrowser, error) {
	found := []claudeLoginBrowser{}
	home, _ := os.UserHomeDir()
	switch operatingSystem {
	case "darwin":
		var apps []string
		for _, dir := range []string{"/Applications", "/System/Applications", filepath.Join(home, "Applications")} {
			collectClaudeApps(dir, 2, &apps)
		}
		for _, path := range apps {
			data, err := nativeCommand(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(path, "Contents/Info.plist")).Output()
			var plist object
			if err != nil || canonjson.Unmarshal(data, &plist) != nil {
				continue
			}
			handlesWeb := slices.ContainsFunc(arr(plist["CFBundleURLTypes"]), func(item any) bool {
				return !slices.Contains([]string{"Alternate", "None"}, text(item, "LSHandlerRank")) &&
					slices.ContainsFunc(arr(field(item, "CFBundleURLSchemes")), func(value any) bool { return value == "http" || value == "https" })
			})
			if !handlesWeb {
				continue
			}
			name, ok := plist["CFBundleDisplayName"].(string)
			if !ok {
				name, ok = plist["CFBundleName"].(string)
			}
			if !ok {
				name = strings.TrimSuffix(filepath.Base(path), ".app")
			}
			found = append(found, newClaudeBrowser(path, name))
		}
	case "windows":
		const script = `$items = foreach ($root in @('HKCU:\Software\Clients\StartMenuInternet','HKLM:\Software\Clients\StartMenuInternet','HKLM:\Software\WOW6432Node\Clients\StartMenuInternet')) { Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { $c = (Get-Item ($_.PSPath + '\shell\open\command') -ErrorAction SilentlyContinue).GetValue(''); if ($c -match '^\s*"([^"]+\.exe)"' -or $c -match '^\s*(.+?\.exe)(?:\s|$)') { $p = [Environment]::ExpandEnvironmentVariables($Matches[1]); if (Test-Path -LiteralPath $p) { @{ name = $_.GetValue(''); path = $p } } } } }; ConvertTo-Json -InputObject @($items) -Compress`
		raw, err := commandOutput(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
		if err != nil {
			return nil, err
		}
		var rows []object
		if canonjson.Unmarshal([]byte(strings.TrimPrefix(raw, "\ufeff")), &rows) != nil {
			return nil, errors.New("BROWSER_DISCOVERY_FAILED: Could not read registered browsers")
		}
		for _, row := range rows {
			path, pathOK := row["path"].(string)
			name, nameOK := row["name"].(string)
			if pathOK && nameOK {
				found = append(found, newClaudeBrowser(path, name))
			}
		}
	case "linux":
		data := os.Getenv("XDG_DATA_HOME")
		if !filepath.IsAbs(data) {
			data = filepath.Join(home, ".local/share")
		}
		dirs, ok := os.LookupEnv("XDG_DATA_DIRS")
		if !ok {
			dirs = "/usr/local/share:/usr/share"
		}
		seen := map[string]bool{}
		for _, directory := range append([]string{data}, strings.Split(dirs, ":")...) {
			directory = filepath.Join(directory, "applications")
			rows, _ := os.ReadDir(directory)
			for _, row := range rows {
				file := row.Name()
				if filepath.Ext(file) != ".desktop" || seen[file] {
					continue
				}
				seen[file] = true
				path := filepath.Join(directory, file)
				raw, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				fields := map[string]string{}
				inside := false
				for _, line := range strings.Split(string(raw), "\n") {
					line = strings.TrimSuffix(line, "\r")
					if strings.HasPrefix(line, "[") {
						inside = line == "[Desktop Entry]"
					}
					if key, value, ok := strings.Cut(line, "="); inside && ok {
						fields[key] = value
					}
				}
				if fields["Hidden"] == "true" || fields["NoDisplay"] == "true" || fields["Type"] != "Application" {
					continue
				}
				if mime := strings.Split(fields["MimeType"], ";"); !slices.Contains(mime, "x-scheme-handler/https") && !slices.Contains(mime, "x-scheme-handler/http") {
					continue
				}
				if name, ok := fields["Name"]; ok {
					found = append(found, newClaudeBrowser(path, name))
				}
			}
		}
	}
	for _, browser := range slices.Clone(found) {
		var state string
		switch {
		case operatingSystem == "darwin" && home != "" && filepath.Base(browser.path) == "Google Chrome.app":
			state = filepath.Join(home, "Library/Application Support/Google/Chrome/Local State")
		case operatingSystem == "windows" && strings.EqualFold(filepath.Base(browser.path), "chrome.exe"):
			if local := os.Getenv("LOCALAPPDATA"); local != "" {
				state = filepath.Join(local, "Google/Chrome/User Data/Local State")
			}
		}
		if state == "" {
			continue
		}
		value, err := load(state)
		if err != nil {
			continue
		}
		cache := obj(field(field(value, "profile"), "info_cache"))
		for _, dir := range keys(cache) {
			if dir == "" || dir == "." || dir == ".." || strings.ContainsAny(dir, "/\\") {
				continue
			}
			name, ok := field(cache[dir], "name").(string)
			if !ok {
				name = dir
			}
			found = append(found, claudeLoginBrowser{ID: hash([]byte(browser.ID + ":" + dir)), Name: browser.Name + " · " + name, path: browser.path, profile: dir})
		}
	}
	slices.SortStableFunc(found, func(a, b claudeLoginBrowser) int { return strings.Compare(a.Name, b.Name) })
	return slices.CompactFunc(found, func(a, b claudeLoginBrowser) bool { return a.ID == b.ID }), nil
}

func openClaudeLoginBrowser(browser *claudeLoginBrowser, target string) error {
	parsed, err := url.Parse(target)
	if err != nil || claudeAuthorizationURL(target) == "" &&
		!(parsed.Scheme == "https" && strings.EqualFold(parsed.Hostname(), "auth.openai.com") && parsed.User == nil && (parsed.Port() == "" || parsed.Port() == "443")) {
		return errors.New("INVALID_LOGIN_URL")
	}
	ctx := context.Background()
	var cmd *exec.Cmd
	switch operatingSystem {
	case "darwin":
		switch {
		case browser == nil:
			cmd = nativeCommand(ctx, "/usr/bin/open", target)
		case browser.profile != "":
			cmd = nativeCommand(ctx, filepath.Join(browser.path, "Contents/MacOS/Google Chrome"), "--profile-directory="+browser.profile, target)
		default:
			cmd = nativeCommand(ctx, "/usr/bin/open", "-a", browser.path, target)
		}
	case "windows":
		switch {
		case browser == nil:
			cmd = nativeCommand(ctx, "rundll32.exe", "url.dll,FileProtocolHandler", target)
		case browser.profile != "":
			cmd = nativeCommand(ctx, browser.path, "--profile-directory="+browser.profile, target)
		default:
			cmd = nativeCommand(ctx, browser.path, target)
		}
	default:
		if browser == nil {
			cmd = nativeCommand(ctx, "xdg-open", target)
		} else {
			cmd = nativeCommand(ctx, "gio", "launch", browser.path, target)
		}
	}
	browserError := errors.New("BROWSER_OPEN_FAILED: Copy the login link and open it in your browser")
	if cmd.Start() != nil {
		return browserError
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(700 * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-done:
		if err != nil {
			return browserError
		}
	case <-timer.C:
	}
	return nil
}
