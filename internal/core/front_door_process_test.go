package core

import (
	"bytes"
	"reflect"
	"testing"
)

func TestPrivateHelloFrameRoundTrip(t *testing.T) {
	// Contract: v3 IPC frames carry serde-compatible generation bytes and preserve the negotiated limits.
	value := frontDoorHello{Version: frontDoorVersion, Generation: generation{7}, Readiness: "Ready", MaxRequestBytes: maxRequestBytes, MaxFrameBytes: maxFrameBytes}
	var stream bytes.Buffer
	if err := writeFrame(&stream, value); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stream.Bytes(), []byte(`"generation":[7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]`)) {
		t.Fatalf("generation is not a byte array: %s", stream.Bytes())
	}
	var decoded frontDoorHello
	if err := readFrame(&stream, 4096, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, value) {
		t.Fatalf("hello = %+v, want %+v", decoded, value)
	}
}
