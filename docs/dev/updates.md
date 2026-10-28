# Unified updates

MUST means a requirement. SHOULD means the default. MAY means an option.

ARC has two install paths today. Release updates (Tauri updater in `desktop/src/updates.rs`) verify, stop Core, install and restart. They do not settle running work, back up the app, check health after start, roll back or resume interrupted turns. Local replacement (`native/src/app_replace*`, `docs/reference/app-replacement.md`) does all of that. This design makes every install go through the replacement pipeline. Only the package source differs.

## Sources

A source produces a candidate bundle and a policy. Everything after acquisition is shared.

| Policy | Release | Local build |
| --- | --- | --- |
| Acquire | Updater check and download | Path submitted by CLI or control source |
| Verify | Release signature MUST pass | Existing package signatures required |
| Version direction | Upgrade only | Same version and downgrade allowed |
| Initiator | Periodic check; user consents unless timing is automatic | Agent, CLI or control source |
| Identity shown | Version | Version plus `main @ <short sha>` and landed lanes when known |

Local candidates come only from the main checkout after `wt land`; lanes cannot package. Local production candidates retain the pinned certificate requirement; Dev and isolated candidates retain their matching identity and valid signature checks. Unsigned packages are not accepted because weakening validation would violate the replacement safety boundary.

The Release path MUST stop calling `update.install` directly. It stages the verified package and hands it to the replacement pipeline. Windows and Linux keep their current updater behavior and report the pipeline as unsupported, as replacement does today.

## Pipeline

1. Acquire
2. Verify (per source policy)
3. Stage and back up the installed bundle
4. Settle
5. Swap (stop Core, move bundles)
6. Restart and reconnect ingresses
7. Health check (matching Desktop and Core build hashes)
8. Resume interrupted ARC-owned turns and record the outcome

A failed health check rolls back: restore the backup, restart, resume interrupted turns on the old version, and keep the failed candidate for diagnosis. A failed restore keeps the backup and surfaces its path. These are the existing replacement semantics. Reuse them; do not reimplement them.

## Settle policy

Settling replaces "wait for all turns". Classify every piece of running work:

- Blocking: active file writes, pending interactions (questions, approvals) on ARC-owned turns, and unknown ownership or activity. Pending interactions cannot survive a restart, so they block.
- Resumes: ARC-owned (`executionOwner: connector`) Codex turns without pending interactions. They are interrupted at swap and continued after verified recovery through the existing continuation path.
- Unaffected: Desktop-owned and other externally owned turns. An ARC restart does not interrupt them. They MUST NOT block and MUST NOT be interrupted.

While a job is settling, new ARC dispatches SHOULD queue and start after the job reaches a terminal state, so continuous parallel work cannot starve an update. A held dispatch returns a receipt saying it is held for an update.

Timing choices:
- `settled` (default): wait only for blockers, then a short countdown.
- `now`: skip settling; pending interactions are dropped and reported.
- `defer`: re-evaluate after a duration, one hour by default.

The existing `--now` flag keeps its meaning and maps to `now`.

## State model

One snapshot replaces both `UpdateSnapshot` and `Replacement` in `ui/state/updateModel.ts`:

```
state: idle | checking | available | downloading | settling | countdown | swapping | starting | verifying | resuming | succeeded | rolling-back | rolled-back | failed | cancelled
source: { kind: release | local, version, build?, landedLanes? }
instance: production | dev | isolated:<id>
work: { blocking[], willResume[], unaffected[], stale[] }   // item: kind, agent, taskId, turnId, title, owner, question?
when: settled | now | defer, deferUntil?
notes: release notes (release) or commits since the installed build (local)
error, backup, statusPath, logPath
```

Persist a bounded history (last 20 jobs) with source, instance, outcome, settle duration and resumed count. Keep the last three backups.

## Desktop UX

No modal dialogs for updates. Remove `AppUpdateDialogs` and the replacement dialog.

