use arc_core::control::reconcile_active_configuration;
use serde_json::json;

#[test]
fn steer_restates_default_when_native_tier_is_unreported() {
    // Regression: steer restating serviceTier default failed when the native active turn omitted its tier.
    let active = json!({"id":"active"});
    let records = vec![
        json!({"turnId":"previous","serviceTier":"fast"}),
        json!({"turnId":"active","dispatchMode":"new-turn","model":"model","effort":"high","serviceTier":"default"}),
        json!({"turnId":"active","dispatchMode":"steered","serviceTier":"fast"}),
    ];
    let mut dispatch = json!({"model":"model","effort":"high","serviceTier":"default","source":{"model":"explicit","effort":"explicit","serviceTier":"explicit"}});
    reconcile_active_configuration(&mut dispatch, &active, &json!({}), &records).unwrap();
    assert_eq!(dispatch["serviceTier"], "default");
    assert_eq!(dispatch["source"]["serviceTier"], "active-turn");
    let mut unknown = json!({"serviceTier":"default","source":{"serviceTier":"explicit"}});
    reconcile_active_configuration(&mut unknown, &active, &json!({}), &records[..1]).unwrap();
    assert_eq!(unknown["serviceTier"], "unknown");
    assert_eq!(unknown["source"]["serviceTier"], "active-turn");
}

#[test]
fn steer_rejects_a_known_configuration_change() {
    // Regression: active-turn configuration changes must remain rejected when steering.
    let mut dispatch = json!({"serviceTier":"fast","source":{"serviceTier":"explicit"}});
    let error = reconcile_active_configuration(
        &mut dispatch,
        &json!({"id":"active","serviceTier":"default"}),
        &json!({}),
        &[json!({"turnId":"active","serviceTier":"fast"})],
    )
    .unwrap_err();
    assert_eq!(error, "ACTIVE_TURN_CONFIGURATION: cannot change model/effort/serviceTier with steer; wait for completion or use sendMode:queue");
}
