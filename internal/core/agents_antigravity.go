package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

const antigravityDesktopProtocol = "antigravity-agentapi"

func antigravityAgentAPIBinary() string {
	if path, found := os.LookupEnv("ARC_ANTIGRAVITY_AGENTAPI"); found {
		return discoverAgentExecutable(path)
	}
	if home, err := os.UserHomeDir(); err == nil {
		if path := discoverAgentExecutable(filepath.Join(home, ".gemini", "antigravity", "bin", "agentapi")); path != "" {
			return path
		}
	}
	if operatingSystem == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			if path := discoverAgentExecutable(filepath.Join(local, "Programs", "antigravity", "resources", "bin", "language_server.exe")); path != "" {
				return path
			}
		}
	}
	if path := discoverAgentExecutable("/Applications/Antigravity.app/Contents/Resources/bin/language_server"); path != "" {
		return path
	}
	return discoverAgentExecutable("agentapi")
}

func antigravityAgentAPI(binary string) bool {
	if binary == "" {
		return false
	}
	stem := strings.TrimSuffix(filepath.Base(binary), filepath.Ext(binary))
	return stem == "agentapi" || stem == "language_server" ||
		binary == os.Getenv("ARC_ANTIGRAVITY_AGENTAPI") || binary == antigravityAgentAPIBinary()
}

func antigravityCall(ctx context.Context, binary string, args ...string) (object, error) {
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if strings.TrimSuffix(filepath.Base(binary), filepath.Ext(binary)) == "language_server" {
		args = append([]string{"agentapi"}, args...)
	}
	command := nativeCommand(wait, binary, args...)
	command.Env = append(command.Environ(), "PATH="+strings.Join(nativeAgentSearchPaths(), string(os.PathListSeparator)))
	if err := applyNativeAgentProxy(wait, command); err != nil {
		return nil, err
	}
	output, err := command.Output()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return nil, errors.New("ANTIGRAVITY_AGENTAPI_TIMEOUT")
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("ANTIGRAVITY_AGENTAPI_FAILED: %s", decodeCommandOutput(exit.Stderr))
		}
		return nil, fmt.Errorf("ANTIGRAVITY_AGENTAPI_FAILED: %w", err)
	}
	var response object
	if decodeObject(output, &response) != nil {
		return nil, errors.New("ANTIGRAVITY_AGENTAPI_INVALID_RESPONSE")
	}
	if response["error"] != nil || field(response["response"], "error") != nil {
		return nil, errors.New("ANTIGRAVITY_AGENTAPI_FAILED: " + wire(response))
	}
	return response, nil
}

func antigravityMetadata(ctx context.Context, binary, session string) (object, error) {
	if _, err := uuid.Parse(session); err != nil {
		return nil, errors.New("INVALID_ANTIGRAVITY_SESSION")
	}
	result, err := antigravityCall(ctx, binary, "get-conversation-metadata", session)
	if err != nil {
		return nil, errors.New("CLAUDE_SESSION_NOT_FOUND: Antigravity conversation metadata unavailable")
	}
	item := obj(field(result["response"], "conversationMetadata"))
	if obj(item["metadata"]) == nil {
		return nil, errors.New("CLAUDE_SESSION_NOT_FOUND: Antigravity conversation metadata missing")
	}
	return item, nil
}

func antigravitySend(ctx context.Context, binary, session, body string, notification bool) (object, error) {
	if _, err := antigravityMetadata(ctx, binary, session); err != nil {
		return nil, err
	}
	args := []string{"send-message"}
	if notification {
		args = append(args, "--title=ARC Notification")
	}
	result, err := antigravityCall(ctx, binary, append(args, session, body)...)
	if err != nil {
		return nil, err
	}
	if field(field(result["response"], "sendMessage"), "recipientId") != session {
		return nil, errors.New("ANTIGRAVITY_RECIPIENT_MISMATCH")
	}
	return result, nil
}

