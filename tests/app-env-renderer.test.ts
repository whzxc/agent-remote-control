import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";

test("environment API updates the live snapshot without changing saved preferences", async () => {
  // Recurring bug class: acceptance changed host Reduce Motion because the live renderer had no environment control/read-back.
  const previousFetch = globalThis.fetch;
  const window = new Window({ url: "http://localhost" });
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, CustomEvent: window.CustomEvent,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 320, innerHeight: 800, devicePixelRatio: 1,
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const now = Date.now();
  let response: Record<string, unknown> = { active: true, expiresAt: now + 60_000, realNowMs: now,
    overrides: { reducedMotion: true, colorScheme: "dark", locale: "zh-CN", windowWidth: 320, windowHeight: 1000, taskPanelWidth: 320, presence: "present" },
    clock: { value: { nowMs: now, speed: 0 }, source: "override" } };
  globalThis.fetch = async input => {
    assert.equal(String(input), "/api/app/env");
    return new Response(JSON.stringify(response), { status: 200 });
  };
  try {
    const { refreshAppEnvironment } = await server.ssrLoadModule("/ui/state/appEnvironment.ts");
    const { viewModel } = await server.ssrLoadModule("/ui/acceptance.ts");
    const { theme } = await server.ssrLoadModule("/ui/theme.ts");
    const { language } = await server.ssrLoadModule("/ui/i18n.ts");
    const saved = { theme: theme.get(), language: language.get() };
    await refreshAppEnvironment();
    let model = viewModel();
    assert.equal(model.theme, "dark");
    assert.equal(model.language, response.overrides && (response.overrides as Record<string, unknown>).locale);
    for (const key of ["reducedMotion", "colorScheme", "locale", "windowWidth", "windowHeight", "taskPanelWidth", "presence", "clock"]) assert.equal(model.env[key].source, "override");
    assert.equal(model.env.windowWidth.value, innerWidth);
    assert.equal(model.env.taskPanelWidth.value, null, "a closed panel has no observed width");
    assert.equal(model.env.reducedMotion.value, true);
    assert.equal(model.env.presence.value, true);
    assert.equal(model.env.clock.value.nowMs, now);
    response = { ...response, overrides: { reducedMotion: false, colorScheme: "light", locale: "en", presence: "absent" }, clock: { value: { nowMs: now + 15_000, speed: 0 }, source: "override" } };
    await refreshAppEnvironment();
    model = viewModel();
    assert.equal(model.theme, "light");
    assert.equal(model.env.reducedMotion.value, false);
    assert.equal(model.env.presence.value, false);
    assert.equal(model.env.clock.value.nowMs, now + 15_000);
    response = { active: false, expiresAt: null, realNowMs: now, overrides: {}, clock: { value: { nowMs: now, speed: 1 }, source: "system" } };
    await refreshAppEnvironment();
    model = viewModel();
    assert.equal(model.env.active, false);
    for (const key of ["reducedMotion", "colorScheme", "locale", "windowWidth", "windowHeight", "taskPanelWidth", "presence", "clock"]) assert.equal(model.env[key].source, "system");
    assert.deepEqual({ theme: theme.get(), language: language.get() }, saved);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await window.happyDOM.abort();
  }
});
