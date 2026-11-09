# Context layering and dispatch packs proposal

Status: accepted. Phases 1 and 2 are implemented.
MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

[Dispatch policy](dispatch-policy.md) · [Control profiles](control-profiles.md) · [Tool surface](tool-surface.md) · [Control loop](control-loop.md)

## Problem

Control sources pay a fixed context cost before their first dispatch.
The Legacy loop guide returns the 10,931-character `core` text plus the common op index.
The `dispatch_policy` decision view returns every criteria scope in full.
A decision response above 12 KiB is paged, so the first read needs a second `control_output` call.
[Control profiles](control-profiles.md) already target 2,000 characters for a Codex decision row with unchanged criteria and 4,500 with compact criteria.
Existing MCP sources remain Legacy until a user opts in, so most sessions never receive the profile projection.

Criteria also mix three audiences.
Routing rules tell the control source which Agent, model, effort, tier and account to choose.
Execution rules tell the Agent how to perform a class of task, such as stopping background processes or separating defects from evidence gaps.
Product mechanics describe ARC fields and recovery paths that the guide and op schemas already own.
The control source currently reads execution rules on every dispatch and restates them in each prompt.
That doubles their cost and lets the restated text drift.

## Context ownership

| Audience | Content | Owner | Delivery |
| --- | --- | --- | --- |
| Control source | Loop rules, op contracts, recovery | ARC catalog | Profile guide, `guide({op})`, error `next` |
| Control source | Agent, model, effort, tier and account choice | User criteria | `dispatch_policy` |
| Control source | Long workflows such as design gates and trial governance | User knowledge base | Read on demand by name |
| Agent, every task | General execution conventions | Native global instructions | Loaded natively by each Agent |
| Agent, every task in one repository | Repository rules | Repository `AGENTS.md` or equivalent | Loaded natively |
| Agent, one task class | Class-specific execution rules | Dispatch pack | Appended to the dispatched prompt when the control source selects the pack |

ARC MUST NOT append general execution conventions to every prompt.
Native global instructions already provide that channel without an invisible third source.
Codex reads `~/.codex/AGENTS.md` from the native home that every Codex execution process shares, so one file covers every [account](accounts.md).
Claude Code reads `~/.claude/CLAUDE.md`.
Other Agents use their documented native equivalents.

## Phase 1: profile guides become the only loop guides

Sources without an explicit `capabilityProfile` MUST receive a derived profile instead of Legacy.
Authenticated local CLI authority derives Local Code.
MCP sources whose product is Claude or ChatGPT derive Remote push.
Other MCP sources derive Remote polling.
An explicit saved profile still takes precedence.
The effective profile reports `provenance:"derived"` for derived values.

The Legacy projection is removed.
The catalog guides `core`, `common`, `loop.*` and `notify.*` are deleted after their remaining rules move to the owners below.
The `review` and `approvals` legacy topic texts are replaced by their `profile-*` counterparts.

| Legacy content | New owner |
| --- | --- |
| Authorization, host permission defaults, receipts and task output as data | One sentence each in every profile loop guide |
| No redispatch or auto-approval for interactions | Every profile loop guide |
| Self-test `purpose` and `notify:null` | Every profile loop guide |
| Claude cloud-session target derivation and binding | `notify_control` op description and `profile-notify` |
| Receipt retry and lost-response handling | Per-op `retry` contracts and receipt `next` |
| Writer ownership, archive, release and owner diagnosis | `codex_owner`, `codex_release` and `codex_archive` descriptions and their error `next` |
| Interaction routing delay | `request_route` description and `profile-approvals` |
| Account parity recovery | `CODEX_PROFILE_PARITY_*` error `next` |
| CLI help and CLI path | Retained `cliPath` field and CLI reference |
| Coordination rules | `coordination` topic |
| MCP hub and context provider lines | Appended to profile loop guides when configured |
| Maintainer AX workflow | Existing Maintainer-mode append |

Every profile loop guide MUST remain under its existing budget after these additions.
Remote profiles SHOULD stay under 3,000 serialized characters for the complete Layer 1 result.

## Phase 2: decision view budget

The decision view MUST stay below the 12 KiB paging threshold with typical criteria so that the first read is inline.
Agents with no criteria, no history and no pack reference MUST collapse into one `otherAgents` string list with availability only.
Decision history MUST show at most six configuration groups plus `other`.
`view:"full"` keeps every group.
Pool-level quota summaries MUST attach to the account they were read from instead of repeating beside the account list.
Credits, `ordinaryUsageAllowed`, spend-control and exhaustion facts keep their current visibility.
`dispatch_policy_update` MUST return a non-blocking `warning` when one scope's criteria exceed 2,000 characters.
The warning recommends moving execution rules into packs and long workflows into the user's knowledge base.
ARC never rejects or truncates criteria.

