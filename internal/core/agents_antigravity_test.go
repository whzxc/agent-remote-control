package core

import (
	"slices"
	"strings"
	"testing"
)

func TestAntigravityConfigurationSurvivesPolicyChange(t *testing.T) {
	// Recurring bug class: persistence recorded launch choices survive later policy changes.
	policy := object{"model": "policy-model", "options": object{"effort": "low", "mode": "auto"}}
	inherited := object{"model": "created-model", "options": object{"effort": "high", "mode": "plan"}}
	got, err := nativeAntigravityConfiguration(object{}, policy, inherited)
	if err != nil || wire(got) != wire(inherited) {
		t.Fatalf("inherited configuration = %s, %v", wire(got), err)
	}
	got, err = nativeAntigravityConfiguration(object{"model": "requested-model", "options": object{"effort": "max"}}, policy, inherited)
	if err != nil || got["model"] != "requested-model" || field(got["options"], "effort") != "max" || field(got["options"], "mode") != "plan" {
		t.Fatalf("explicit configuration = %s, %v", wire(got), err)
	}
	native, err := nativeAntigravityConfiguration(object{}, object{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := nativeAntigravityConfiguration(object{}, policy, native)
	if err != nil || wire(native) != wire(retained) {
		t.Fatalf("retained native defaults = %s, %v", wire(retained), err)
	}
	_, err = nativeAntigravityConfiguration(object{}, object{"denyModels": []any{"policy-model"}}, native)
	if err == nil || !strings.HasPrefix(err.Error(), "DISPATCH_CONFIGURATION_UNKNOWN:") {
		t.Fatalf("restricted inherited model = %v", err)
	}
}

func TestAntigravityLaunchKeepsApprovalExplicit(t *testing.T) {
	// Contract: only bypass approval supplies the dangerous permission flag.
	driver, _ := nativeAgentDriverByID("antigravity")
	task := object{"configured": object{"model": "native", "options": object{"effort": "low", "mode": "accept-edits"}}}
	for _, approval := range []string{"approved", "bypass"} {
		task["approval"] = approval
		args, err := driver.launchArguments(task, false)
		if err != nil || slices.Contains(args, "--dangerously-skip-permissions") != (approval == "bypass") {
			t.Fatalf("%s launch = %q, %v", approval, args, err)
		}
	}
}
