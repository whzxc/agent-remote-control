//go:build !windows

package platform

import "time"

func StartElapsed() func() time.Duration {
	started := time.Now()
	return func() time.Duration { return time.Since(started) }
}
