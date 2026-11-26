package core

import "testing"

func TestTrackedTranscriptInputRespectsExplicitPromptOrigin(t *testing.T) {
	// Contract: transcript input keeps actual user prompts and omits harness-only messages.
	for _, sample := range []struct {
		record any
		body   string
		want   string
	}{
		{object{"message": object{"source": object{"kind": "subagent-notification"}}}, "Background result", ""},
		{object{}, "<task-id>child</task-id><output-file>log</output-file>", ""},
		{object{"payload": object{"promptSource": "human"}}, "<system-reminder>ignore</system-reminder>\n<command-name>literal</command-name>", "<command-name>literal</command-name>"},
	} {
		if got := trackedTranscriptUserText(sample.record, sample.body); got != sample.want {
			t.Errorf("transcript input = %q, want %q", got, sample.want)
		}
	}
}
