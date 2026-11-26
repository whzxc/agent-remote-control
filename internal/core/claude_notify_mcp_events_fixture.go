//go:build arcfixture

package core

import (
	"net/url"
	"os"
)

func init() {
	notificationFixtureCallback = func(u *url.URL) bool {
		return u.Scheme == "http" && u.Hostname() == "127.0.0.1" && os.Getenv("ARC_FIXTURE_WEBHOOK") == u.String()
	}
}
