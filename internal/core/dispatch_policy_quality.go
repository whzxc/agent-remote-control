package core

import (
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"strconv"
	"time"
)

const dispatchHistoryLimit = 4096
const dispatchReviewLimit = 32

func dispatchNumber(value any) (float64, bool) {
	switch n := value.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	case float32:
		return float64(n), true
	default:
		integer, ok := uintValue(value)
		return float64(integer), ok
	}
}

func dispatchQualityCount(value any) (uint64, bool) {
	if integer, ok := uintValue(value); ok {
		return integer, true
	}
	if f, ok := dispatchNumber(value); ok && f >= 0 && f < math.Exp2(64) && math.Trunc(f) == f {
		return uint64(f), true
	}
	return 0, false
}

func dispatchDefectClassTotal(classes object) (uint64, bool) {
	var total uint64
	for _, value := range classes {
		n, ok := dispatchQualityCount(value)
		if !ok || math.MaxUint64-total < n {
			return 0, false
		}
		total += n
	}
	return total, true
}

func validateDispatchDefectClasses(op string, args object) error {
	if classes := obj(args["defectClasses"]); classes != nil {
		n, ok := dispatchDefectClassTotal(classes)
		if !ok {
			return dispatchObjectError(invalidArguments(op, "/defectClasses", "The sum of class counts must fit an unsigned 64-bit integer."))
		}
		if value, present := args["defects"]; present {
			if count, ok := dispatchQualityCount(value); !ok || count != n {
				return dispatchObjectError(invalidArguments(op, "/defectClasses", "The class counts must sum to defects."))
			}
		}
	}
	return nil
}

var legacyDispatchFindings = regexp.MustCompile(`^found-by: (controller|acceptance|ci|user); defects: ([0-9]+); advisory: ([0-9]+)(?:;|[\p{Z}\x09-\x0d\x{85}]|$)`)

func normalizeDispatchReview(review object, legacy bool) {
	if uintOr(review["qualityVersion"], 0) == 1 {
		return
	}
	if legacy {
		review["foundBy"] = "unknown"
		if m := legacyDispatchFindings.FindStringSubmatch(text(review, "note")); len(m) != 0 {
			defects, de := strconv.ParseUint(m[2], 10, 64)
			advisory, ae := strconv.ParseUint(m[3], 10, 64)
			if de == nil && ae == nil {
				by := m[1]
				if by == "ci" {
					by = "automation"
				}
				review["foundBy"], review["defects"], review["advisory"] = by, defects, advisory
			}
		}
	} else {
		omitted := review["foundBy"] == nil
		if omitted {
			review["foundBy"] = "unknown"
		}
		if classes := obj(review["defectClasses"]); classes != nil {
			if n, ok := dispatchDefectClassTotal(classes); ok {
				review["defects"] = n
			}
		}
		if omitted && review["verdict"] == "pass" && review["defects"] == nil {
			review["defects"] = 0
		}
	}
	review["qualityVersion"] = 1
}

func importDispatchReview(row object) bool {
	review := obj(row["review"])
	if review == nil || uintOr(review["qualityVersion"], 0) == 1 {
		return false
	}
	normalizeDispatchReview(review, true)
	return true
}

func dispatchReviewObservations(row object) []any {
	observations := slices.Clone(arr(row["reviewObservations"]))
	if current := obj(row["review"]); current != nil {
		if prior := wire(current); !slices.ContainsFunc(observations, func(r any) bool { return wire(r) == prior }) {
			observations = append(observations, current)
		}
	}
	return observations
}

func attachDispatchReview(row, review object) {
	importDispatchReview(row)
	observations := dispatchReviewObservations(row)
	if !slices.ContainsFunc(observations, func(v any) bool {
		return field(v, "requestId") == review["requestId"] && field(v, "reviewedAt") == review["reviewedAt"]
	}) {
		observations = append(observations, clone(review))
	}
	if len(observations) > dispatchReviewLimit {
		observations = observations[len(observations)-dispatchReviewLimit:]
		row["reviewHistoryGap"] = true
	}
	row["reviewObservations"], row["review"] = observations, clone(review)
}

type dispatchFindings struct {
	reviews, defects, advisory, unknown uint64
	overflow                            bool
}

func addDispatchCount(bucket *uint64, n uint64, overflow *bool) {
	if math.MaxUint64-*bucket < n {
		*bucket, *overflow = math.MaxUint64, true
		return
	}
	*bucket += n
}

func (f *dispatchFindings) add(row object) {
	f.reviews++
	defects, d := uintValue(row["defects"])
	advisory, a := uintValue(row["advisory"])
	addDispatchCount(&f.defects, defects, &f.overflow)
	addDispatchCount(&f.advisory, advisory, &f.overflow)
	if !d || !a {
		f.unknown++
	}
}

func (f dispatchFindings) value() object {
	coverage := "exact"
	switch {
	case f.overflow:
		coverage = "bounded"
	case f.unknown == 0:
	case f.unknown == f.reviews:
		coverage = "unknown"
	default:
		coverage = "bounded"
	}
	return object{"reviews": f.reviews, "defects": f.defects, "advisory": f.advisory, "unknownCounts": f.unknown, "coverage": coverage}
}

type dispatchDefectClasses struct {
	counts                        map[string]uint64
	complete, incomplete, missing uint64
	overflow                      bool
}

func (c *dispatchDefectClasses) add(key string, amount uint64) {
	n := c.counts[key]
	addDispatchCount(&n, amount, &c.overflow)
	c.counts[key] = n
}

