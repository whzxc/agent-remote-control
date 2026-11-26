package core

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

var externalInputsLock sync.Mutex

func externalInputPath(thread string) string {
	return filepath.Join(root(), "external-inputs", hash([]byte(thread))+".json")
}

func loadExternalInputs(thread string) (object, error) {
	value, err := cachedLoad(externalInputPath(thread))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if row := obj(value); row != nil {
		return clone(row), nil
	}
	return nil, nil
}

func externalInputText(parts any) string {
	texts := []string{}
	for _, part := range arr(parts) {
		if text, known := field(part, "text").(string); known {
			texts = append(texts, text)
		}
	}
	return strings.Join(texts, "\n")
}

func nativeInputContent(item any) (string, bool) {
	switch text(item, "type") {
	case "userMessage":
		return externalInputText(field(item, "content")), true
	case "steeringUserMessage":
		if field(item, "status") == "accepted" {
			return externalInputText(field(item, "input")), true
		}
	}
	return "", false
}

func externalInputKey(turn, item any, index int) string {
	key, present := obj(item)["id"]
	if !present {
		key = index
	}
	return wire([]any{field(turn, "id"), key})
}

func beginExternalInput(thread string, turns []any, input, turn any) (string, error) {
	externalInputsLock.Lock()
	defer externalInputsLock.Unlock()
	state, err := loadExternalInputs(thread)
	if err != nil {
		return "", err
	}
	if state == nil {
		seen := object{}
		for _, turn := range turns {
			for index, item := range arr(field(turn, "items")) {
				if _, ok := nativeInputContent(item); ok {
					seen[externalInputKey(turn, item, index)] = true
				}
			}
		}
		state = object{"seen": seen, "submissions": []any{}, "inputs": []any{}, "pending": object{}, "responses": object{}}
	}
	token := id()
	state["submissions"] = append(arr(state["submissions"]), object{"id": token, "hash": hash([]byte(externalInputText(input))), "turnId": turn, "at": now()})
	if err := save(externalInputPath(thread), state); err != nil {
		return "", err
	}
	return token, nil
}

func finishExternalInput(thread, token string, result any, submission error) error {
	externalInputsLock.Lock()
	defer externalInputsLock.Unlock()
	state, err := loadExternalInputs(thread)
	if err != nil {
		return err
	}
	submissions := arr(state["submissions"])
	if submissions == nil {
		return errors.New("INPUT_PROVENANCE_MISSING")
	}
	for index, value := range submissions {
		if field(value, "id") != token {
			continue
		}
		switch {
		case submission == nil:
			turn, found := field(field(result, "turn"), "id").(string)
			if !found {
				turn, found = field(result, "turnId").(string)
			}
			if found {
				obj(value)["turnId"] = turn
			}
		case !strings.HasPrefix(submission.Error(), "SUBMISSION_UNCONFIRMED:"):
			state["submissions"] = slices.Delete(submissions, index, index+1)
		}
		break
	}
	return save(externalInputPath(thread), state)
}

func noteExternalResponse(thread string, request object, responseFailure error) error {
	if responseFailure != nil && strings.HasPrefix(responseFailure.Error(), "SUBMISSION_UNCONFIRMED:") {
		return nil
	}
	externalInputsLock.Lock()
	defer externalInputsLock.Unlock()
	state, err := loadExternalInputs(thread)
	if err != nil || state == nil {
		return err
	}
	responses := obj(state["responses"])
	if responses == nil {
		responses = object{}
		state["responses"] = responses
	}
	key := wire(request["id"])
	if responseFailure == nil {
		responses[key] = true
	} else {
		delete(responses, key)
	}
	return save(externalInputPath(thread), state)
}

const externalQuestionOpen = "<send_user_message_question_reply>"
const externalQuestionClose = "</send_user_message_question_reply>"

