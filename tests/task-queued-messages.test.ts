import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within } from "@testing-library/dom";

test("cancelled queue messages leave task details while pending and failed messages remain", async () => {
  // Regression: cancelled follow-ups stayed below every later turn in task details.
  const window = new Window({ url: "http://localhost" });
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount);
  const root = createRoot(mount);
  try {
    const { default: TaskQueuedMessages } = await server.ssrLoadModule("/ui/components/TaskQueuedMessages.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const message = (queueId: string, state: string) => ({ queueId, threadId: "fixture-thread", state, text: queueId, preview: queueId });
    const followUp = message("Follow-up to cancel", "queued");
    const retained = [message("Blocked follow-up", "blocked"), message("Failed follow-up", "failed"), message("Delivered follow-up", "sent")];
    const render = async (items: ReturnType<typeof message>[], key = "detail") => {
      await act(() => root.render(h(TaskQueuedMessages, { key, queue: { items, error: "" } })));
    };
    const page = within(mount);
    await render([followUp, ...retained]);
    assert.equal(within(page.getByRole("article", { name: t("detail.queueState.queued") })).getByText(followUp.text).textContent, followUp.text);
    const cancelled = { ...followUp, state: "cancelled" };
    const history = [cancelled, ...retained, message("Later follow-up", "queued")];
    for (const key of ["detail", "reopened-detail"]) {
      await render(history, key);
      assert.equal(page.queryByRole("article", { name: t("detail.queueState.cancelled") }), null);
      assert.equal(page.queryByRole("article", { name: t("detail.queueState.sent") }), null);
      for (const state of ["queued", "blocked", "failed"]) assert.ok(page.getByRole("article", { name: t(`detail.queueState.${state}`) }));
    }
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});
