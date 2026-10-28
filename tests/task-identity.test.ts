import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within } from "@testing-library/dom";

test("invalid task identities stay local and valid identities recover detail requests", { timeout: 10000 }, async () => {
  // Regression: id:null activity sessions sent invalid detail, queue, presence, review and routing requests before metadata loaded.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia.bind(window), getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  const beforeFetch = globalThis.fetch;
  const requests: { route: string; body: any }[] = [];
  const id = "00000000-0000-4000-8000-000000000001";
  globalThis.fetch = async (input, init) => {
    const route = String(input).replace("/api/", ""), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (route === "tasks") return new Response(JSON.stringify({ records: [] }));
    requests.push({ route, body });
    if (route.startsWith("tasks/runtime/")) return new Response(JSON.stringify({ title: "Recovered task" }));
    if (route.startsWith("agents/timeline/")) return new Response(JSON.stringify({ sessionId: id, status: "running", cursor: 1, coverage: { state: "complete" }, entries: [] }));
    if (route === "tasks/control") return new Response(JSON.stringify({ items: [{ queueId: "queued", threadId: id, preview: "Recovered queued input", state: "queued" }] }));
    if (route === "tasks/reviews") return new Response(JSON.stringify({ reviews: [] }));
    if (route === "tasks/request-routing") return new Response(JSON.stringify({ routing: { state: "paused", deferUntil: null, pausedBy: "user", reason: "paused" } }));
    return new Response("{}");
  };
  try {
    const { default: Detail } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { useRequestRouting } = await server.ssrLoadModule("/ui/state/requestRouting.ts");
    const { useTaskReview } = await server.ssrLoadModule("/ui/state/taskReview.ts");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t, locale } = await server.ssrLoadModule("/ui/i18n.ts");
    const interaction = { kind: "question", summary: "Choose", respond: { op: "codex_respond", args: { id: "question" } } };
    let routing: ReturnType<typeof useRequestRouting>;
    function Probes({ taskId }: { taskId: unknown }) {
      routing = useRequestRouting("codex", taskId, interaction);
      useTaskReview(taskId, "turn", true);
      return null;
    }
    const page = within(mount);
    const render = async (taskId: unknown) => act(async () => root.render(h(TooltipProvider, null,
      h(Detail, { agent: "codex", session: { id: taskId, source: "codex-thread", phase: "idle", phaseSince: null, headline: "", timeline: true, orderAt: 0, open: { taskId } }, expanded: false, onToggleWidth() {}, onBack() {} }),
      h(Probes, { taskId }))));
    for (const language of ["en", "zh-CN"]) {
      await act(() => locale.set(language));
      for (const taskId of [null, undefined, "", "   "]) {
        await render(taskId);
        await act(() => routing.change("handoff"));
        assert.equal(page.getByRole("alert").textContent, t("detail.taskUnavailable"));
        assert.equal(page.queryByRole("button", { name: t("activity.open"), exact: true }), null);
        assert.deepEqual(requests, []);
      }
    }
    await render(id);
    assert.ok(page.getByRole("heading", { name: "Recovered task" }));
    assert.ok(page.getByText("Recovered queued input"));
    assert.equal(page.queryByRole("alert"), null);
    assert.ok(requests.some(request => request.route === `agents/timeline/${id}`));
    assert.ok(requests.some(request => request.body.op === "codex_queue" && request.body.args.threadId === id));
    assert.ok(requests.some(request => request.route === "tasks/presence" && request.body.taskId === id));
    assert.ok(requests.some(request => request.route === "tasks/reviews" && request.body.id === id));
    assert.ok(requests.some(request => request.route === "tasks/request-routing" && request.body.taskId === id));
    const { taskErrorText } = await server.ssrLoadModule("/ui/state/taskErrors.ts");
    for (const language of ["en", "zh-CN"]) {
      await act(() => locale.set(language));
      for (const error of [{ code: "INVALID_ARGUMENTS", message: "Internal schema", guide: "contract" }, 'Error: {"code":"INVALID_ARGUMENTS","message":"Internal schema"}', '{broken']) {
        assert.equal(taskErrorText(error, "detail.queueReadFailed"), t("detail.queueReadFailed"));
      }
      assert.equal(taskErrorText(new Error('{"code":"SOURCE_REVOKED"}')), t("detail.sourceRevoked"));
      assert.equal(taskErrorText("A readable failure"), "A readable failure");
    }
  } finally { await act(() => root.unmount()); globalThis.fetch = beforeFetch; await server.close(); await window.happyDOM.close(); }
});
