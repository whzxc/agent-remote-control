//! One read-time view of explicit session routes and verified fallback targets.
use super::*;
use crate::claude_notify::coordination_delivery::{self as delivery, Outcome, Route};

fn unavailable(reason: &str) -> Outcome {
    Outcome {
        route: None,
        state: reason.into(),
    }
}
pub(crate) fn resolve(source: &str, session: Option<&str>) -> Result<Outcome> {
    messages::migrate_routes()?;
    let sessions = bulletin::session_routes(source)?;
    let selected = select(&sessions, session);
    if selected.state == "fallback" || selected.route.is_some() {
        return delivery::effective_route(source, selected.route);
    }
    Ok(selected)
}
pub(crate) fn select(
    sessions: &[(String, Option<Route>, Option<String>)],
    session: Option<&str>,
) -> Outcome {
    if let Some(session) = session {
        let Some((_, route, failure)) = sessions.iter().find(|(id, _, _)| id == session) else {
            return unavailable("session-closed");
        };
        return match failure {
            Some(reason) => unavailable(reason),
            None => Outcome {
                route: route.clone(),
                state: if route.is_some() {
                    "explicit-route"
                } else {
                    "fallback"
                }
                .into(),
            },
        };
    }
    // Source-addressed mail can use a shared explicit destination, but must never
    // pick one of several conversations merely because their sessions are active.
    let mut selected: Option<Route> = None;
    let mut failures = vec![];
    for (_, route, failure) in sessions {
        if let Some(failure) = failure {
            failures.push(failure);
        }
        if let Some(route) = route {
            if selected
                .as_ref()
                .is_some_and(|r| !r.same_destination(&route))
            {
                return unavailable("ambiguous-session-routes");
            }
            selected = Some(route.clone());
        }
    }
    if !failures.is_empty() {
        return unavailable(if selected.is_some() {
            "ambiguous-session-routes"
        } else {
            failures[0]
        });
    }
    Outcome {
        state: if selected.is_some() {
            "explicit-route"
        } else {
            "fallback"
        }
        .into(),
        route: selected,
    }
}
pub(crate) fn description(outcome: &Outcome, source: &str, session: Option<&str>) -> Value {
    let mut value = delivery::routing_description(outcome.route.is_some(), &outcome.state);
    if matches!(
        outcome.state.as_str(),
        "notice-no-resource-overlap" | "notice-board-unavailable"
    ) {
        value["next"] = json!({"via":"query","op":"messages","args":{},"actor":"recipient","sourceId":source,"hint":"This notice remains pullable. Proactive notice delivery requires an overlapping resource in the recipient's active notice or uncleared blocker on the board."});
        return value;
    }
    value["next"]["sourceId"] = json!(source);
    if let Some(session) = session.filter(|_| outcome.state != "session-closed") {
        value["next"]["op"] = json!("message_route");
        value["next"]["args"] =
            json!({"sessionId":session,"target":"<your verified Claude session ID or URL>"});
    } else if outcome.state == "ambiguous-session-routes" {
        value["next"] = json!({"via":"query","op":"board","args":{"includeSessions":true},"actor":"sender","sourceId":source,
            "hint":"The sender must use message_send.toSessionId for the recipient's intended active session. Ask the recipient which conversation to use; ARC never chooses among distinct explicit conversation routes."});
    }
    value
}
pub(crate) fn session_projection(session: &mut Value) -> Result<()> {
    let source = string(&session["owner"], "sourceId");
    let id = string(session, "id");
    let outcome = if source.is_empty() {
        unavailable("source-required")
    } else if session["state"] == "active" {
        resolve(source, Some(id))?
    } else {
        unavailable("session-closed")
    };
    project_session(session, &outcome);
    Ok(())
}
pub(crate) fn project_session(session: &mut Value, outcome: &Outcome) {
    let mode = if outcome.route.is_some() {
        "proactive"
    } else {
        "pull-only"
    };
    session["deliveryCapability"] = json!(mode);
    session["routing"] = json!({"deliveryMode":mode,"reason":outcome.state});
}
pub(crate) fn status(source: &str) -> Result<Value> {
    let mut value = description(&resolve(source, None)?, source, None);
    let mut sessions = vec![];
    for (id, _, _) in bulletin::session_routes(source)? {
        let mut session = description(&resolve(source, Some(&id))?, source, Some(&id));
        session["sessionId"] = json!(id);
        session["deliveryCapability"] = session["deliveryMode"].clone();
        sessions.push(session);
    }
    value["sessions"] = json!(sessions);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn route(destination: &str) -> Route {
        serde_json::from_value(json!({"sourceId":"peer","routeId":destination,"generation":"verified","bindingId":"binding"})).unwrap()
    }
    #[test]
    // Regression: ax-ce733eee session routing and source-addressed mail disagreed when fallback targets were ambiguous.
    fn explicit_sessions_never_choose_an_arbitrary_conversation() {
        let mut sessions = vec![("first".into(), Some(route("one")), None)];
        assert_eq!(select(&sessions, Some("first")).route, Some(route("one")));
        assert_eq!(select(&sessions, None).route.unwrap().key(), "one");
        sessions.push(("second".into(), Some(route("two")), None));
        for _ in 0..2 {
            assert_eq!(select(&sessions, None).state, "ambiguous-session-routes");
            assert!(select(&sessions, None).route.is_none());
            let status = description(&select(&sessions, None), "peer", None);
            assert_eq!(status["next"]["op"], "board");
            assert_eq!(status["next"]["actor"], "sender");
            sessions.reverse();
        }
        assert_eq!(select(&sessions, Some("second")).route, Some(route("two")));
        assert_eq!(select(&sessions, Some("closed")).state, "session-closed");
    }
    #[test]
    // Regression: ax-ce733eee invalid registration targets must stay pull-only even if a different fallback target is verified.
    fn failed_registration_does_not_fall_back_to_another_conversation() {
        for reason in ["invalid-claude-session", "no-verified-target"] {
            let sessions = vec![("session".into(), None, Some(reason.into()))];
            assert_eq!(select(&sessions, Some("session")).state, reason);
            assert!(select(&sessions, Some("session")).route.is_none());
            assert_eq!(select(&sessions, None).state, reason);
        }
        assert_eq!(
            select(&[("session".into(), None, None)], Some("session")).state,
            "fallback"
        );
    }
    #[test]
    // Regression: ax-ce733eee board sessions reported pull-only after message_route returned proactive.
    fn delivery_projection_and_recipient_fix_use_the_effective_route() {
        let mut session = json!({"id":"session","owner":{"sourceId":"peer"},"state":"active"});
        for outcome in [
            Outcome {
                route: Some(route("one")),
                state: "explicit-route".into(),
            },
            unavailable("route-target-unverified"),
            unavailable("no-verified-target"),
            unavailable("session-closed"),
        ] {
            project_session(&mut session, &outcome);
            let status = description(&outcome, "peer", Some("session"));
            assert_eq!(session["deliveryCapability"], status["deliveryMode"]);
            assert_eq!(session["routing"]["reason"], status["reason"]);
            assert_eq!(status["next"]["actor"], "recipient");
            if outcome.state != "session-closed" {
                assert_eq!(status["next"]["op"], "message_route");
                assert_eq!(status["next"]["args"]["sessionId"], "session");
            }
        }
    }
}
