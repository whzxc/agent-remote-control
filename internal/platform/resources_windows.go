package platform

import "errors"

func NoFileLimits() (uint64, uint64, error)       { return 0, 0, nil }
func SetNoFileLimit(uint64, uint64) error         { return nil }
func NoFileUnlimited(uint64) bool                 { return false }
func NoFileCeiling() (uint64, error)              { return 0, nil }
func ChildFileLimits(int) (uint64, uint64, error) { return 0, 0, nil }
func DescriptorCount(int) (uint64, error) {
	return 0, errors.New("fd sampling is not applicable on this platform")
}
