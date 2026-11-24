# Finished tasks after independent process exit

Use the [MacBook setup](../installed.md). Record shared 0.163.0, default 30-minute unload, its unchanged socket peer, and the independent writer actually used. Keep main closed during dispatch. Seed the selected terminal state, enumerate native parent/child edges, verify each initial writer and exclude explicit outside opens. Also record already-clear children separately. Arm exit observation and start timestamped lock and ARC owner observations before Quit or guarded crash. Keep main off the subjects until handback. Bound exit time between the last confirmed live sample or quit trigger and the observed exit. For a conservative pass measure from the earlier bound. For a failure measure from the later bound. Record timing uncertainty across the deadline as a gap.

| Case | Matrix |
| --- | --- |
| finished-exit | D1. Quit and crash, completed, failed and interrupted last turns, plain parents and real populated families. A deliberately explicitly opened task is an exception control. |
| finished-cohort | D11. Use 1, 8 and 32 finished parents with 0, 1 and 2 children. Arm observations for the whole cohort so probe serialization cannot create a false failure. |

**clear-within-30s** — For this exit and each eligible family, every writer is clear and ARC reports handback for the matching task by exit + 30 s. Record each native probe and exact-ID owner response at receipt on the same monotonic clock. A release acknowledgement alone cannot satisfy the deadline. A private-backend startup failure selects the fallback case.

**main-continues** — Immediately after the clear/handback observation, select the exact parent in main and send a unique marker. Read back the accepted marker and reply on that ID. After that turn ends, archive the parent once and verify it and every recorded child individually in archived history and absent from active history. Report the exercised family size.

Baseline expectation: the shared 0.163.0 route can retain an eligible writer beyond 30 s. Record observed times before attributing a failure.

**exit-family-replay** checks the routing and timing portion from public observations. On MacBook save the resolved create envelope as receipt.json. Collect `h sample "$parent" "${children[@]}" > "$run/before.jsonl"` while the writer is held. Arm watch-exit as in the shared guide and save `h stamp trigger "$parent" > "$run/trigger.json"` immediately before Quit/crash. Collect repeated post-exit sample rows into after.jsonl without selecting any subject in main. For scale, shard collection across observers. Verify continuous writer ownership if a late held sample could represent reacquisition. Export the files and run:

```sh
python3 behavior/cases/own-backend-unlocks-promptly/exit-family.py \
  --receipt "$run/receipt.json" --before "$run/before.jsonl" \
  --shared-pid "$shared_pid" --private-pid "$private_pid" \
  --trigger "$run/trigger.json" --exit "$run/exit.json" --after "$run/after.jsonl"
```

Append one `--child ID` per native descendant. Supply the two backend PIDs from independent socket-peer and launch observations. Only use a healthy independent dispatch, with all turns terminal, no fallback fault and no outside opens. The baseline replay can fail on the recorded shared writer before the timing inputs are needed. The GUI send/archive verdict uses the installed steps above.
