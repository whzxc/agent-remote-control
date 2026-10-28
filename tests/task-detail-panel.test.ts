import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("task detail projects native titles, compact ownership and pending input without resident controls", { timeout: 10000 }, async () => {
  // Regression: prompt-derived titles and expanded ownership displaced header metadata; revoked queue reads appeared on every task.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    innerWidth: 840, innerHeight: 578, Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  let nativeTitle = "Native thread title", observedResume: unknown, revision = 0;
  let timeline: Record<string, any>;
  globalThis.fetch = async (input, init) => {
    const route = String(input).replace("/api/", ""), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (route.startsWith("tasks/runtime/")) return new Response(JSON.stringify({ title: nativeTitle }));
    if (route.startsWith("agents/timeline/")) return new Response(JSON.stringify(timeline));
    if (route === "tasks") return new Response(JSON.stringify({ records: [] }));
    if (route === "agents/dispatch-catalog") return new Response(JSON.stringify({ models: [] }));
    if (route === "tasks/reviews") return new Response(JSON.stringify({ reviews: [] }));
    if (body.op === "codex_queue") return new Response(JSON.stringify({ error: "SOURCE_REVOKED" }), { status: 400 });
    if (body.op === "codex_resume") { observedResume = body.args; return new Response(JSON.stringify({ state: "completed" })); }
    throw new Error(`Unexpected task detail request: ${route}`);
  };
  try {
    const { default: ActivityTimeline } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t, locale } = await server.ssrLoadModule("/ui/i18n.ts");
    const dispatch = "You are working in an assigned coding lane";
    const entry = (id: string, turnId: string, type: string, text: string, extra = {}) => ({ id, turnId, type, text, status: "completed", startedAt: null, updatedAt: "", cursor: 1, ...extra });
    const observedAt = new Date(Date.now() - 120000).toISOString();
    const ownership = { owner: "desktop", currentOwner: "desktop", state: "held", observedAt };
    const source = { kind: "claude", label: "Fixture control source" };
    const session = { id: "detail", title: dispatch, turnId: "current", source: "arc-task", phase: "text", headline: "", phaseSince: null, orderAt: 0, timeline: true };
    const base = { sessionId: session.id, status: "interrupted", cursor: 1, coverage: { state: "complete" }, ownership,
      dispatchSummary: { model: "fixture-model", effort: "high", serviceTier: "priority", controlSource: source },
      turnStatuses: { first: "completed", second: "failed", current: "interrupted" }, entries: [
        entry("prompt-1", "first", "user", dispatch), entry("final-1", "first", "text", "Finished the first turn\nMore detail", { phase: "final_answer" }),
        entry("prompt-2", "second", "user", dispatch), entry("error-2", "second", "error", "A task-specific failure", { status: "failed" }),
        entry("prompt-3", "current", "user", dispatch),
      ] };
    const render = async (next: Record<string, any>, live = false) => {
      timeline = next;
      await act(async () => {
        agentActivity.set({ error: "", snapshot: { observedAt: "", activeAgents: live ? ["codex"] : [], agents: { codex: { sessions: live ? [session] : [] } } } });
        root.render(h(TooltipProvider, null, h(ActivityTimeline, { key: ++revision, agent: "codex", session, expanded: false, onToggleWidth() {}, onBack() {} })));
      });
    };
    const page = within(document.body);
    for (const language of ["en", "zh-CN"]) {
      await act(() => locale.set(language));
      await render(base);
      assert.ok(page.getByRole("heading", { name: nativeTitle }));
      assert.equal(page.queryByRole("heading", { name: dispatch }), null);
      assert.ok(page.getByRole("button", { name: /Finished the first turn/ }));
      assert.ok(page.getByRole("button", { name: new RegExp(t("detail.noFinalReply")) }));
      assert.equal(page.queryByRole("button", { name: new RegExp(dispatch) }), null);
      assert.equal(page.queryByRole("alert"), null);
      assert.equal(page.queryByRole("textbox"), null);
      assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
      const outcome = page.getByRole("article", { name: t("detail.leftAsIs") });
      await act(() => fireEvent.click(within(outcome).getByRole("button", { name: t("detail.resumeInterrupted"), exact: true })));
      assert.equal((observedResume as { threadId: string }).threadId, session.id);
      assert.equal((observedResume as { turnId: string }).turnId, session.turnId);
      const ownerName = t("detail.owner", { owner: t("detail.owner.desktop") });
      assert.ok(page.getByLabelText(ownerName));
      assert.equal(page.queryByRole("button", { name: ownerName }), null);
      await render({ ...base, ownership: { owner: "connector", currentOwner: "connector", state: "held" } });
      assert.ok(page.getByLabelText(t("detail.owner", { owner: t("detail.owner.connector") })));
      await render({ ...base, ownership: { owner: "external", currentOwner: "external", state: "held" } });
      assert.equal(page.queryByLabelText(ownerName), null);
      const pending = entry("question", "current", "interaction", "", { status: "pending", interaction: { kind: "question", summary: "A pending choice", method: "item/tool/requestUserInput",
        questions: [{ id: "q", question: "Choose", options: [{ label: "Alpha" }] }], respond: { op: "codex_respond", args: { respondToken: "fixture" } } } });
      const running = { ...base, status: "running", entries: [base.entries.at(-1)] };
      await render(running, true);
      assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
      await render({ ...running, entries: [...running.entries, pending] }, true);
      assert.ok(page.getByRole("region", { name: t("detail.needsYou") }));
      assert.equal((page.getByRole("button", { name: t("detail.sendAnswer"), exact: true }) as HTMLButtonElement).disabled, true);
      await render({ ...running, status: "completed", entries: [...running.entries, pending] });
      assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
      for (const key of ["detail.send", "detail.pass", "detail.rework", "detail.undo"]) assert.equal(page.queryByRole("button", { name: t(key), exact: true }), null);
      nativeTitle = "";
      await render(base);
      assert.ok(page.getByRole("heading", { name: t("timeline.title") }));
      nativeTitle = "Native thread title";
    }
    const { installScenario, scenarioResponse } = await server.ssrLoadModule("/ui/scenarios.ts");
    const { setPrivacy } = await server.ssrLoadModule("/ui/state/privacy.ts");
    globalThis.fetch = async (input, init) => new Response(JSON.stringify(scenarioResponse(String(input).replace("/api/", ""), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined)));
    for (const [scenario, key] of [["task-turn-failed", "detail.retry"], ["task-turn-interrupted", "detail.resumeInterrupted"]]) {
      await act(async () => { await installScenario(scenario); setPrivacy(false); });
      const records = scenarioResponse("tasks", "GET").records;
      const id = records[0].threadId;
      const payload = scenarioResponse(`agents/timeline/${id}`, "GET");
      assert.equal(scenarioResponse("agents/activity", "GET").agents.codex.sessions.length, 0);
      await act(async () => root.render(h(TooltipProvider, null, h(ActivityTimeline, { key: ++revision, agent: "codex",
        session: { id, title: records[0].task.title, source: "codex-thread", phase: "idle", phaseSince: null, headline: "", timeline: true, orderAt: 0, endedAt: Date.now() },
        expanded: false, onToggleWidth() {}, onBack() {} }))));
      assert.ok(page.getByRole("button", { name: t(key), exact: true }));
      assert.equal(page.queryByRole("textbox"), null);
      assert.equal(page.queryByRole("region", { name: t("detail.needsYou") }), null);
      for (const action of ["detail.send", "detail.stop", "detail.pass", "detail.rework"]) assert.equal(page.queryByRole("button", { name: t(action), exact: true }), null);
      assert.equal(payload.entries.some((row: {phase?:string}) => row.phase === "final_answer"), false);
    }
    const { default: AgentPanel } = await server.ssrLoadModule("/ui/components/AgentPanel.tsx");
    const { selectAgentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    for (const scenario of ["task-owner-desktop", "task-turn-interrupted"]) {
      await act(async () => { await installScenario(scenario); setPrivacy(false); });
      const record = scenarioResponse("tasks", "GET").records[0];
      await act(async () => {
        selectAgentPanel({ type: "task", agent: "codex", session: { id: record.threadId, source: "codex-thread", phase: "idle", phaseSince: null, headline: "", timeline: true, orderAt: 0 } });
        root.render(h(TooltipProvider, null, h(AgentPanel, { key: scenario, agent: {agent:"codex"}, expanded:false, onSettings(){}, onPanelFrame(){}, onToggleWidth(){} })));
      });
      assert.ok(page.getByRole("dialog", { name: record.task.title, exact: true }));
      await act(() => selectAgentPanel({ type: "back" }));
      assert.ok(page.getByRole("dialog", { name: "Codex", exact: true }));
    }
  } finally { await act(() => root.unmount()); globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close(); }
});
