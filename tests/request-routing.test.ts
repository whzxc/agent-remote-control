import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("dock interaction pauses routing and explicit controls preserve answering", async () => {
  // Regression: pending questions routed during answering; stable routing labels appeared twice in DOM fixture captures.
  const window = new Window({ url: "http://localhost" });
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    innerWidth: 320, innerHeight: 760, Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, Event: window.Event,
    PointerEvent: window.PointerEvent, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: Observer, matchMedia: window.matchMedia, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0), cancelAnimationFrame: clearTimeout });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  let routing = { state: "deferred", deferUntil: Date.now() + 15000, pausedBy: null as string | null, reason: "user-present" };
  let submitted: unknown;
  let failRouting = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace("/api/", ""), body = JSON.parse(String(init?.body || "{}"));
    if (path === "tasks/request-routing") {
      if (failRouting) throw new Error("SCENARIO_ACTION_UNAVAILABLE: tasks/request-routing");
      if (body.action === "pause") routing = { ...routing, state: "paused", pausedBy: "user" };
      if (body.action === "resume") routing = { ...routing, state: "deferred", pausedBy: null };
      if (body.action === "handoff") routing = { ...routing, state: "routed", pausedBy: null };
      return new Response(JSON.stringify({ routing }));
    }
    if (path === "agents/respond") { submitted = body.args.result; return new Response(JSON.stringify({ state: "completed", result: { responseSent: true, resolved: true } })); }
    return new Response("{}");
  };
  try {
    const { default: Dock } = await server.ssrLoadModule("/ui/components/TaskNeedsYou.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const interaction = { kind: "question", summary: "Choose a route", method: "request_user_input_async", options: ["One", "Two"], respond: { via: "act", op: "codex_respond", args: { id: "question", backendSession: "fixture" } } };
    const session = { id: "task", source: "arc-task", phase: "interaction", phaseSince: null, headline: "", timeline: true, interaction };
    const source = "Fixture source";
    const render = async (key: string, narrow: boolean) => {
      await act(async () => root.render(h(TooltipProvider, null, h(Dock, { key, agent: "codex", session, entries: [], source, narrow }))));
    };
    const page = within(document.body);
    failRouting = true;
    for (const narrow of [false, true]) {
      await render(`unavailable-${narrow}`, narrow);
      if (narrow) await act(async () => fireEvent.click(page.getByRole("button", { name: new RegExp(t("detail.openRequest")) })));
      assert.equal(page.queryByRole("alert"), null);
      assert.equal(page.queryByRole("status"), null);
      assert.ok(!document.body.textContent.includes("SCENARIO_ACTION_UNAVAILABLE"));
      await act(async () => fireEvent.click(page.getByRole("radio", { name: /One/ })));
      assert.equal((page.getByRole("button", { name: t("detail.sendAnswer") }) as HTMLButtonElement).disabled, false);
    }
    failRouting = false;
    routing.state = "not-routable";
    await render("next-check", false);
    assert.equal(page.getAllByText(t("routing.nextCheck")).length, 1);
    assert.equal(page.getByRole("status").textContent, t("routing.nextCheck"));
    assert.equal(page.queryByRole("button", { name: t("routing.pause") }), null);
    assert.equal(page.queryByRole("button", { name: t("routing.handoff", { source }) }), null);
    routing = { ...routing, state: "deferred", deferUntil: Date.now() + 4000 };
    await render("soon", false);
    assert.equal(page.getByRole("status").textContent, t("routing.soon", { source }));
    routing.deferUntil = Date.now() + 15000;
    await render("countdown", true);
    const click = async (node: HTMLElement) => { await act(async () => fireEvent.click(node)); };
    await click(page.getByRole("button", { name: t("detail.openRequest"), exact: true }));
    assert.ok(page.getByRole("dialog", { name: t("detail.needsYou") }));
    assert.equal(page.getAllByText(t("routing.paused")).length, 1);
    await click(page.getByRole("button", { name: t("routing.resume") }));
    const input = page.getByRole("textbox");
    await act(async () => input.focus());
    assert.ok(page.getByRole("button", { name: t("routing.resume") }));
    await click(page.getByRole("button", { name: t("routing.resume") }));
    assert.ok(page.getByRole("button", { name: t("routing.pause") }));
    await act(async () => fireEvent.input(input, { target: { value: "Custom route" } }));
    assert.ok(page.getByRole("button", { name: t("routing.resume") }));
    await click(page.getByRole("button", { name: t("routing.resume") }));
    await click(page.getByRole("radio", { name: /One/ }));
    assert.ok(page.getByRole("button", { name: t("routing.resume") }));
    await click(page.getByRole("button", { name: t("routing.handoff", { source }) }));
    assert.equal(page.queryByRole("button", { name: t("routing.resume") }), null);
    assert.equal(page.queryByRole("button", { name: t("routing.pause") }), null);
    assert.equal(page.getAllByText(t("routing.routed", { source })).length, 1);
    await click(page.getByRole("button", { name: t("detail.sendAnswer") }));
    assert.deepEqual(submitted, { answer: "One" });
  } finally {
    await act(() => root.unmount()); globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close();
  }
});
