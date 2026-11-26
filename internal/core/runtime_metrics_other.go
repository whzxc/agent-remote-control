//go:build !darwin && !linux && !windows

package core

import "errors"

func runtimeProcessMetrics() object {
	return runtimeProcessUnavailable(errors.New("Process diagnostics unavailable"))
}