func submitAntigravityDesktop(ctx context.Context, r operationRequest, row, task object, binary string) (object, error) {
	options := obj(field(task["configured"], "options"))
	if text(options, "effort") != "" || nonemptyTaskText(text(options, "mode"), "accept-edits") != "accept-edits" {
		return nil, errors.New("UNSUPPORTED_DISPATCH_CONFIGURATION: agentapi supports model selection on create; effort and mode require agy")
	}
	taskID, session := text(task, "taskId"), text(task, "sessionId")
	turn := id()
	args := obj(row["arguments"])
	row["turnId"] = turn
	if err := agentReceiptCheckpoint(ctx, row, "submitting"); err != nil {
		return nil, err
	}
	baseline := captureNativeChangeBaseline(ctx, text(task, "cwd"))
	task["coordination"] = coordinationDispatchAdvisory(ctx, currentOrigin(ctx), baseline)
	task["turnId"], task["runtimeSource"], task["agentapiBinary"] = turn, antigravityDesktopProtocol, binary
	task["processState"], task["status"] = "running", "idle"
	task["metadata"] = nativeAntigravityFacts(task, "agentapi")
	dispatch := object{"model": field(task["configured"], "model"), "options": options, "reason": args["reason"], "submittedAt": now()}
	if r.name == "agent_send" {
		dispatch["trigger"] = dispatchSendTrigger(args)
	}
	task["dispatch"] = dispatch
	if err := recordAgentDispatch(ctx, task, args, r.name); err != nil {
		return nil, err
	}
	if err := recordNativeChangeBaseline(taskID, turn, baseline); err != nil {
		recordLog("WARN", err.Error(), nil)
	}
	if err := saveNativeAgentTask(task); err != nil {
		return nil, err
	}
	prompt := text(args, "prompt")
	if session != "" {
		if _, err := antigravitySend(ctx, binary, session, prompt, false); err != nil {
			return nil, err
		}
	} else {
		arguments := []string{"new-conversation"}
		if model := text(dispatch, "model"); model != "" {
			arguments = append(arguments, "--model="+model)
		}
		if title, exists := task["title"].(string); exists {
			arguments = append(arguments, "--title="+title)
		}
		result, err := antigravityCall(ctx, binary, append(arguments, prompt)...)
		if err != nil {
			return nil, err
		}
		session = text(field(result["response"], "newConversation"), "conversationId")
		if session == "" {
			return nil, errors.New("ANTIGRAVITY_CONVERSATION_ID_MISSING")
		}
		if _, err := uuid.Parse(session); err != nil {
			return nil, errors.New("INVALID_ANTIGRAVITY_SESSION")
		}
	}
	task["sessionId"], task["updatedAt"] = session, now()
	metadata := obj(task["metadata"])
	metadata["submission"], metadata["completionObserved"] = "accepted", false
	if err := recordAgentDispatchSubmission(task); err != nil {
		return nil, err
	}
	if err := recordAgentDispatchObservation(ctx, task, "accepted"); err != nil {
		return nil, err
	}
	if err := saveNativeAgentTask(task); err != nil {
		return nil, err
	}
	recordNotificationBindingFailure(row, bindNotification(ctx, args, taskID, turn, text(task, "cwd"),
		object{"op": r.name, "at": row["createdAt"], "requestId": row["requestId"]}))
	return object{"taskId": taskID, "turnId": turn, "sessionId": session, "status": task["status"], "dispatch": dispatch,
		"promptSubmitted": true, "submitted": true, "completionObserved": false}, nil
}

func init() {
	notificationAntigravitySend = func(ctx context.Context, target, body string) error {
		binary := antigravityAgentAPIBinary()
		if binary == "" {
			return errors.New("ANTIGRAVITY_AGENTAPI_NOT_FOUND")
		}
		_, err := antigravitySend(ctx, binary, strings.TrimPrefix(target, "antigravity_"), body, true)
		return err
	}
}
