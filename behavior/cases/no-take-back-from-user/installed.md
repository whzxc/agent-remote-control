# User continues in main Desktop

Use the [installed runner](../installed.md). Dispatch, finish, exit the independent instance and observe ARC mark the parent handed back after its writer clears, then continue that parent **from main Desktop**. Record its accepted user turn ID and unique marker. Keep main open. Run once with that user turn active and once with it ended but still open for writing.

| Case | Interruption and repetition |
| --- | --- |
| send-boundaries (D2) | Use fresh seeds for normal quit and forced crash of the independent instance. Inject graceful ARC quit/reopen, Core crash/recovery, Core restart and signed ARC update separately at each boundary: after exit before main's send, after main accepts its turn before ARC submits, immediately after ARC submits before receipt inspection, and after the refusal before replay. Repeat the read after ARC reconnects. If a request is in flight when Core goes away, reconcile it by request ID. Record a missed boundary separately. |
| send-replay (D3 origin) | Submit twice concurrently with the same request ID, then send the identical marker with a new ID while the earlier result is being read. Keep main writable and inspect the transcript again after its active turn ends. |

Set `thread` to the confirmed ID, use one marker per trial, and retain all envelopes, including error exits. Commands below assume the MacBook has jq. Run the send pair at the boundary selected for this trial.

```sh
marker="arc-follow-up-$(uuidgen)"
request=$(uuidgen | tr A-Z a-z)
args=$(jq -nc --arg id "$thread" --arg req "$request" --arg text "$marker" \
  '{threadId:$id,requestId:$req,prompt:$text,purpose:"self-test",notify:null,waitMs:0}')
h ctl codex_send "$args" >"$run/send-a.json" & first=$!
h ctl codex_send "$args" >"$run/send-replay.json" & second=$!
wait "$first" || true
wait "$second" || true
fresh=$(uuidgen | tr A-Z a-z)
h ctl codex_send "$(jq -c --arg req "$fresh" '.requestId=$req' <<<"$args")" >"$run/send-b.json" || true
for req in "$request" "$fresh"; do
  h ctl receipt "$(jq -nc --arg req "$req" '{requestId:$req}')" || true
done
```

- **no-take-back-from-user / in-use-reported** — inspect each definitive send result, following its receipt if it was pending. It identifies the task as in use by the user in main Desktop. A generic transport error or unknown write outcome gives no verdict.
- **no-take-back-from-user / input-not-delivered** — inspect main's entire history for this trial. There are zero user messages or steers containing the ARC marker, including after the user's active turn ends, receipt replay, a new request, and reconnect. Read `codex_queue` on the same ID for pending delivery, then send and finish one more main turn and refresh its history. The marker must still be absent. Check that ARC did not open a duplicate conversation containing the marker.
- **no-take-back-from-user / stays-with-user** — main accepts that second uniquely marked user turn on the original thread, retains both user turns on refresh, and stays writable. Check the user's resulting thread ID and messages even if ARC reported a refusal.
