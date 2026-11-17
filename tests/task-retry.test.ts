import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("latest failed cards offer keyboard retry in narrow panels and reuse uncertain receipts", async () => {
  // Recurring bug class: 2d1f7d3 left failed outcome cards with Copy log only and no Retry action.
  const window = new Window({ url: "http://localhost" });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 320 });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, Event: window.Event, CustomEvent: window.CustomEvent,
    CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage, ResizeObserver: Observer, matchMedia: window.matchMedia,
    innerWidth: 320, innerHeight: 800, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  let sent: any, first: any, rejectNext = true, timeline: any;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace("/api/", ""), body = JSON.parse(String(init?.body || "{}"));
    if (path.startsWith("agents/timeline/")) return new Response(JSON.stringify(timeline));
    if (path.startsWith("tasks/runtime/")) return new Response(JSON.stringify({ title: "Sample failed task" }));
    if (["codex_send", "agent_send"].includes(body.op)) {
      sent = body;
      if (rejectNext) { first = body; rejectNext = false; throw new Error("Response unavailable"); }
      return new Response(JSON.stringify({ state: "completed", requestId: body.args.requestId, result: { turnId: "continued" } }));
    }
    return new Response(JSON.stringify({ items: [], records: [], reviews: [] }));
  };
  try {
    const { default: Detail } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t, locale } = await server.ssrLoadModule("/ui/i18n.ts");
    const session = { id: "failed-task", source: "arc-task", turnId: "stale-turn", timeline: true, phase: "idle", phaseSince: null, headline: "", orderAt: 0 };
    const entries = [{ id: "prompt", turnId: "failed-turn", type: "user", status: "completed", text: "Original task instruction", startedAt: null, updatedAt: "", cursor: 1 },
      { id: "error", turnId: "failed-turn", type: "error", status: "failed", text: "SOURCE_REVOKED", startedAt: null, updatedAt: "", cursor: 2 }];
    const render = async (agent: string, status = "failed") => {
      timeline = { status, entries, cursor: 2, coverage: { state: "complete" }, turnStatuses: { "failed-turn": status }, dispatchSummary: { model: "sample-model", controlSource: { kind: "ARC" } } };
      await act(async () => root.render(h(TooltipProvider, null, h(Detail, { key: `${agent}:${status}`, agent, session, expanded: false, onToggleWidth() {}, onBack() {} }))));
    };
    const page = within(document.body);
    for (const language of ["en", "zh-CN"]) {
      await act(() => locale.set(language));
      await render("codex");
      const card = within(page.getByRole("article", { name: t("detail.turnFailed") }));
      const retry = card.getByRole("button", { name: t("detail.retry"), exact: true });
      assert.ok(card.getByRole("button", { name: t("detail.copyLog"), exact: true }));
      assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
      await act(async () => { retry.focus(); fireEvent.keyDown(retry, { key: "Enter" }); fireEvent.click(retry, { detail: 0 }); });
      assert.equal(sent.op, "codex_send");
      assert.equal(sent.args.threadId, session.id);
      assert.equal(sent.args.sendMode, "next");
      assert.notEqual(sent.args.prompt, entries[0].text);
      assert.ok(sent.args.prompt.includes("failed-turn"));
      await act(async () => fireEvent.click(retry, { detail: 0 }));
      assert.deepEqual(sent, first);
      await render("pi");
      const agentCard = within(page.getByRole("article", { name: t("detail.turnFailed") }));
      await act(async () => fireEvent.click(agentCard.getByRole("button", { name: t("detail.retry"), exact: true }), { detail: 0 }));
      assert.equal(sent.op, "agent_send");
      assert.equal(sent.args.agent, "pi");
      assert.equal(sent.args.taskId, session.id);
      await render("codex", "completed");
      assert.equal(page.queryByRole("button", { name: t("detail.retry"), exact: true }), null);
      rejectNext = true;
    }
  } finally { await act(() => root.unmount()); globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close(); }
});
