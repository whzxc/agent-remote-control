import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("terminal task reviews load automatically and retry without changing execution results", async () => {
  // Regression: f368ed92 replaced automatic terminal review reads with a disclosure and an empty placeholder.
  const window = new Window({ url: "http://localhost" });
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, location: window.location,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia.bind(window), getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  const beforeFetch = globalThis.fetch;
  let unavailable = true;
  const note = "The sample change is ready.";
  globalThis.fetch = async input => {
    const route = String(input).replace("/api/", "");
    if (route === "tasks/reviews") return unavailable
      ? new Response(JSON.stringify({ error: "Review unavailable" }), { status: 503 })
      : new Response(JSON.stringify({ reviews: [{ turnId: "first", review: { verdict: "pass", requestId: "review", reviewedAt: "2026-01-01T00:00:00Z", note } }] }));
    return new Response(JSON.stringify(route === "tasks/control" ? { items: [] } : {}));
  };
  try {
    const { default: Detail } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const { taskPanelSnapshot } = await server.ssrLoadModule("/ui/state/taskPanel.ts");
    const render = (id: string, turnId: string) => act(async () => root.render(h(TooltipProvider, null, h(Detail, {
      agent: "claude", session: { id, turnId, source: "arc-task", phase: "idle", phaseSince: null,
        headline: "Completed", title: "Sample task", status: "completed", endedAt: 1, orderAt: 0 },
      expanded: false, onToggleWidth() {}, onBack() {},
    }))));
    const page = within(mount);
    const completed = () => assert.equal(taskPanelSnapshot().state, "done");
    await render("sample-task", "first");
    completed();
    const failure = within(page.getByRole("alert"));
    assert.ok(failure.getByRole("button", { name: t("retry"), exact: true }));
    unavailable = false;
    await act(() => fireEvent.click(failure.getByRole("button", { name: t("retry"), exact: true })));
    assert.ok(page.getByText(note, { exact: true }));
    assert.equal(page.queryByRole("alert"), null);
    completed();
    await render("sample-task", "second");
    assert.equal(page.queryByRole("alert"), null);
    assert.equal(page.queryByText(note, { exact: true }), null);
    assert.equal(page.queryByText(t("detail.reviewInfo"), { exact: true }), null);
    assert.equal(taskPanelSnapshot().review, undefined);
    completed();
  } finally { await act(() => root.unmount()); globalThis.fetch = beforeFetch; await server.close(); await window.happyDOM.close(); }
});
