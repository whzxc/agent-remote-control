import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { formatMessage } from "../ui/i18nMessage.ts";

test("numeric counts select their locale's plural category and retain interpolation", () => {
  // Property: finite counts select the Intl cardinal category and preserve every supplied placeholder.
  const messages = { value: "base:{count}:{name}", "value.one": "one:{count}:{name}", "value.other": "other:{count}:{name}" };
  for (const locale of ["en", "zh-CN"] as const) {
    const rules = new Intl.PluralRules(locale);
    for (const count of [-2, -1, 0, 0.5, 1, 1.5, 2, 10, 100, 1000]) {
      assert.equal(formatMessage(locale, messages, "value", { count, name: "fixture" }), `${rules.select(count)}:${count}:fixture`);
    }
  }
});

test("known count messages translate across locales through their base key", async () => {
  // Regression: plural variant keys and captured string counts bypassed the selected locale's count form.
  const window = new Window({ url: "http://localhost" });
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  try {
    const { t, locale } = await server.ssrLoadModule("/ui/i18n.ts");
    const { displayMessage } = await server.ssrLoadModule("/ui/messages.ts");
    const { default: en } = await server.ssrLoadModule("/ui/locales/en.json");
    for (const language of ["en", "zh-CN"]) {
      locale.set(language);
      for (const count of [0, 1, 2]) {
        for (const key of ["detail.tools.edit", "detail.tools.tool", "timeline.turnCount"]) {
          const message = formatMessage("en", en, key, { count });
          assert.equal(displayMessage(message), t(key, { count }));
        }
      }
    }
  } finally {
    await server.close();
    await window.happyDOM.close();
  }
});

test("single-form messages and nonnumeric parameters preserve base-message behavior", () => {
  // Property: unavailable categories and absent or nonfinite counts use the base message without inventing translations.
  const messages = { value: "{count}:{name}:{missing}", "value.one": "singular" };
  for (const locale of ["en", "zh-CN"] as const) {
    for (const count of [undefined, "1", null, NaN, Infinity, -Infinity, 0, 2]) {
      assert.equal(formatMessage(locale, messages, "value", { count, name: "fixture" }), `${count ?? ""}:fixture:`);
    }
    for (const count of [0, 1, 2]) {
      assert.equal(formatMessage(locale, { value: "{count}" }, "value", { count }), String(count));
    }
    assert.equal(formatMessage(locale, messages, "absent", { count: 1 }), undefined);
  }
});