func identifyExternalAnswer(content string, turns []any) any {
	body, opened := strings.CutPrefix(strings.TrimSpace(content), externalQuestionOpen)
	body, closed := strings.CutSuffix(body, externalQuestionClose)
	if !opened || !closed {
		return nil
	}
	var reply any
	if unmarshalJSON([]byte(body), &reply) != nil {
		return nil
	}
	if rows := arr(reply); len(rows) > 0 {
		reply = rows[0]
	}
	var question []any
	if id, found := field(reply, "questionItemId").(string); !found || unmarshalJSON([]byte(id), &question) != nil || len(question) < 2 {
		return nil
	}
	wanted := wire(question[1])
	for _, turn := range turns {
		if slices.ContainsFunc(arr(field(turn, "items")), func(item any) bool { return wire(field(item, "id")) == wanted }) {
			return field(turn, "id")
		}
	}
	return nil
}

// A complete owner snapshot can confirm resolution without exposing an answer.
func observeExternalInputs(thread string, turns []any, pending []object) error {
	externalInputsLock.Lock()
	defer externalInputsLock.Unlock()
	state, err := loadExternalInputs(thread)
	if err != nil || state == nil {
		return err
	}
	before := wire(state)
	seen := obj(state["seen"])
	if seen == nil {
		seen = object{}
		state["seen"] = seen
	}
	inputs := arr(state["inputs"])
	for _, turn := range turns {
		for index, item := range arr(field(turn, "items")) {
			content, ok := nativeInputContent(item)
			if !ok {
				continue
			}
			key := externalInputKey(turn, item, index)
			if _, examined := seen[key]; examined {
				continue
			}
			turnID, digest := field(turn, "id"), hash([]byte(content))
			submissions := arr(state["submissions"])
			own := slices.IndexFunc(submissions, func(row any) bool {
				return field(row, "hash") == digest && (field(row, "turnId") == nil || wire(field(row, "turnId")) == wire(turnID))
			})
			seen[key] = true
			if own != -1 {
				state["submissions"] = slices.Delete(submissions, own, own+1)
				continue
			}
			kind := "userMessage"
			if strings.Contains(content, externalQuestionOpen) {
				kind = "interactionResponse"
			}
			observed := now()
			timestamp, present := obj(item)["createdAt"]
			if !present {
				timestamp, present = obj(item)["timestamp"]
			}
			timeSource := "native"
			if !present {
				timestamp, timeSource = observed, "first-observed"
			}
			excerpt := runeExcerpt(content, 1000)
			inputs = append(inputs, object{"kind": kind, "turnId": turnID, "answeredTurnId": identifyExternalAnswer(content, turns),
				"itemId": field(item, "id"), "text": excerpt, "truncated": excerpt != content, "timestamp": timestamp,
				"timeSource": timeSource, "observedAt": observed})
		}
	}
	if pending != nil {
		previous, current := obj(state["pending"]), object{}
		for _, request := range pending {
			current[wire(request["id"])] = request
		}
		for _, key := range keys(previous) {
			request := previous[key]
			if _, unresolved := current[key]; unresolved {
				continue
			}
			if _, responded := obj(state["responses"])[key]; !responded {
				inputs = append(inputs, object{"kind": "interactionResolved", "turnId": field(field(request, "params"), "turnId"),
					"requestId": field(request, "id"), "method": field(request, "method"),
					"text":      "Native interaction resolved outside ARC; answer/decision unavailable.",
					"timestamp": now(), "timeSource": "first-observed", "outcome": "unknown"})
			}
		}
		state["pending"] = current
	}
	state["inputs"] = inputs
	if before != wire(state) {
		return save(externalInputPath(thread), state)
	}
	return nil
}

func externalUserInputs(thread string, turn *string) ([]any, error) {
	externalInputsLock.Lock()
	defer externalInputsLock.Unlock()
	state, err := loadExternalInputs(thread)
	if err != nil {
		return nil, err
	}
	result := []any{}
	for _, input := range arr(state["inputs"]) {
		if turn == nil || field(input, "turnId") == *turn || field(input, "answeredTurnId") == *turn {
			result = append(result, input)
		}
	}
	return result, nil
}
