//go:build !arcfixture

package main

import "net/url"

func initUpdateFixture() error       { return nil }
func isUpdateFixture() bool          { return false }
func updateFixtureURL(*url.URL) bool { return false }
