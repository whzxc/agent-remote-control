package core

import (
	"errors"
	"regexp"
)

var relayFingerprint = regexp.MustCompile("^[0-9a-f]{64}$")

func relayValidateConfig(config object) error {
	if _, err := relayOrigin(text(config, "relayUrl")); err != nil {
		return err
	}
	if !relayFingerprint.MatchString(text(config, "relayInstanceId")) {
		return errors.New("Invalid relay instance id")
	}
	return nil
}
