import test from "node:test";
import assert from "node:assert/strict";
import { activeOverrides, clockNow, environmentModel, type EnvSample } from "../ui/state/appEnvModel.ts";

const sample: EnvSample = { active: true, expiresAt: 100_000, realNowMs: 1000,
  overrides: { reducedMotion: true, colorScheme: "dark", locale: "zh-CN", windowWidth: 320, windowHeight: 900, taskPanelWidth: 320, presence: "present" },
  clock: { value: { nowMs: 5000, speed: 0 }, source: "override" } };
const system = { reducedMotion: false, colorScheme: "light", locale: "en", windowWidth: 320, windowHeight: 900, taskPanelWidth: 300, presence: false };

test("snapshot reports every effective environment value and its provenance", () => {
  // Contract: model.env exposes every override with source and reports observed widths, including clamping.
  const env = environmentModel(sample, 2000, system);
  for (const key of ["reducedMotion", "colorScheme", "locale", "presence", "windowWidth", "windowHeight", "taskPanelWidth", "clock"] as const) assert.equal(env[key].source, "override");
  assert.equal(env.reducedMotion.value, true);
  assert.equal(env.colorScheme.value, sample.overrides.colorScheme);
  assert.equal(env.locale.value, sample.overrides.locale);
  assert.equal(env.presence.value, true);
  assert.equal(env.windowWidth.value, system.windowWidth);
  assert.equal(env.taskPanelWidth.value, system.taskPanelWidth);
  assert.equal(env.taskPanelWidth.requested, sample.overrides.taskPanelWidth);
  assert.equal(env.clock.value.nowMs, 5000);
  assert.equal(env.active, true);
});

test("expiry and clear restore system values even with a frozen clock", () => {
  // Algorithmic core: real-time expiry and absence of a sample override every simulated input.
  for (const [state, now] of [[sample, 100_000], [undefined, 2000]] as const) {
    const env = environmentModel(state, now, system);
    assert.equal(env.active, false);
    for (const key of ["reducedMotion", "colorScheme", "locale", "presence", "windowWidth", "windowHeight", "taskPanelWidth"] as const) {
      assert.equal(env[key].source, "system"); assert.equal(env[key].value, system[key]);
    }
    assert.deepEqual(env.clock, { value: { nowMs: now, speed: 1 }, source: "system" });
    assert.deepEqual(activeOverrides(state, now), {});
  }
});

test("clock speed changes UI relative time without modifying the real clock", () => {
  // Algorithmic core: virtual time is an affine transformation of real time until real-time expiry.
  for (const speed of [0, 0.5, 1, 10, 100]) {
    const next = { ...sample, clock: { ...sample.clock, value: { nowMs: 7000, speed } } };
    assert.equal(clockNow(next, 2000), 7000 + 1000 * speed);
    assert.equal(clockNow(next, 100_000), 100_000);
  }
});

test("explicit false, absence, light and English remain overrides", () => {
  // Contract: falsy environment values are explicit overrides, while omitted presence follows the system.
  const state = { ...sample, overrides: { reducedMotion: false, presence: "absent" as const, colorScheme: "light" as const, locale: "en" as const } };
  const env = environmentModel(state, 2000, { ...system, reducedMotion: true, presence: true });
  assert.deepEqual(env.reducedMotion, { value: false, source: "override" });
  assert.deepEqual(env.presence, { value: false, source: "override" });
  assert.equal(env.colorScheme.source, "override"); assert.equal(env.locale.source, "override");
  assert.deepEqual(environmentModel({ ...state, overrides: {} }, 2000, system).presence, { value: false, source: "system" });
});
