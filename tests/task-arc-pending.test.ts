import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

// Native task_panel and opened-session capture, with identities and content sanitized.
const capture = JSON.parse(readFileSync(new URL("./fixtures/arc-source-pending.json", import.meta.url), "utf8"));
test("ARC-local pending requests drive both the dock and header after an earlier answered turn", async () => {
  // Regression: 1fa3ac0 excluded a native ARC-origin question from the footer and left the header running.
  const window = new Window({ url: "http://localhost" });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, Event: window.Event, CustomEvent: window.CustomEvent,
    CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage, ResizeObserver: Observer, matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  let answered: Record<string, unknown> | undefined, routeId: unknown;
  const pending = capture.timeline.entries.find((e: { status: string; type: string }) => e.type === "interaction" && e.status === "pending");
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace("/api/", ""), body = JSON.parse(String(init?.body || "{}"));
    if (path === "agents/conversations/timeline") return new Response(JSON.stringify(capture.timeline));
    if (path.startsWith("tasks/runtime/")) return new Response(JSON.stringify({ title: capture.session.title }));
    if (path === "tasks/request-routing") { routeId = body.id; return new Response(JSON.stringify({ routing: { state: "not-routable", deferUntil: null, pausedBy: null, reason: "no-verified-push-path" } })); }
    if (path === "agents/respond") { answered = body.args; return new Response(JSON.stringify({ state: "completed", result: { responded: true } })); }
    return new Response(JSON.stringify({ items: [], records: [], reviews: [] }));
  };
  try {
    const { default: Detail } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { taskPanelSnapshot } = await server.ssrLoadModule("/ui/state/taskPanel.ts");
    const { pendingSessions } = await server.ssrLoadModule("/ui/state/taskInteractions.ts");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    // The panel retained the first turn's session; current turn identity comes from task_panel.
    const live = { ...capture.session, turnId: capture.turnId, interaction: pending.interaction };
    assert.deepEqual(pendingSessions("codex", capture.session, capture.timeline.entries), []);
    assert.deepEqual(pendingSessions("codex", live, capture.timeline.entries).map((s: any) => s.interaction.respond.args.id), [pending.interaction.respond.args.id]);
    const unavailable = capture.timeline.entries.map((e: any) => e === pending ? { ...e, interaction: { ...e.interaction, canRespond: false } } : e);
    assert.deepEqual(pendingSessions("codex", live, unavailable), []);
    await act(async () => {
      agentActivity.set({ error: "", snapshot: { observedAt: "", activeAgents: ["codex"], agents: { codex: { sessions: [live] } } } });
      root.render(h(TooltipProvider, null, h(Detail, { agent: "codex", session: capture.session, expanded: false, onToggleWidth() {}, onBack() {} })));
    });
    const page = within(document.body);
    const dock = within(page.getByRole("region", { name: t("detail.needsYou") }));
    assert.equal(taskPanelSnapshot().state, "needsYou");
    assert.ok(page.getByText(t("detail.state.needsYou"), { exact: true }));
    assert.equal(routeId, pending.interaction.respond.args.id);
    await act(async () => fireEvent.click(dock.getByRole("radio", { name: /Option A/ })));
    await act(async () => fireEvent.click(dock.getByRole("button", { name: t("detail.sendAnswer"), exact: true })));
    assert.equal(answered?.id, pending.interaction.respond.args.id);
    assert.equal(answered?.backendSession, pending.interaction.respond.args.backendSession);
    assert.deepEqual(answered?.result, { answers: { second_sample: { answers: ["Option A"] } } });
    assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
    assert.equal(taskPanelSnapshot().state, "running");
  } finally { await act(() => root.unmount()); globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close(); }
});