func (c *dispatchDefectClasses) observe(review object) {
	if classes := obj(review["defectClasses"]); classes != nil {
		for key, value := range classes {
			n, _ := dispatchQualityCount(value)
			c.add(key, n)
		}
		c.complete++
		return
	}
	n, known := dispatchQualityCount(review["defects"])
	switch {
	case !known:
		c.incomplete++
		c.missing++
	case n == 0:
		c.complete++
	default:
		c.incomplete++
		c.add("unclassified", n)
	}
}

func dispatchRowAgent(row object) string {
	if agent, ok := row["agent"].(string); ok {
		return agent
	}
	return "codex"
}

func dispatchQualityHistory(rows []object, agent string, cutoff time.Time) object {
	reviewers := make(map[string]*dispatchFindings)
	triggers := map[string]uint64{"unknown": 0}
	classes := dispatchDefectClasses{counts: map[string]uint64{"unclassified": 0}}
	var users, external dispatchFindings
	legacyThreads, seen := make(map[string]bool), make(map[[2]string]bool)
	var selfTests, reviewed, unreviewed, completed, running, unknown, immature, mature, missingTime, unknownMaturity, unknownRunning int
	gap := len(rows) > dispatchHistoryLimit
	for _, row := range rows[:min(len(rows), dispatchHistoryLimit)] {
		if dispatchRowAgent(row) != agent {
			continue
		}
		isExternal := row["dispatchOrigin"] == "external"
		at, err := dispatchHistoryTime(row)
		if err != nil {
			missingTime++
			continue
		}
		key := [2]string{text(row, "threadId"), text(row, "turnId")}
		if at.Before(cutoff) || !isExternal && (row["dispatchMode"] != "new-turn" || agent != "codex" && row["submission"] != "accepted") || seen[key] {
			continue
		}
		seen[key] = true
		if row["purpose"] == "self-test" {
			selfTests++
			continue
		}
		if !isExternal {
			switch row["operation"] {
			case "send", "agent_send":
				triggers[str(dispatchSendTrigger(row))]++
			case nil:
				if row["dispatchSource"] != "native-retry" {
					if legacyThreads[key[0]] {
						triggers["unknown"]++
					}
					legacyThreads[key[0]] = true
				}
			}
			hasReview := obj(row["review"]) != nil
			if hasReview {
				reviewed++
			} else {
				unreviewed++
			}
			state, _ := dispatchRecordTransition(row).wait()
			switch state {
			case waitCompleted:
				if !hasReview {
					completed++
				}
			case waitFailed, waitCancelled:
			case waitRunning, waitInteraction:
				running++
			default:
				unknown++
				if row["terminal"] == nil {
					running++
					unknownRunning++
				}
			}
			if end, err := time.Parse(time.RFC3339Nano, text(row["terminal"], "endedAt")); err != nil {
				unknownMaturity++
			} else if end.After(cutoff.Add(16 * 24 * time.Hour)) {
				immature++
			} else {
				mature++
			}
		}
		observations := dispatchReviewObservations(row)
		gap = gap || row["reviewHistoryGap"] == true || len(observations) > dispatchReviewLimit
		for _, item := range observations[max(0, len(observations)-dispatchReviewLimit):] {
			review := clone(obj(item))
			if review == nil {
				continue
			}
			normalizeDispatchReview(review, true)
			classes.observe(review)
			if isExternal {
				external.add(review)
			} else if by := text(review, "foundBy"); by == "user" {
				users.add(review)
			} else {
				if reviewers[by] == nil {
					reviewers[by] = &dispatchFindings{}
				}
				reviewers[by].add(review)
			}
		}
	}
	coverage := func(missing, evidence, truncated bool) string {
		if missingTime > 0 || missing && !evidence {
			return "unknown"
		}
		if missing || truncated {
			return "bounded"
		}
		return "exact"
	}
	bounded := "exact"
	if gap {
		bounded = "bounded"
	}
	runningCoverage := bounded
	if unknownRunning != 0 {
		runningCoverage = "unknown"
	}
	findings := object{}
	for by, v := range reviewers {
		result := v.value()
		if gap {
			result["coverage"] = "bounded"
		}
		findings[by] = result
	}
	userFindings := users.value()
	if gap {
		userFindings["coverage"] = "bounded"
	}
	return object{"reviewerFindings": findings,
		"followUpTurnsByTrigger": object{"counts": triggers, "coverage": coverage(triggers["unknown"] > 0 || len(legacyThreads) > 0, len(triggers) > 1, len(rows) > dispatchHistoryLimit)},
		"defectsByClass":         object{"counts": classes.counts, "unknownCounts": classes.missing, "coverage": coverage(classes.incomplete > 0, classes.complete > 0, gap || classes.overflow)},
		"laterUserFindings":      userFindings, "unreviewedCompletions": object{"count": completed, "coverage": bounded},
		"stillRunning": object{"count": running, "unconfirmed": unknownRunning, "coverage": runningCoverage}, "executionUnknown": unknown,
		"reviewCoverage":  object{"reviewed": reviewed, "unreviewed": unreviewed, "coverage": bounded},
		"externalReviews": external.value(), "selfTests": object{"count": selfTests, "coverage": "exact"},
		"maturity":           object{"windowDays": 14, "immature": immature, "mature": mature, "unknown": unknownMaturity},
		"historyUnknownRows": missingTime, "coverage": coverage(false, true, gap),
		"interpretation": "Reported finding observations only. A pass is a review verdict; defect absence is unknown."}
}

func init() { authorizeReviewDefects = validateDispatchDefectClasses }
