package core

import "unicode/utf8"

func contextExcerpt(raw string) object {
	end := min(len(raw), 1024)
	for end < len(raw) && !utf8.RuneStart(raw[end]) {
		end--
	}
	excerpt := raw[:end]
	return object{"state": "available", "text": excerpt, "truncated": end < len(raw), "sha256": hash([]byte(excerpt)), "hashScope": "excerpt"}
}
