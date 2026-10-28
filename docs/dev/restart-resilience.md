# Restart resilience

MUST means a requirement. SHOULD means the default. MAY means an option.

## Boundaries

Core owns the Codex app-server child and its stdio RPC pipes. Shutting down Core interrupts its active turns. Codex Desktop and external writers own separate lifecycles. The frozen `guide`, `query`, `act` and `notification` envelopes remain unchanged. Local replacement management and durable receipts carry the new behavior.

## P0: replacement continuations

The detached replacement worker reads `app.replace.snapshot` before shutdown. Core records a final cutoff snapshot before closing its app-server pipes. The worker adopts that snapshot after both original owners exit. Each entry identifies the thread and interrupted turn, recorded model/effort/tier and turn settings, original dispatch and source, notification binding, pending interactions, and one stable resume request ID. The existing private replacement journal survives process restarts. A missing final snapshot requires attention rather than speculative submission.

After authenticated health verifies the new Desktop and Core hashes, the worker invokes the existing `codex_resume` operation once per eligible entry with `threadId`, `turnId`, `requestId` and `waitMs:0`. It adds no user message, model override or notification argument. Native `resume_interrupted_task` recovers the original task in the same thread. The recorded configuration is evidence; native recovery owns effective settings, which must be verified from the successor turn rather than claimed from inherited metadata alone.

The local transport recognizes only the exact durable operation and arguments when restoring the original dispatch origin. `codex_resume` owns the thread lock, current-writer checks, interrupted-predecessor validation and notification inheritance. The existing native-continuation path records the successor under the original thread and origin scope, retaining purpose and notification binding. Public operation receipts add `replacementContinuation` with the interrupted turn and original request ID; replacement status includes the complete list and the latest `resumeReceipt`. Resume acceptance is not task completion.

Proactive conversation wakeups are limited to four classes: task completion; task failure, including an interruption that ARC did not automatically resume; pending execution questions and approval requests; and SRC peer messages delivered by message_send. The push-binding verification code remains a separate channel handshake. Automatically resumed interruptions MUST NOT wake the conversation. Update and restart lifecycle notices, merged post-recovery resume notices, ordinary restart recovery, ownership handoffs, progress, stalls and all other lifecycle kinds MUST remain inbox/event-center only. A question or approval blocking update settling wakes once through the ordinary interaction path, with no separate update notice. Query update_status, board, messages or the owning task for recorded lifecycle state. Existing verification, source scope, subscription filters, buckets, breakers and mute rules apply. Delivery does not prove client reconnection. The existing notification scope updates interrupted records when their native continuation finishes.

An explicitly supplied `continuation` remains a new instruction using the existing `codex_send(sendMode:queue)` contract. It replaces automatic native resume for that thread, marked `explicit-continuation`, so ARC does not submit both. Its existing approval and failed-predecessor queue rules still apply. A pending interaction or uncertain write suppresses that explicit send as well. Use automatic native resume when no new instruction is needed.

Submission intent is persisted before calling `codex_resume`. A `submitting` or `unconfirmed` entry MUST be reconciled through its original receipt. It MUST NOT be sent with a new request ID. Native resume rejects completed, active or newer predecessors under the existing thread lock. Existing uncertain writes are never replayed. Active or unconfirmed writes are reported for manual reconciliation.

Pending Codex interactions depend on callbacks in the terminated app-server. P0 cannot reconnect those callbacks. Normal replacement continues waiting for them. Immediate replacement records their pending state and reports `needs-attention` without sending another turn or inventing an answer. Interactions that arise during the countdown are checked again and captured at Core shutdown. Other agents and unknown ownership remain blockers in normal mode.

Normal replacement retains the five-minute bound for unsafe or unobservable work, three quiet observations and the ten-second countdown. Eligible Codex turns no longer count as blockers. This removes the busy-turn delay without weakening write or interaction checks. Older Core versions without the snapshot operation can upgrade when idle; busy instances fail before shutdown with an actionable snapshot error.

Cancelled, failed and rolled-back installations do not submit continuations. Interrupted entries remain available for reconciliation. A worker crash can leave recorded entries unsent or submission intent uncertain; P0 does not replay these automatically. Native interrupted-task recovery continues conversation state; it cannot undo completed or externally uncertain side effects. P0 never falls back to a generated codex_send prompt when native recovery rejects or is uncertain. This is a native continuation turn, not migration of the running computation.

## Deferred runtime verification procedure

