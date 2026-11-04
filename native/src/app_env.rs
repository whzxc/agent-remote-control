//! Explicit, expiring per-instance acceptance inputs. Never part of preferences or exports.
use crate::*;
use serde::{Deserialize, Serialize};
use std::sync::Mutex as SyncMutex;

static SERIAL: SyncMutex<()> = SyncMutex::new(());
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overrides {
    pub reduced_motion: Option<bool>,
    pub color_scheme: Option<String>,
    pub locale: Option<String>,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub task_panel_width: Option<u32>,
    pub presence: Option<String>,
    pub clock: Option<Clock>,
    pub expires_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clock {
    real_at: i64,
    virtual_at: i64,
    speed: f64,
    // Stable across advances and speed changes; clearing a clock ends its routing delays.
    id: String,
}
impl Overrides {
    pub fn clock_now(&self, real: i64) -> i64 {
        self.clock.as_ref().map_or(real, |c| {
            c.virtual_at
                .saturating_add(((real - c.real_at).max(0) as f64 * c.speed) as i64)
        })
    }
    /// Convert a virtual deadline into the first real millisecond that can reach it.
    pub fn real_deadline(&self, deadline: i64, real: i64) -> Option<i64> {
        let remaining = deadline.saturating_sub(self.clock_now(real)).max(0);
        if remaining == 0 {
            return Some(real);
        }
        let speed = self.clock.as_ref().map_or(1.0, |clock| clock.speed);
        (speed > 0.0).then(|| real.saturating_add((remaining as f64 / speed).ceil() as i64))
    }
    pub fn clock_id(&self) -> &str {
        self.clock.as_ref().map_or("system", |c| c.id.as_str())
    }
    pub fn presence(&self, system: bool) -> bool {
        self.presence.as_deref().map_or(system, |p| p == "present")
    }
    pub fn snapshot(&self, real: i64) -> Value {
        json!({"active":self.expires_at.is_some(),"expiresAt":self.expires_at,"overrides":self,
            "clock":{"value":{"nowMs":self.clock_now(real),"speed":self.clock.as_ref().map_or(1.0, |c| c.speed)},"source":if self.clock.is_some(){"override"}else{"system"}},"realNowMs":real})
    }
}
fn invalid() -> String {
    "INVALID_APP_ENV: read guide({op:\"app_env\"}); use action read, set or clear and supported override values".into()
}
/// Pure transition shared by the operation and deterministic contract checks.
pub fn transition(current: &Overrides, args: &Value, real: i64) -> Result<Overrides> {
    let mut next = if current.expires_at.is_some_and(|at| at <= real) {
        Overrides::default()
    } else {
        current.clone()
    };
    let fields = args.as_object().ok_or_else(invalid)?;
    if fields.keys().any(|k| {
        ![
            "action",
            "ttlMs",
            "reducedMotion",
            "colorScheme",
            "locale",
            "windowWidth",
            "windowHeight",
            "taskPanelWidth",
            "presence",
            "clock",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    match args["action"].as_str().unwrap_or("read") {
        "clear" | "read" => {
            if fields.keys().any(|k| k != "action") {
                return Err(invalid());
            }
            return Ok(if args["action"] == "clear" {
                Overrides::default()
            } else {
                next
            });
        }
        "set" => {}
        _ => return Err(invalid()),
    }
    let ttl = if let Some(v) = args.get("ttlMs") {
        v.as_i64()
            .filter(|v| (1..=3_600_000).contains(v))
            .ok_or_else(invalid)?
    } else {
        900_000
    };
    if let Some(v) = args.get("reducedMotion") {
        next.reduced_motion = Some(v.as_bool().ok_or_else(invalid)?);
    }
    for (key, allowed, dest) in [
        (
            "colorScheme",
            &["light", "dark"][..],
            &mut next.color_scheme,
        ),
        ("locale", &["en", "zh-CN"][..], &mut next.locale),
        (
            "presence",
            &["present", "absent", "follow-system"][..],
            &mut next.presence,
        ),
    ] {
        if let Some(v) = args.get(key) {
            let s = v
                .as_str()
                .filter(|s| allowed.contains(s))
                .ok_or_else(invalid)?;
            *dest = if s == "follow-system" {
                None
            } else {
                Some(s.into())
            };
        }
    }
    for (key, dest) in [
        ("windowWidth", &mut next.window_width),
        ("windowHeight", &mut next.window_height),
        ("taskPanelWidth", &mut next.task_panel_width),
    ] {
        if let Some(v) = args.get(key) {
            *dest = Some(
                v.as_u64()
                    .filter(|v| (320..=3840).contains(v))
                    .ok_or_else(invalid)? as u32,
            );
        }
    }
    if let Some(clock) = args.get("clock") {
        let map = clock.as_object().ok_or_else(invalid)?;
        if map.is_empty()
            || map
                .keys()
                .any(|k| !["freeze", "advanceMs", "speed"].contains(&k.as_str()))
        {
            return Err(invalid());
        }
        let mut c = next.clock.clone().unwrap_or(Clock {
            real_at: real,
            virtual_at: real,
            speed: 1.0,
            id: id(),
        });
        c.virtual_at = next.clock_now(real);
        c.real_at = real;
        if let Some(v) = clock.get("speed") {
            c.speed = v
                .as_f64()
                .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
                .ok_or_else(invalid)?;
        }
        if let Some(v) = clock.get("freeze") {
            if v.as_bool().ok_or_else(invalid)? {
                c.speed = 0.0;
            } else if !map.contains_key("speed") {
                c.speed = 1.0;
            }
        }
        if let Some(v) = clock.get("advanceMs") {
            c.virtual_at += v
                .as_i64()
                .filter(|v| (0..=604_800_000).contains(v))
                .ok_or_else(invalid)?;
        }
        next.clock = Some(c);
    }
    next.expires_at = Some(real + ttl);
    Ok(next)
}
fn load_in(dir: &Path, real: i64) -> Result<Overrides> {
    let path = dir.join("app-env.json");
    if !path.exists() {
        return Ok(Overrides::default());
    }
    let value: Overrides = serde_json::from_value(load(&path)?).map_err(|e| e.to_string())?;
    if value.expires_at.is_none_or(|at| at <= real) {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        logs::record("info", "app_env overrides expired; following system", None);
        return Ok(Overrides::default());
    }
    Ok(value)
}
pub fn read() -> Result<Overrides> {
    let _guard = SERIAL.lock().map_err(|e| e.to_string())?;
    load_in(&root(), chrono::Utc::now().timestamp_millis())
}
pub fn control(args: &Value) -> Result<Value> {
    let _guard = SERIAL.lock().map_err(|e| e.to_string())?;
    let real = chrono::Utc::now().timestamp_millis();
    let current = load_in(&root(), real)?;
    let next = transition(&current, args, real)?;
    let action = args["action"].as_str().unwrap_or("read");
    if action != "read" {
        let path = root().join("app-env.json");
        if action == "clear" {
            if path.exists() {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        } else {
            save(&path, &json!(next))?;
        }
        logs::record(
            "info",
            &format!("app_env {action}: {}", next.snapshot(real)),
            None,
        );
    }
    Ok(next.snapshot(real))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_env_each_override_and_readback() {
        // Contract: app_env preserves each explicit override and marks clock provenance.
        let args = json!({"action":"set","reducedMotion":true,"colorScheme":"dark","locale":"zh-CN","windowWidth":320,"windowHeight":900,"taskPanelWidth":320,"presence":"absent","clock":{"freeze":true}});
        let state = transition(&Overrides::default(), &args, 1000).unwrap();
        let read = state.snapshot(9000);
        for key in [
            "reducedMotion",
            "colorScheme",
            "locale",
            "windowWidth",
            "windowHeight",
            "taskPanelWidth",
            "presence",
        ] {
            assert_eq!(read["overrides"][key], args[key]);
        }
        assert_eq!(read["clock"]["source"], "override");
        assert_eq!(read["clock"]["value"]["nowMs"], 1000);
        assert!(!state.presence(true));
        let present = transition(
            &state,
            &json!({"action":"set","presence":"present","reducedMotion":false}),
            2000,
        )
        .unwrap();
        assert!(present.presence(false));
        assert_eq!(present.reduced_motion, Some(false));
        let follow = transition(
            &present,
            &json!({"action":"set","presence":"follow-system"}),
            2000,
        )
        .unwrap();
        assert!(follow.presence(true));
        assert!(!follow.presence(false));
    }
    #[test]
    fn app_env_clock_advance_speed_and_expiration() {
        // Contract: advances and speed preserve clock continuity; real-time TTL and clear restore defaults.
        let frozen = transition(
            &Overrides::default(),
            &json!({"action":"set","clock":{"freeze":true}}),
            1000,
        )
        .unwrap();
        let advanced = transition(
            &frozen,
            &json!({"action":"set","clock":{"advanceMs":15000,"speed":2}}),
            2000,
        )
        .unwrap();
        assert_eq!(advanced.clock_now(3000), 18000);
        assert_eq!(advanced.clock_id(), frozen.clock_id());
        for args in [json!({"action":"clear"}), json!({"action":"read"})] {
            let reset = transition(&advanced, &args, 1_000_000).unwrap();
            assert_eq!(reset.snapshot(1_000_000)["active"], false);
            assert_eq!(reset.snapshot(1_000_000)["clock"]["source"], "system");
            assert_eq!(reset.clock_now(1_000_000), 1_000_000);
            assert_eq!(reset.window_width, None);
        }
    }
    #[test]
    fn virtual_deadlines_map_to_the_first_reachable_real_millisecond() {
        // Property: a real deadline cannot fire before its virtual deadline, and a paused future clock waits for a change.
        let mut env = Overrides::default();
        assert_eq!(env.real_deadline(1400, 1000), Some(1400));
        env.clock = Some(Clock {
            real_at: 1000,
            virtual_at: 5000,
            speed: 2.0,
            id: "clock".into(),
        });
        let at = env.real_deadline(5003, 1000).unwrap();
        assert!(env.clock_now(at) >= 5003);
        assert!(env.clock_now(at - 1) < 5003);
        env.clock.as_mut().unwrap().speed = 0.0;
        assert_eq!(env.real_deadline(5003, 1000), None);
        assert_eq!(env.real_deadline(5000, 1000), Some(1000));
    }
}