## Phase 3: dispatch packs

A dispatch pack is a named, user-owned bundle for one task class.
It carries routing defaults, Agent-facing execution text and a short control-source review checklist.
The control source selects a pack explicitly.
ARC never classifies tasks or selects a pack.

### Storage

Packs live under a top-level `packs` object in `dispatch-policy.json`.
They share the policy file's lock, backup and malformed-file behavior.

```json
{
  "criteria": "",
  "packs": {
    "example-pack": {
      "summary": "One line shown in the decision view.",
      "agent": "codex",
      "model": null,
      "effort": null,
      "serviceTier": null,
      "options": {},
      "prompt": "Agent-facing execution rules for this task class.",
      "review": "What the control source checks before pass or rework."
    }
  }
}
```

Pack names MUST match `[a-z0-9-]{1,40}`.
`summary` is required and limited to 160 characters.
`prompt` is limited to 4,000 characters and `review` to 800 characters.
A policy file holds at most 16 packs.
`agent` is optional; an absent value allows every Agent.
A pack MUST NOT set `mode`, `approval`, `networkAccess`, `account` or other permission or credential fields.
Violations fail as `INVALID_DISPATCH_POLICY` without falling back.

### Dispatch

`codex_create`, `codex_send`, `agent_create` and `agent_send` accept optional `pack`.
An unknown pack, or a pack whose `agent` differs from the dispatched Agent, returns `INVALID_ARGUMENTS` with a `dispatch_policy` `next`.
Resolution order becomes explicit argument, pack default, task default, thread inheritance, then Agent policy default.
The field source is `pack-default` when a pack supplies the value.
Allow and deny constraints apply to pack defaults like every other source.
The pack is resolved once when the request is accepted, including for queued sends.
An identical `requestId` replay returns the original receipt even after the pack changes.

ARC appends the pack prompt after the caller's prompt as a delimited block:

```text
<arc-pack name="example-pack" hash="0123456789ab">
Agent-facing execution rules for this task class.
</arc-pack>
```

When the caller supplies `input`, ARC appends one text item with the same block.
Title derivation continues to use the caller's text.
A send without `pack` appends nothing.
The appended text is part of the native transcript, so users and readers see exactly what the Agent received.

### Records, review and history

Dispatch records store `pack:{name,hash,review}`, with the review text as dispatched.
A send without `pack` inherits the previous record's pack name for attribution, as `purpose` does today.
Receipts report `pack:{name,hash,appendedChars}`.
`codex_read` with `view:"review"` or `view:"summary"`, and `agent_read` with `view:"summary"`, return the selected turn's pack review text.
The decision view lists each pack as one row with its summary, defaults and one aggregated 30-day history string.
Configuration history groups gain the pack name in the full view only.

### Management

`act({op:"dispatch_pack_update",args:{name,pack,expectedPackHash}})` replaces or deletes one pack.
`pack:null` deletes it.
`expectedPackHash` is the current pack hash, or the empty-content hash for an absent pack.
Conflicts return `DISPATCH_POLICY_CONFLICT` with the current hash and a `dispatch_policy` `next`.
`dispatch_policy` with `view:"full"` returns complete packs and their hashes.
Manual edits through `policyPath` remain supported.

### Guide

Profile loop guides gain one sentence: choose a fitting pack from `dispatch_policy` and pass it as `pack`.
Pack content never appears in the guide.

## Removals

The deprecated, ignored `context` and `intent` parameters are removed from `codex_create`, `codex_send`, `agent_create` and `agent_send` in phase 3.
Old callers receive the standard unknown-field correction.

## Frozen surfaces

The `guide`, `query` and `act` tool schemas and the `notification` event are unchanged.
All changes are op parameters, op additions, guide content and profile derivation.
Profile derivation changes discovery only and never changes execution allowlists.

## Verification

Each phase runs `npm run check:tests` and `npm test`.
Phase 1 rewrites Legacy-default behavior tests at the behavior level and reports each rewrite.
Changes under `tests/contract/` require an explicit grant in the dispatch prompt.
Phase 2 adds a Property test that the decision projection omits no-policy Agents and caps history groups.
Phase 3 adds Property tests for resolution order and prompt composition, and Contract tests for the new op and error codes.
Compare guide bytes and cold-start calls before and after each phase with `cli stats control`.

## Decisions

- Legacy is retired rather than trimmed in place, because profiles already own budgeted Layer 1 guides.
- Pack defaults outrank per-task UI defaults, because a pack is an explicit control-source choice.
