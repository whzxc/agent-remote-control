package core

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTaskHostCommandSpecUsesOrdinaryStrings(t *testing.T) {
	// Recurring bug class: persistence command arguments with spaces and environment-map keys use plain JSON strings.
	command := exec.Command("fixture-agent", "--mode", "rpc")
	command.Env = []string{"FIXTURE_VALUE=with spaces"}
	spec, err := taskHostCommandSpec(command)
	if err != nil {
		t.Fatal(err)
	}
	if spec["program"] != "fixture-agent" || wire(spec["args"]) != `["--mode","rpc"]` || wire(spec["env"]) != `{"FIXTURE_VALUE":"with spaces"}` {
		t.Fatal(wire(spec))
	}
}

func TestTaskHostProtocolRejectsUnknownVersions(t *testing.T) {
	// Contract: the newline-JSON task-host handshake negotiates protocol 1 before processing a command.
	state := &taskHostProcess{}
	for _, version := range []int{1, 2} {
		client, host := net.Pipe()
		if err := client.SetDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			serveTaskHostConnection(host, state)
		}()
		if err := outputLine(client, wire(object{"protocol": version})); err != nil {
			t.Fatal(err)
		}
		input := bufio.NewReader(client)
		hello, err := taskHostReceive(input)
		if err != nil || taskHostHandshake(hello) != nil {
			t.Fatalf("invalid server greeting: %v %v", hello, err)
		}
		err = outputLine(client, wire(object{"op": "status"}))
		if version == 1 {
			if err != nil {
				t.Fatal(err)
			}
			status, err := taskHostReceive(input)
			if err != nil || uintOr(status["protocol"], 0) != 1 {
				t.Fatalf("status: %v %v", status, err)
			}
		} else if err == nil {
			if response, err := taskHostReceive(input); err == nil {
				t.Fatalf("unknown version received a command response: %s", wire(response))
			}
		}
		_ = client.Close()
		<-done
	}
}

func TestTaskHostJournalResumesAfterAcknowledgedOffset(t *testing.T) {
	// Contract: journal replay returns increasing sequence offsets and excludes acknowledged records.
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	journal, err := openTaskHostJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		kind  string
		value any
	}{{"stdout", "first"}, {"write", object{"sequence": 1, "value": object{"id": "string-id"}}}, {"stdout", "last"}} {
		if err := journal.append(row.kind, row.value); err != nil {
			t.Fatal(err)
		}
	}
	var reader taskHostJournalReader
	result, err := reader.read(t.Context(), path, 1)
	if err != nil || len(result) != 2 || uintOr(result[0]["offset"], 0) != 2 || uintOr(result[1]["offset"], 0) != 3 {
		t.Fatalf("replay: %v %v", result, err)
	}
	if next, err := reader.read(t.Context(), path, 3); err != nil || len(next) != 0 {
		t.Fatalf("acknowledged replay: %v %v", next, err)
	}
}

type taskHostTestInput struct{ bytes.Buffer }

func (*taskHostTestInput) Close() error { return nil }

func TestTaskHostWriteAcknowledgesDuplicatesWithoutRepeatingInput(t *testing.T) {
	// Contract: v1 sequences acknowledge duplicates without repeating the Agent stdin write and reject gaps.
	journal, err := openTaskHostJournal(filepath.Join(t.TempDir(), "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	input := &taskHostTestInput{}
	process := taskHostProcess{journal: journal, input: input}
	for _, sequence := range []int{1, 1, 3, 2, 1} {
		reply, err := process.command(context.Background(), object{"op": "write", "sequence": sequence, "frame": object{"id": sequence}})
		if sequence == 3 {
			if err == nil || !strings.HasPrefix(err.Error(), "TASK_HOST_WRITE_GAP:") {
				t.Fatalf("sequence 3: %v", err)
			}
		} else if err != nil || uintOr(reply["receivedSequence"], 0) < uint64(sequence) {
			t.Fatalf("sequence %d: %v %v", sequence, reply, err)
		}
	}
	if input.String() != "{\"id\":1}\n{\"id\":2}\n" {
		t.Fatal(input.String())
	}
}
