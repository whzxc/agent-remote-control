package core

import (
	"errors"
	"slices"
	"strings"
)

type axQueueReport struct{ kind, text string }

func axQueueRows(data string) []axQueueReport {
	section := ""
	var rows []axQueueReport
	for _, line := range strings.Split(data, "\n") {
		heading := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
		switch {
		case strings.HasPrefix(heading, "AX frictions"), strings.HasPrefix(heading, "Follow-ups"):
			section = "friction"
			continue
		case strings.HasPrefix(heading, "Backlog ideas"):
			section = "idea"
			continue
		case strings.HasPrefix(line, "#"), heading != "" && !strings.HasPrefix(line, "-") && strings.HasSuffix(heading, ":"):
			section = ""
		}
		if body, ok := strings.CutPrefix(line, "- "); ok && section != "" {
			rows = append(rows, axQueueReport{section, strings.TrimSpace(body)})
		}
	}
	return rows
}

func (store *axStore) importQueue(data string, ms int64) (object, error) {
	rows := axQueueRows(data)
	if len(rows) > 1000 {
		return nil, errors.New("COORDINATION_CAPACITY: too many queue entries")
	}
	store.prune(ms)
	actor := object{"type": "local-authority"}
	imported, unchanged := 0, 0
	entries := []object{}
	for _, row := range rows {
		stable := "import-" + hash([]byte(wire([]any{row.kind, axTokens(row.text)})))
		var severity any
		if row.kind == "friction" {
			severity = "workaround"
		}
		report := object{"id": stable, "requestId": stable, "kind": row.kind, "severity": severity, "symptom": axClip(row.text, 500),
			"expected": "Review this reported friction or desired outcome before implementation", "reproductionHints": axClip(row.text, 1000), "queueReport": row.text}
		request := "import-" + hash([]byte(wire(report)))
		report["requestId"] = request
		if e := store.data.Entries[stable]; e != nil {
			if slices.Contains(e.Applied, request) {
				unchanged++
				entries = append(entries, e.projection(actor))
				continue
			}
			e.Applied = axSet(e.Applied, request)
			e.record("import-updated", actor, object{"reportedOnly": true, "queueReport": row.text}, ms)
			e.observe("ax.changed")
		} else {
			evidence := []object{{"kind": "import", "reportedOnly": true, "provisionalSeverity": true, "observedAt": nil, "coreBuild": nil, "queueReport": row.text}}
			if _, err := store.report(report, actor, evidence, ms, stable); err != nil {
				return nil, err
			}
		}
		imported++
		if e := store.data.Entries[stable]; e != nil {
			entries = append(entries, e.projection(actor))
		}
	}
	if imported > 0 {
		store.data.Revision++
	}
	return object{"imported": imported, "unchanged": unchanged, "entries": entries, "queueModified": false}, store.save()
}
