//go:build !windows

package platform

func NormalizeSocketError(err error) error { return err }
