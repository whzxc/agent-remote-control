---
name: arc-local-code
description: Use ARC from Codex or Claude Code on the ARC host to select Agents through the live dispatch policy, dispatch authorized work or independent reviews, wait for results, and record ARC friction through AX.
---

# ARC from Local Codex and Claude Code

Use this flow only when this session runs the CLI on the ARC execution host (use the built-in local CLI source and your own shell, files, and Git for host work).

## Claude Code CLI Authorization

Dispatch to Claude Code CLI **only** with the user's explicit authorization for the task or a clearly defined scope (covers direct CLI, ARC, indirect delegation, follow-ups, reviews, and resumes). General task requests, agent-use permissions, reviewer roles, skills/MAP entries, and policy exceptions do not grant it. Without explicit authorization, continue with the current authorized agent and report any review gap.

## 1. Discover and Select

1. Run `arc cli control guide` (use the returned `cliPath` if `arc` is not on `PATH`). To opt into the shared Local Code guide using the returned `sourceId`:
   ```sh
   printf '%s' '{"capabilityProfile":{"hostAccess":"host","waitMode":"background-cli"}}' | arc cli source update <sourceId> --stdin
   arc cli control guide
   ```
   (Use `arc cli control guide --stdin` with `{"view":"full"}` for all permitted ops, and refresh when `arcVersion` changes.)
2. Read `arc cli control dispatch_policy` before picking Agent, account, model, effort, or tier. Retain the returned `criteriaHash` and pass it as `knownCriteriaHash` on subsequent calls (`{"agent":"codex","knownCriteriaHash":"<criteriaHash>"}`, or a map keyed by Agent ID + `global` for multiple blocks).
3. Read `arc cli control guide <op>` for each operation's live schema and retry contract (do not embed cached model names, quotas, or criteria).
4. For Codex, check native pool `credits` alongside subscription windows: an exhausted window or `ordinaryUsageAllowed:false` does not rule out credit-backed work when `credits.hasCredits:true` or `credits.unlimited:true` (preserve `credits.balance` verbatim; if an older ARC omits `credits`, check `codex_query` with `method:"account/rateLimits/read"`).

## 2. Dispatch and Wait

CLI `--stdin` takes the operation's args object directly (not an MCP envelope). Pass `purpose:"task"` and `notify:null` explicitly (local dispatch defaults to self-test), and provide a concise `title` (<=120 chars) on `codex_create` / `agent_create`:

```sh
printf '%s' '{"project":"/workspace/project","title":"Implement requested change","prompt":"Implement the requested change.","purpose":"task","notify":null}' | arc cli control codex_create --stdin
```

- Retain `requestId`, `threadId`, and `turnId` (rename Codex tasks via `codex_thread` `action:"name/set"` if needed). Reconcile pending or uncertain receipts before redispatching.
- Wait via your client's background-command facility when it can return completion to this session (otherwise use bounded active waits; shell `&` alone does not wake the session):
  ```sh
  printf '%s' '{"threadId":"<threadId>","turnId":"<turnId>","until":"terminal-or-interaction","view":"summary"}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 1800
  ```
- On `WAIT_TIMEOUT`, inspect `error.lastResult` and keep waiting on the same task. On match, inspect `result.lastResult.state` (may be failed/interrupted) and handle interactions via the returned `next` op without resending the task. For other Agents, use `agent_create` and `agent_wait`.

## 3. Review

- Inspect the actual local diff and validation evidence (following `completeEvidence` if summary paths/messages are truncated; keep unknown change attribution explicit).
- `codex_review` and `agent_review` record verdicts (`pass` or `rework` for the terminal turn) rather than launching a model; run any independent cross-model review within policy and the Claude Code authorization rule above.

## 4. AX Feedback

1. Check `arc cli config get` once for `maintainerMode`.
2. When enabled, file reproducible ARC friction after working around it via `arc cli control ax_report --stdin` (`symptom`, `expected`, `severity`, receipt/thread IDs—metadata only, no prompts/secrets/private routes; separate observed facts from guesses; inspect similar entries and `candidate` evidence via `ax_candidate`). Inspect `ax_list` before releases, at ~8 open entries, or on confirmed blockers.
3. With `maintainerMode` disabled, describe the friction and offer the read-only `ax_issue_draft` flow without auto-publishing.
