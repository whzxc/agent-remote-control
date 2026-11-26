import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";
import { readFile } from "node:fs/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

test("task execution questions retain executable agent operation arguments", async () => {
  // Recurring bug class: task execution questions did not share discoverable agent operation paths.
  const window = new Window({ url: "http://localhost" });
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
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const beforeFetch = globalThis.fetch, calls: { op: string; args: Record<string, any> }[] = [];
  const id = "00000000-0000-4000-8000-000000000001", requestId = "00000000-0000-4000-8000-000000000002";
  const queue = [{ queueId: requestId, threadId: id, preview: "Queued input", state: "queued" }];
  globalThis.fetch = async (input, init) => {
    const route = String(input).replace("/api/", ""), body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { state: "completed" };
    if (route === "tasks") result = { records: [] };
    else if (route === "tasks/control" || route === "agents/respond") {
      if (body.op === "codex_queue") result = { items: queue };
      else calls.push(body);
    } else if (route === "tasks/decision") calls.push({ op: "receipt", args: body });
    return new Response(JSON.stringify(result));
  };
  try {
    const { default: TaskOutcome } = await server.ssrLoadModule("/ui/components/TaskOutcome.tsx");
    const { default: TaskQuestion } = await server.ssrLoadModule("/ui/components/TaskQuestion.tsx");
    const { default: TaskQueuedMessages } = await server.ssrLoadModule("/ui/components/TaskQueuedMessages.tsx");
    const { useTaskQueue } = await server.ssrLoadModule("/ui/state/taskQueue.ts");
    const { activityApprovals } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const session = { id, turnId: "turn", source: "arc-task", phase: "text", phaseSince: null, headline: "", timeline: true };
    function Queue() { const model = useTaskQueue("codex", id); return h(TaskQueuedMessages, { queue: model }); }
    const render = async (node: any) => act(async () => { root.render(h(TooltipProvider, null, node)); });
    const page = within(document.body);
    const click = async (label: string) => act(async () => { fireEvent.click(page.getByRole("button", { name: label, exact: true })); });
    for (const state of ["failed", "interrupted"]) {
      await render(h(TaskOutcome, { state, entries: [{ id: "prompt", type: "user", text: "Requested work", status: "completed" }] }));
      assert.equal(page.queryByRole("textbox"), null);
      for (const key of ["detail.retry", "detail.askFix", "detail.continue"]) assert.equal(page.queryByRole("button", { name: t(key), exact: true }), null);
    }
    for (const skip of [false, true]) {
      await act(() => activityApprovals.set({}));
      const interaction = { kind: "question", method: "item/tool/requestUserInput", summary: "Choice", questions: [{ id: "q", question: "Choose", options: [{ label: "A" }] }], respond: { op: "codex_respond", args: { id: "1", backendSession: id } } };
      await render(h(TaskQuestion, { agent: "codex", session: { ...session, interaction }, answers: { q: ["A"] }, onAnswersChange() {} }));
      await click(t(skip ? "detail.skip" : "detail.sendAnswer"));
      assert.equal(calls.at(-1)?.op, "codex_respond"); assert.deepEqual(calls.at(-1)?.args.result.answers.q.answers, skip ? [] : ["A"]);
    }
    await render(h(Queue));
    assert.ok(page.getByText(queue[0].preview));
    assert.equal(page.queryAllByRole("button").length, 0);
    assert.ok(page.getByRole("status").textContent?.includes(queue[0].preview));
    await render(h(TaskQueuedMessages, { queue: { items: [], error: "Error: SOURCE_REVOKED" } }));
    assert.equal(page.queryByRole("alert"), null);
    await render(h(TaskQueuedMessages, { queue: { items: [{ ...queue[0], state: "failed", error: { code: "SOURCE_REVOKED" } }], error: "" } }));
    assert.equal(page.getByRole("alert").textContent, t("detail.sourceRevoked"));
    await render(h(TaskOutcome, { state: "failed", entries: [{ id: "failure", type: "error", text: "SOURCE_REVOKED", status: "failed" }] }));
    assert.ok(page.getByText(t("detail.sourceRevoked")));
    const catalog = JSON.parse(await readFile(new URL("../shared/core/catalog.json", import.meta.url), "utf8"));
    const validator = new AjvJsonSchemaValidator();
    for (const call of calls) {
      const op = catalog.ops.find((op: any) => op.name === call.op);
      assert.ok(op, call.op); assert.equal(validator.getValidator(op.inputSchema)(call.args).valid, true, JSON.stringify(call));
    }
  } finally { await act(() => root.unmount()); globalThis.fetch = beforeFetch; await server.close(); await window.happyDOM.close(); }
});