Run this procedure only after runtime acceptance is authorized and main is available exclusively for acceptance. Do not run it in a coding lane. Use the background policy in [Acceptance](acceptance.md). Keep reports outside tracked documentation. This procedure exercises disposable state and bundles, never the installed app. A real Codex login and `jq` are required.

1. Confirm the reviewed implementation is landed in main. From main, launch `npm run dev:isolated` under the operator's approved memory watchdog. If the watchdog launches this command itself, invoke only that watchdog. Set its limits and duration before launch; a watchdog kill or timeout is an incomplete run, not a pass. Wait for `isolated-ready`, and retain its exact `stateDirectory`, CLI executable, bundle ID and process IDs. Do not substitute the default state directory. Keep this supervisor terminal separate from the following independent acceptance terminal.
2. Set the following variables from that readback. `ARC_TEST_OUT` is a new disposable artifact directory. The wrapper makes every command select the isolated state explicitly. Configure only this state to keep Codex execution in Core, without task approval or capacity retries:

   ```sh
   ARC_TEST_CLI='/absolute/path/from/isolated-ready/arc'
   ARC_TEST_STATE='/absolute/stateDirectory/from/isolated-ready'
   ARC_TEST_OUT="$(mktemp -d "${TMPDIR:-/tmp}/arc-resume-check.XXXXXX")"
   arc_test() { "$ARC_TEST_CLI" cli --state-dir "$ARC_TEST_STATE" "$@"; }
   arc_test app status > "$ARC_TEST_OUT/app-before.json"
   arc_test call health > "$ARC_TEST_OUT/health-before.json"
   printf '%s' '{"body":{"autoOpenCodex":false,"enabled":false,"codexRetryMaxAttempts":0}}' |
     arc_test call tasks.settings.set --stdin
   ```

3. Resolve the disposable bundle from `app-before.json`, retaining the reported acceptance marker in the selected state. Confirm its bundle ID equals `isolated-ready.bundleId` and its executable is under this checkout's `target` directory. Create a separate candidate copy and validate it. This uses the same bytes to exercise restart continuity; it does not claim a version upgrade.

   ```sh
   ARC_TEST_DESKTOP="$(jq -er '.result.executable' "$ARC_TEST_OUT/app-before.json")"
   ARC_TEST_APP="${ARC_TEST_DESKTOP%/Contents/MacOS/*}"
   ARC_TEST_CANDIDATE="$ARC_TEST_OUT/Candidate.app"
   /usr/bin/ditto "$ARC_TEST_APP" "$ARC_TEST_CANDIDATE"
   arc_test app replace "$ARC_TEST_CANDIDATE" --check > "$ARC_TEST_OUT/check.json"
   ```

   Require `ok:true` and `result.validated:true`, with `result.target` matching the disposable bundle. If validation or identity fails, stop before shutdown. Do not relax signing, change identity, switch to production state or replace installed code to make the check pass.

4. Start two independent self-test threads so the batch path is exercised. Use a disposable project directory. The original turn deliberately remains busy; the continuation is instructed to finish without repeating its sleep.

   ```sh
   mkdir "$ARC_TEST_OUT/project"
   for n in 1 2; do
     jq -n --arg project "$ARC_TEST_OUT/project" --arg title "Replacement self-test $n" '{
       project:$project,title:$title,purpose:"self-test",notify:null,
       mode:"read-only",approval:"bypass",turn:{approvalPolicy:"never"},waitMs:1000,
       prompt:"This is a restart self-test. On the initial turn, run one shell command: sleep 180. If this turn is interrupted and natively resumed, do not repeat the sleep. On continuation inspect the thread history, then reply exactly ARC_RESUME_OK. Do not edit files or call external services."
     }' | arc_test control codex_create --stdin > "$ARC_TEST_OUT/create-$n.json"
     jq '{requestId:.result.requestId}' "$ARC_TEST_OUT/create-$n.json" |
       arc_test wait --control --op receipt --stdin --until '/threadId exists' --until '/turnId exists' --timeout 60 > "$ARC_TEST_OUT/started-$n.json"
   done
   arc_test call app.replace.snapshot > "$ARC_TEST_OUT/snapshot-before.json"
   ```

   Require both threads to have nonempty turn IDs, `executionOwner:connector`, `purpose:self-test`, and `notify:null`. Read the original receipt again if it is still pending; never create a second request to compensate for a timeout. Before replacement, require both exact turns in `snapshot-before.json` with `state:recorded`, no pending interactions and `activeWrites:0`. A task that finishes too early does not exercise interruption. Record its outcome, then start a fresh self-test explicitly if another attempt is needed.

