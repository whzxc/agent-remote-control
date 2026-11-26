package core

import "strings"

func deviceTransferErrorCode(message string) string {
	var parsed object
	if strings.HasPrefix(message, "{") {
		_ = decodeObject([]byte(message), &parsed)
	}
	for _, code := range []string{
		"INVALID_PATH", "INVALID_REQUEST_ID", "REQUEST_ID_CONFLICT", "PERMISSION_REQUIRED",
		"DESTINATION_EXISTS", "SHA256_MISMATCH", "OFFSET_MISMATCH", "SOURCE_CHANGED", "TRANSFER_CORRUPT",
		"TRANSFER_TERMINAL", "TRANSFER_CANCEL_PENDING", "INSUFFICIENT_DISK_SPACE",
	} {
		if strings.HasPrefix(message, code) || parsed["code"] == code {
			return code
		}
	}
	return ""
}

func init() {
	registerOwnedErrorClassifier(deviceTransferErrorCode, func(code, message string, parsed object) object {
		if parsed != nil {
			return parsed
		}
		return object{"code": code, "message": message, "next": object{"via": "query", "op": "guide", "args": object{}}}
	})
}
