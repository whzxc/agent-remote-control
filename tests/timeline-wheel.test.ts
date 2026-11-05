import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("nested timeline content sends vertical wheel deltas to the timeline and keeps horizontal scrolling local", async () => {
  // Regression: tables contained vertical wheel scrolling until the pointer left the table.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  let viewport: HTMLElement | undefined;
  const lefts = new Map<HTMLElement, number>(), tops = new Map<HTMLElement, number>();
  // Happy DOM has no layout or native scrolling. Supply scroll ranges, but let
  // the mounted component deliver synthetic wheel events to the actual owners.
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 320 },
    scrollWidth: { configurable: true, get() { return this === viewport ? 320 : 960; } },
    clientHeight: { configurable: true, get: () => 300 },
    scrollHeight: { configurable: true, get: () => 3000 },
    scrollLeft: { configurable: true, get() { return lefts.get(this) ?? 0; }, set(value: number) { lefts.set(this, value); } },
    scrollTop: { configurable: true, get() { return tops.get(this) ?? 0; }, set(value: number) { tops.set(this, Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value))); } },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  const tableText = "| Column | Value |\n| --- | --- |\n| Table cell | Wide value |";
  const code = "const codeBlock = 'wide content';", log = "Command log output", diff = "+added diff line";
  const entry = (id: string, type: string, text: string, extra = {}) => ({ id, turnId: "turn", type, text, status: "completed", startedAt: null, updatedAt: "", cursor: 1, ...extra });
  const session = { id: "wheel", title: "Wheel task", turnId: "turn", source: "arc-task", phase: "text", headline: "", phaseSince: null, orderAt: 0, timeline: true };
  let timeline = { sessionId: session.id, status: "running", cursor: 1, coverage: { state: "complete" }, entries: [
    entry("message", "text", `${tableText}\n\n\`\`\`js\n${code}\n\`\`\``, { phase: "commentary" }),
    entry("command", "command", "", { command: "fixture-command", status: "running", output: { text: log } }),
    entry("file", "file", "", { path: "example.ts", operation: "edit", changes: [{ path: "example.ts", diff: { text: diff } }] }),
  ] };
  globalThis.fetch = async input => {
    const route = String(input).replace("/api/", "");
    if (route.startsWith("agents/timeline/")) return new Response(JSON.stringify(timeline));
    if (route.startsWith("tasks/runtime/")) return new Response(JSON.stringify({ title: session.title }));
    if (route === "tasks") return new Response(JSON.stringify({ records: [] }));
    throw new Error(`Unexpected wheel fixture request: ${route}`);
  };
  try {
    const { default: ActivityTimeline } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    let revision = 0;
    const render = async (live: boolean) => act(async () => {
      agentActivity.set({ error: "", snapshot: { observedAt: "", activeAgents: live ? ["codex"] : [], agents: { codex: { sessions: live ? [session] : [] } } } });
      root.render(h(ActivityTimeline, { key: ++revision, agent: "codex", session, expanded: false, onToggleWidth() {}, onBack() {} }));
    });
    const page = within(mount);
    const wheel = async (target: Element, init: WheelEventInit) => {
      const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      // Happy DOM's WheelEvent extends UIEvent and omits MouseEvent modifiers.
      Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey ?? false });
      await act(() => { target.dispatchEvent(event); });
      return event;
    };
    const verifyAxes = async (target: HTMLElement) => {
      const node = viewport!;
      lefts.clear(); node.scrollTop = node.clientHeight;
      const start = node.scrollTop;
      const vertical = await wheel(target, { deltaY: 80 });
      assert.equal(node.scrollTop, start + vertical.deltaY);
      assert.equal([...lefts.values()].every(left => left === 0), true);
      const horizontal = await wheel(target, { deltaX: 70 });
      assert.equal(node.scrollTop, start + vertical.deltaY);
      assert.equal(node.scrollLeft, 0);
      const nested = [...lefts.keys()].find(element => element !== node && element.contains(target));
      assert.ok(nested);
      assert.equal(nested.scrollLeft, horizontal.deltaX);
      const diagonal = await wheel(target, { deltaX: 20, deltaY: -30 });
      assert.equal(node.scrollTop, start + vertical.deltaY + diagonal.deltaY);
      assert.equal(nested.scrollLeft, horizontal.deltaX + diagonal.deltaX);
      nested.scrollLeft = nested.scrollWidth - nested.clientWidth;
      const atEdge = await wheel(target, { deltaX: 20, deltaY: 30 });
      assert.equal(node.scrollTop, start + vertical.deltaY + diagonal.deltaY + atEdge.deltaY);
      const top = node.scrollTop, left = nested.scrollLeft;
      const zoom = await wheel(target, { deltaY: -60, ctrlKey: true });
      assert.equal(node.scrollTop, top); assert.equal(nested.scrollLeft, left); assert.equal(zoom.defaultPrevented, false);
      node.scrollTop = 0; nested.scrollLeft = 0;
      const boundary = await wheel(target, { deltaY: -40 });
      assert.equal(node.scrollTop, 0); assert.equal(boundary.defaultPrevented, false);
    };
    await render(true);
    viewport = page.getByLabelText(t("timeline.title"));
    await verifyAxes(page.getByRole("table"));
    await verifyAxes(page.getByRole("cell", { name: "Table cell" }));
    await verifyAxes(page.getByText(code));
    await act(() => fireEvent.click(page.getByRole("button", { name: "fixture-command" })));
    await verifyAxes(page.getByText(log));
    await act(() => fireEvent.click(page.getByRole("button", { name: "example.ts" })));
    await verifyAxes(page.getByRole("list"));
    const table = page.getByRole("table");
    viewport.scrollTop = viewport.clientHeight;
    const start = viewport.scrollTop;
    const paged = await wheel(table, { deltaY: 1, deltaMode: 2 });
    assert.equal(viewport.scrollTop, start + paged.deltaY * viewport.clientHeight);
    const unchanged = viewport.scrollTop;
    const uncancelable = await wheel(table, { deltaY: 40, cancelable: false });
    assert.equal(viewport.scrollTop, unchanged); assert.equal(uncancelable.defaultPrevented, false);
    timeline = { ...timeline, status: "interrupted", entries: timeline.entries.map(item => ({ ...item, status: "completed" })) };
    await render(false);
    viewport = page.getByLabelText(t("timeline.title"));
    await act(() => fireEvent.click(page.getByRole("button", { name: t("detail.viewDiff") })));
    await verifyAxes(page.getByText(diff));
  } finally { await act(() => root.unmount()); globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close(); }
});
