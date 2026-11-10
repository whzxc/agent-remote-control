//! Clock-only delivery scheduling. Blocked history never invents a retry clock.
use super::*;

pub(super) fn next_at(
    state: &State,
    bindings: &[Arc<Binding>],
    settings: &Value,
    now: i64,
    routing_at: Option<i64>,
    active: impl Fn(&str) -> bool,
) -> Option<i64> {
    let mut next_at = governance::next_delivery_at(state, settings, &active);
    for b in bindings
        .iter()
        .inspect(|_| crate::runtime_metrics::cost::rows(1))
        .filter(|b| active(&b.source_id))
    {
        for d in b
            .deliveries
            .iter()
            .filter(|d| matches!(d.status.as_str(), "pending" | "sending"))
        {
            let reason = d.timing.queue_reason.as_deref().unwrap_or("");
            let next = if routing::held(d) {
                (d.interaction["routing"]["state"] == "deferred")
                    .then_some(routing_at)
                    .flatten()
            } else {
                match reason {
                    "disabled" | "breaker" => None,
                    "unbound" if d.target.is_empty() => None,
                    "muted" | "digest-wait" => state.rule(b).and_then(|r| {
                        if reason == "muted" {
                            r.until
                        } else {
                            Some(
                                r.digest_at
                                    .saturating_add(3600)
                                    .min(r.until.unwrap_or(i64::MAX)),
                            )
                        }
                    }),
                    "subscription-muted" => state
                        .subscriptions
                        .iter()
                        .find(|s| s.id == d.subscription)
                        .and_then(|s| s.until),
                    "retry-backoff" => Some(d.next_attempt_at.saturating_add(1)),
                    "token-wait" => next_at,
                    _ => Some(d.created_at.saturating_add(2).max(now)),
                }
            };
            if let Some(at) = next {
                next_at = Some(next_at.map_or(at, |old| old.min(at)));
            }
        }
    }
    next_at
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        serde_json::from_value(json!({"threadId":"thread","turnId":"turn","sourceId":"","target":"target","project":"","terminal":true,"createdAt":0,"waiting":[],"deliveries":[]})).unwrap()
    }
    #[test]
    fn unattributed_pending_and_paused_routes_have_no_retry_clock() {
        // Regression: AX-23 a pending legacy delivery without sourceId kept the settled delivery loop running every second.
        let state = State::default();
        let mut b = binding();
        b.deliveries.push(Delivery {
            status: "pending".into(),
            target: "target".into(),
            ..Default::default()
        });
        let next = |b: Binding| {
            next_at(&state, &[Arc::new(b)], &json!({}), 1000, None, |source| {
                !source.is_empty()
            })
        };
        assert_eq!(next(b.clone()), None);
        b.source_id = "source".into();
        b.deliveries[0].target.clear();
        b.deliveries[0].timing.queue_reason = Some("unbound".into());
        assert_eq!(next(b.clone()), None);
        b.deliveries[0].target = "target".into();
        b.deliveries[0].interaction = json!({"routing":{"state":"paused"}});
        assert_eq!(next(b.clone()), None);
        b.deliveries[0].interaction = json!({"routing":{"state":"not-routable"}});
        assert_eq!(next(b), None);
    }
    #[test]
    fn retries_and_mutes_use_their_recorded_deadlines() {
        // Property: pending retries and finite mutes resume only at their next state transition.
        let mut state = State::default();
        let mut b = binding();
        b.source_id = "source".into();
        b.deliveries.push(Delivery {
            status: "pending".into(),
            target: "target".into(),
            next_attempt_at: 1300,
            timing: DeliveryTiming {
                queue_reason: Some("retry-backoff".into()),
                ..Default::default()
            },
            ..Default::default()
        });
        assert_eq!(
            next_at(
                &state,
                &[Arc::new(b.clone())],
                &json!({}),
                1000,
                None,
                |_| true
            ),
            Some(1301)
        );
        state.thread(&b, 0).until = Some(1200);
        state.thread(&b, 0).mode = "mute".into();
        b.deliveries[0].timing.queue_reason = Some("muted".into());
        assert_eq!(
            next_at(
                &state,
                &[Arc::new(b.clone())],
                &json!({}),
                1000,
                None,
                |_| true
            ),
            Some(1200)
        );
        assert_eq!(
            next_at(&state, &[Arc::new(b)], &json!({}), 1000, None, |_| false),
            None
        );
    }
}
