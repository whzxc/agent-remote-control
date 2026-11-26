package core

import (
	"strings"
	"testing"
)

func TestInteractionAnswerAttributionUsesExplicitOrigin(t *testing.T) {
	// Algorithmic core: answering party attribution uses the local UI ingress or a bounded source identifier.
	for _, row := range []struct {
		origin, want object
	}{
		{object{"ingressId": "local-ui", "sourceId": "local"}, object{"kind": "local-ui"}},
		{object{"sourceId": "controller", "sourceLabel": "Example"}, object{"kind": "source", "sourceId": "controller"}},
		{nil, object{"kind": "unknown"}},
		{object{"sourceLabel": "Example"}, object{"kind": "unknown"}},
		{object{"sourceId": strings.Repeat("x", 257)}, object{"kind": "unknown"}},
	} {
		if got := interactionAnsweredBy(row.origin); wire(got) != wire(row.want) {
			t.Fatalf("answering party = %v, want %v", got, row.want)
		}
	}
}

func TestProjectedInteractionAnswersKeepAttributionAndRefresh(t *testing.T) {
	// Recurring bug class: persistence timeline refresh dropped answering parties and persisted answers could remain stale.
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	ctx := withOrigin(t.Context(), object{"sourceId": "fixture-controller"})
	write := func(id string) {
		t.Helper()
		request := object{"id": id, "method": "item/commandExecution/requestApproval", "backendSession": "fixture",
			"params": object{"threadId": "thread", "turnId": "turn"}}
		if err := recordInteractionAnswer(ctx, request, object{"result": object{"decision": "accept"}}); err != nil {
			t.Fatal(err)
		}
	}
	read := func() map[string]object {
		t.Helper()
		results := map[string]object{}
		if err := projectInteractionAnswers("thread", func(request, response object) {
			results[text(request, "id")] = response
		}); err != nil {
			t.Fatal(err)
		}
		return results
	}
	write("approval")
	for range 3 {
		result := read()["approval"]
		if field(result["answeredBy"], "sourceId") != "fixture-controller" || field(result["result"], "decision") != "accept" {
			t.Fatalf("projected approval = %v", result)
		}
	}
	write("new")
	if result := read(); len(result) != 2 || field(result["new"]["result"], "decision") != "accept" {
		t.Fatalf("updated durable answers = %v", result)
	}
}
