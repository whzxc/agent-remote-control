---
name: arc-local-code
description: Use ARC from Codex or Claude Code on the ARC host to select Agents through the live dispatch policy, dispatch authorized work or independent reviews, wait for results, and record ARC friction through AX.
---

# ARC from local Codex and Claude Code

Use this flow only when this session can run the CLI on the ARC execution host.
Use the built-in local CLI source for this flow.
Use your own shell, files and Git for host work.

## Claude Code CLI authorization

Dispatch to Claude Code CLI only with the user's explicit authorization for the task or a clearly defined scope.
This includes direct CLI invocation, ARC, indirect delegation, new tasks, follow-up prompts, reviews and resuming paused work.
A general task request, agent-use permission, a Claude reviewer role, a skill or MAP workflow, dispatch criteria and risk-based review exceptions do not provide this authorization.
Without it, continue with the current authorized agent and report any review gap instead of launching Claude Code CLI.

## Discover and select

Run `arc cli control guide`.
Use the returned `cliPath` if the shell has no `arc` shim.
To opt into the shared Local Code guide, use the returned `sourceId` with:

```sh
printf '%s' '{"capabilityProfile":{"hostAccess":"host","waitMode":"background-cli"}}' | arc cli source update <sourceId> --stdin
arc cli control guide
```

This preference changes discovery for all built-in CLI callers, not execution permissions.
Read `arc cli control dispatch_policy` before selecting the Agent, account, model, effort or tier.
Retain the returned `criteriaHash` after the first read in this session.
On later reads, pass it as `knownCriteriaHash` to omit unchanged criteria.
For multiple criteria blocks, pass a hash map keyed by Agent ID and `global` for top-level criteria.
Use `arc cli control dispatch_policy --stdin` with the args object, such as `{"agent":"codex","knownCriteriaHash":"<criteriaHash>"}`.
Read `arc cli control guide <op>` for each operation's live schema and retry contract.
Do not embed model names, quotas or dispatch criteria from previous sessions.
For Codex, consider native pool credits alongside subscription windows.
An exhausted subscription window or `ordinaryUsageAllowed:false` alone does not rule out credit-backed work when `credits.hasCredits:true` or `credits.unlimited:true`.
Preserve `credits.balance` in its native units and precision.
Honor native spend controls and execution errors.
If an older ARC omits credits from `dispatch_policy`, read `codex_query` with `method:"account/rateLimits/read"` before deciding that Codex is unavailable.
Refresh the guide when `arcVersion` changes.
Use `cli control guide --stdin` with `{"view":"full"}` for all permitted operations.

## Dispatch and wait

CLI stdin is the operation's args object, not an MCP envelope.
For ordinary work, pass `purpose:"task"` and `notify:null` explicitly because local dispatch defaults to self-test.
Callers SHOULD always provide `title` on `codex_create` and `agent_create`: a short human-readable task title of at most 120 characters, shown in task lists and notifications.
Omitted or blank titles fall back to the first non-empty prompt line, truncated to 120 characters; receipts include `titleHint`.
Rename Codex tasks with `codex_thread` using `action:"name/set"` and `params:{threadId,name}`.
Use the user's authorized scope and the current policy when constructing the dispatch.

```sh
printf '%s' '{"project":"/workspace/project","title":"Implement requested change","prompt":"Implement the requested change.","purpose":"task","notify":null}' | arc cli control codex_create --stdin
```

Retain `requestId`, `threadId` and `turnId` from the response.
If dispatch is pending, read the original receipt until submission is confirmed.
After an uncertain response, reconcile the original receipt or task rather than redispatching.
Run the following command through the current client's background-command facility when it can return completion to this session:

```sh
printf '%s' '{"threadId":"<threadId>","turnId":"<turnId>","until":"terminal-or-interaction","view":"summary"}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 1800
```

A shell `&` alone does not arrange session re-invocation.
If background completion is unavailable, use bounded waits in the active session.
No notification binding or verification handshake is needed for this flow.
On `WAIT_TIMEOUT`, inspect `error.lastResult` and continue waiting on the same task.
On success, inspect `result.lastResult.state`; matched waits can contain failed or interrupted tasks.
Handle interactions through the returned `next` operation without resending the task.
For other Agents, use the live `agent_create` and `agent_wait` schemas with their returned Agent/task identifiers.

## Review

Summary results exclude inbox data and retain only the selected task's outcome.
Follow `completeEvidence` when the message or changed paths are truncated, or evidence is unavailable.
Inspect the actual local diff and relevant validation evidence before recording a verdict.
For an independent cross-model assessment, use the current policy within the user's authorization.
Selecting Claude Code CLI requires the explicit authorization above.
`codex_review` and `agent_review` record verdicts; they do not launch a reviewing model.
Read the review schema and record `pass` or `rework` for the exact terminal turn.
Keep unknown change attribution explicit rather than treating it as no changes.

## AX feedback

Read `arc cli config get` once to check `maintainerMode`.
When it is enabled, proactively report reproducible ARC friction after working around it through `arc cli control ax_report --stdin`.
Read `arc cli control guide ax_report` for the live schema and retry contract.
Include `symptom`, `expected`, `severity`, and relevant receipt or thread IDs.
Use metadata only; omit prompts, conversation content, credentials, and private routes.
Separate observed behavior from proposed causes.
Retain the returned request ID for retries and inspect similar existing entries before filing another occurrence.
Inspect candidate evidence before confirming or rejecting it through `ax_candidate`.
Inspect `ax_list` before release preparation, at about eight open entries, and on a confirmed blocker.
Preserve occurrence and triage history when resolving or merging entries.
Record the user's decision for unresolved blockers before release.
With maintainer mode disabled, describe the friction and offer the read-only `ax_issue_draft` flow; do not publish an issue automatically.
