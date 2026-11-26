// Package canonjson encodes the JSON bytes used by ARC's Rust runtime.
package canonjson

import (
	"bytes"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"math"
	"strconv"
	"strings"
)

var numberMarshalers = jsonv2.JoinMarshalers(
	jsonv2.MarshalFunc(func(n float64) ([]byte, error) { return formatFloat(n, 64), nil }),
	jsonv2.MarshalFunc(func(n float32) ([]byte, error) { return formatFloat(float64(n), 32), nil }),
	jsonv2.MarshalFunc(formatNumber),
)

// Marshal writes object keys in byte order and struct fields in declaration order.
func Marshal(value any) ([]byte, error) {
	return jsonv2.Marshal(value, jsonv2.Deterministic(true), jsonv2.WithMarshalers(numberMarshalers),
		jsonv2.FormatNilMapAsNull(true), jsonv2.FormatNilSliceAsNull(true))
}

// Unmarshal parses JSON without rounding integers when decoding into an interface.
func Unmarshal(data []byte, dst any) error {
	if !json.Valid(data) {
		return json.Unmarshal(data, dst)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(dst)
}

func formatNumber(n json.Number) ([]byte, error) {
	s := n.String()
	if s != "-0" && !strings.ContainsAny(s, ".Ee") {
		if _, err := strconv.ParseUint(s, 10, 64); err == nil {
			return []byte(s), nil
		}
		if _, err := strconv.ParseInt(s, 10, 64); err == nil {
			return []byte(s), nil
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, err
	}
	return formatFloat(f, 64), nil
}

func formatFloat(n float64, bits int) []byte {
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return []byte("null")
	}
	s := strconv.FormatFloat(n, 'e', -1, bits)
	mantissa, exponent, _ := strings.Cut(s, "e")
	e, _ := strconv.Atoi(exponent)
	if e < -5 || e >= 16 {
		if e >= 0 {
			return []byte(mantissa + "e+" + strconv.Itoa(e))
		}
		return []byte(mantissa + "e" + strconv.Itoa(e))
	}
	s = strconv.FormatFloat(n, 'f', -1, bits)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return []byte(s)
}
