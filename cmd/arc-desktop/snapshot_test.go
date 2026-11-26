package main

import "testing"

func TestSnapshotRendererReplyStaysWithItsCapture(t *testing.T) {
	// Recurring bug class: concurrency a late renderer acknowledgement must not complete a newer Desktop capture.
	replies := make(chan snapshotReply, 1)
	state := snapshotState{id: "current", pending: replies}
	state.acknowledge("previous", object{"layoutSettled": false}, "")
	select {
	case reply := <-replies:
		t.Fatalf("stale acknowledgement reached the current capture: %v", reply.model)
	default:
	}
	state.acknowledge("current", object{"layoutSettled": true}, "")
	select {
	case reply := <-replies:
		if reply.err != nil || objectValue(reply.model)["layoutSettled"] != true {
			t.Fatalf("current capture received %v, %v", reply.model, reply.err)
		}
	default:
		t.Fatal("matching renderer acknowledgement did not reach the capture")
	}
}