5. Trigger replacement from the independent terminal, without an explicit continuation. Retain the receipt and monitor only from that terminal. For the first run use normal mode; repeat the whole procedure with fresh isolated state using `--now` for the immediate case.

   ```sh
   arc_test app replace "$ARC_TEST_CANDIDATE" > "$ARC_TEST_OUT/replacement.json"
   arc_test wait --op app.replace.status --until '/state=="succeeded"' --timeout 180 > "$ARC_TEST_OUT/replacement-terminal.json"
   arc_test app replace --status > "$ARC_TEST_OUT/replacement-status.json"
   arc_test app status > "$ARC_TEST_OUT/app-after.json"
   arc_test call health > "$ARC_TEST_OUT/health-after.json"
   ```

   A wait timeout may mean cancellation, rollback or failure: inspect `app replace --status` and its log rather than retrying installation. Require new Core and Desktop PIDs, expected Core and Desktop hashes, the same isolated target, `snapshotFinalized:true`, and two recorded original thread/turn pairs. Normal mode must reach shutdown while both original turns are busy instead of waiting for their sleeps to finish. The immediate run must skip the countdown. A development supervisor may exit and close its Vite server after Desktop quits; this check uses authenticated native health and does not claim rendered UI acceptance. Do not start a competing development supervisor during the worker handoff.

6. For each entry, require `operation:codex_resume`, then read and wait on its single `continuation.requestId` through `arc_test control receipt --stdin` until it has a new `turnId`. Inspect `resumeReceipt` for rejection or uncertainty; never submit a new request to make the wait pass. Use that exact thread/turn with `codex_wait`, bounded to 180 seconds, and read its final output:

   ```sh
   # Set these from one interruptedTurns entry; repeat for the other entry.
   jq -n --arg requestId "$ARC_TEST_RESUME_ID" '{requestId:$requestId}' |
     arc_test wait --control --op receipt --stdin --until '/turnId exists' --timeout 60
   jq -n --arg threadId "$ARC_TEST_THREAD_ID" --arg turnId "$ARC_TEST_NEW_TURN_ID" '{threadId:$threadId,turnId:$turnId,until:"terminal"}' |
     arc_test wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 180
   jq -n --arg threadId "$ARC_TEST_THREAD_ID" '{threadId:$threadId,view:"full",limit:10}' |
     arc_test control codex_read --stdin
   ```

   Require exactly one native continuation turn per original thread, `dispatchMode:resumed`, `result.resumedFrom` equal to the interrupted turn, terminal completion and `ARC_RESUME_OK`. Confirm `turn_trigger:resume_interrupted_task` in native history and no newly generated user message. Compare successor effective model/effort/tier, origin/source ID and `purpose` against the recorded original dispatch. Require `replacementContinuation.interruptedTurnId` and `originalRequestId` to match. Verify the successor notification remains disabled (`notify:null`) and the persisted original binding links to that successor. Repeated status/receipt reads must not create additional turns. This null-notification check does not prove live cloud notification delivery; that needs a separately authorized bound-source scenario. Pending-interaction recovery must remain `needs-attention` with no automatic send; unit coverage is not native callback recovery evidence.
7. Preserve the status, worker log, both creation/continuation receipts, native final outputs and watchdog samples. Stop only the recorded disposable instance under the watchdog's cleanup procedure, verify its processes exited, and retain state until evidence is reviewed. If the worker cannot target the isolated instance or a provider prevents completion, report the exact blocker and distinguish the verified snapshot/native-resume behavior from the unverified restart and final task completion. Do not mark receipt acceptance alone as P0 runtime acceptance.

## P1: Desktop-only replacement

When the candidate Core build hash equals the running Core hash, replace only Desktop while Core retains its app-server and running tasks. This is design only. Define separate component identity and compatibility checks before implementation: Core bytes and embedded resources, Desktop bytes and resources, bundle signatures, entitlements, executable paths, and updater rollback ownership. Re-signing or repackaging can change binary hashes without changing source. A whole-bundle signature covers nested Core resources; replacing Desktop cannot silently invalidate that signature or remove a running Core executable. Health must identify both components independently. Rollback must preserve the live Core and its leases.

## Deferred: separate agent host

A thin host process could own app-server pipes and pending callbacks while Core reconnects through authenticated local IPC. This requires a durable request/result boundary, single-writer ownership, callback routing, resource limits, version negotiation and orphan cleanup. Keeping a child PID alive without those contracts does not make stdio reconnectable. Defer this larger lifecycle change until measured restart costs justify it.
