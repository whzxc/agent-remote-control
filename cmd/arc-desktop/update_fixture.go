//go:build arcfixture

package main

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

var updateFixtureHome string

func initUpdateFixture() error {
	if !isUpdateFixture() {
		return nil
	}
	if bundleID == productionID || !filepath.IsAbs(updateFixtureHome) ||
		!strings.HasPrefix(filepath.Base(updateFixtureHome), "arc-godev-home") {
		return errors.New("Update fixtures require an isolated development bundle and home")
	}
	return os.Setenv("HOME", updateFixtureHome)
}

func isUpdateFixture() bool { return updateFixtureHome != "" }

func updateFixtureURL(u *url.URL) bool {
	base, err := url.Parse(updateBase)
	return isUpdateFixture() && err == nil && u.Scheme == "http" &&
		u.Hostname() == "127.0.0.1" && u.Port() != "" && u.Host == base.Host && base.Scheme == u.Scheme
}
