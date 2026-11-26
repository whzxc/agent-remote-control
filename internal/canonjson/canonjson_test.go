package canonjson_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

func TestSerdeJSONValue(t *testing.T) {
	// Contract: JSON bytes used in ARC digests match serde_json::Value.
	data, err := os.ReadFile("testdata/serde-json.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input  string
		Output string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		var value any
		if err := canonjson.Unmarshal([]byte(tc.Input), &value); err != nil {
			t.Fatalf("%s: %v", tc.Input, err)
		}
		got, err := canonjson.Marshal(value)
		if err != nil || string(got) != tc.Output {
			t.Errorf("%s: got %q (%v), want %q", tc.Input, got, err, tc.Output)
		}
	}
}

func TestSerdeJSONStruct(t *testing.T) {
	// Contract: JSON bytes used in ARC digests preserve serialized struct field order.
	value := struct {
		Z float64        `json:"z"`
		A map[string]int `json:"a"`
	}{Z: 1.0, A: map[string]int{"y": 2, "a": 1}}
	want, err := os.ReadFile("testdata/serde-json-struct.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := canonjson.Marshal(value)
	if err != nil || string(got)+"\n" != string(want) {
		t.Errorf("got %q (%v), want %q", got, err, want)
	}
}