- Dock entry: when an update is available or a job is active, append a green update item at the right end of the bottom-left dock, after a divider. Available shows an arrow-up icon with a dot. Settling shows a progress ring. It is the persistent reminder and the panel's entry. Remove the center-logo badge and any top-center pill.
- Update panel: opens above the dock, in two columns. Left: notes (release notes, or commits since the installed build for local). Right: work impact grouped as Waits (questions answerable inline), Resumes and Unaffected, then the timing choices. Footer: a dismiss action (`Skip this version` for release, `Cancel replacement` for local) and a primary action matching the selected timing.
- Topology: only blocking task bubbles get the amber outline and a "waiting for reply" tag. Other bubbles stay unchanged.
- Countdown: the panel switches to a countdown with a six-step progress row (verify, back up, settle, restart, health check, resume) and Cancel / Restart now.
- Outcomes: one toast per terminal state. Release succeeded (Release notes, Resumed tasks); local replaced; rolled back (View log, Retry); restore failed (backup path, Show in Finder, Copy path).
- Settings > Updates: current version card (Release notes, Check for updates); Sources (release channel, accept local builds); Timing (automatic when settled or ask me, resume interrupted tasks, allow control sources to schedule updates); Recent updates with instance and outcome; Restore for kept backups.

All copy goes through i18n (en, zh-CN). Reference mockups live in the "ARC Unified Updates" design canvas from the planning conversation.

## Control-source surface

Add ops on the frozen tools. Add no new tools.

- `query update_status`: compact by default, with only the current or latest job (`id`, state, source build, `{count,titles}` for each work group, outcome, error and `next`) and at most three single-line summaries of earlier jobs. Full view retains the detailed snapshot above and last 20 outcomes.
- `act update_request`: `action: submit | now | defer | cancel`. `submit` takes `source: {kind: local, path}`, an optional `when`, and an optional `continuation: {threadId, prompt}` with the same semantics as `app replace --stdin`. Release jobs start only from Desktop or a scheduled check, never from `submit`.
- The `app replace` CLI and local management routes remain compatibility aliases that create a local `submit` job.
- Proactive conversation wakeups MUST be limited to task completion, task failure (including an interruption ARC did not automatically resume), pending execution questions/approvals, and SRC peer messages delivered by `message_send`. The push-binding verification code MUST remain the channel handshake.
- Update and restart lifecycle events MUST remain inbox/event-center only, including pre-restart, interrupting, merged post-recovery resumed notices and ordinary restart recovery. Ownership handoffs, progress, stalls and other lifecycle kinds MUST NOT wake conversations. `update_status` remains the progress and outcome query.
- An automatically resumed interruption MUST NOT wake its conversation. A failed resume or an external interruption without automatic resumption MUST use the ordinary task-failure notification.
- A pending execution question or approval that blocks settling MUST wake once through the ordinary interaction path. Settling MUST NOT add a separate update notice.
- Interaction classification MUST preserve the owner returned by `codex_pending`. Desktop-owned interactions MUST remain unaffected. Interactions whose own turn is completed, failed or cancelled MUST appear in `work.stale` and MUST NOT block settling or automatic continuation of a newer turn in the same thread. Unknown turn status MUST NOT imply completion. These rules apply when automatic resumption is disabled as well.
- Unanswered Desktop asynchronous questions MUST remain answerable after their originating turn ends. `codex_pending` MUST expose `turnStatus` and `stale` with a late-answer hint. Late answers MAY steer the active turn or start a new turn through Desktop's existing response path. Finished-turn questions MUST NOT reactivate task input work.
- The submitted replacement's persisted command submitter or continuation binding MUST scope its inbox outcome without an outcome wakeup. A local submission without conversation attribution MUST NOT infer a destination from other bindings.
- Notices MUST use short text scoped to the receiving conversation. Existing verification, subscription filters, buckets, breakers, mutes and transport retries MUST apply. Frozen tool and notification subscription envelopes MUST remain unchanged.
- Control-source commands MUST carry source attribution and their uniquely bound notification destination in the spawned command environment (`ARC_COMMAND_SUBMITTER`). Local replacement MUST persist it as `submitter` without requiring a Codex continuation. When no open task binding exists, the update job MUST supply its own binding for the registered target to retain the inbox outcome. This context MUST NOT grant authorization. Local terminal commands MAY omit it. Multiple possible destinations MUST NOT select an arbitrary conversation.
- The guide documents these ops and states that dispatches during settling are held.

The detached worker uses the internal `updates/task-notice` route with the job journal and phase. This replaces the broadcast-only `updates/notice` route without an alias. A newer worker MUST NOT fall back to the old broadcast route while the previous Core is still running. The route records lifecycle events without proactive delivery; pending questions use the ordinary interaction notification path. The job journal and `update_status` remain available during replacement. Frozen public tools and event subscription arguments are unchanged.

## Out of scope

Tiered UI-only replacement, a separate process that holds agent pipes, and Windows or Linux pipeline support.
