import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

for (const width of [232, 264, 304]) for (const mode of ["default", "tree", "flat"] as const) test(`completed bubble check hands drags to topology in ${mode} layout at width ${width} while preserving origin clicks, jitter, cancellation and keyboard activation`, async () => {
  // Regression: check-button drag hand-off must coexist with account tree/flat task parents and default topology navigation.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const frames = new Map<number, FrameRequestCallback>(); let frame = 0;
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: Observer, matchMedia: window.matchMedia, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: (id: number) => frames.delete(id), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1280 }, clientHeight: { configurable: true, get: () => 800 },
  });
  const captures = new Map<number, Element>();
  window.HTMLElement.prototype.setPointerCapture = function (id: number) { captures.set(id, this); };
  window.HTMLElement.prototype.hasPointerCapture = function (id: number) { return captures.get(id) === this; };
  window.HTMLElement.prototype.releasePointerCapture = function (id: number) { captures.delete(id); };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  try {
    const { default: Topology } = await server.ssrLoadModule("/ui/topology/Topology.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { ActivityBubble } = await server.ssrLoadModule("/ui/components/ActivityBubbles.tsx");
    const { agentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const { viewModel } = await server.ssrLoadModule("/ui/acceptance.ts");
    const position = () => { const { x, y } = viewModel().topology.tasks.find((task: any) => task.id === "finished").position; return { x, y }; };
    const origin = { kind: "claude", label: "Fixture origin" };
    const session = { id: "finished", title: "Finished task", source: "arc-task", phase: "idle", phaseSince: null, headline: "", orderAt: 1, endedAt: 1, dispatchSummary: { controlSource: origin } };
    const { accountViews } = await server.ssrLoadModule("/ui/topology/accountViews.tsx");
    const { accountNodeId } = await server.ssrLoadModule("/ui/topology/accounts.ts");
    const accounts = mode === "default" ? [] : ["first", "second"].map(id => ({ id, alias: `${id} account`, provider: "openai", identityKey: id,
      sources: [], agentProfiles: [{ agent: "codex", state: "signed-in" }] }));
    let read = false, order: string[] = [], reorderedParent: string | undefined;
    let navigation: { side: number; platform: string; accountId?: string } | undefined;
    const actions = { open: (side: number, platform: string, _sourceId?: string, accountId?: string) => { navigation = { side, platform, accountId }; } };
    const right = accountViews([{ id: "codex", platform: "codex", platformLabel: "Codex", state: "normal", attention: false, selected: false, reorderable: true,
      content: h("button", null, "Codex"), tasks: [{ id: session.id, agentAccountId: accounts[0]?.id, width, height: 76, state: "completed", selected: false, reorderable: true,
        content: h(ActivityBubble, { agent: "codex", session, now: 1, onRead: () => { read = true; } }) }] }], 1, accounts, mode === "flat" ? "flat" : "tree", {}, actions);
    const expectedParent = mode === "default" ? "codex" : accountNodeId("codex", accounts[0].id);
    await act(() => root.render(h(TooltipProvider, null, h(Topology, { boundary: { current: mount }, left: [], right, accountsEnabled: accounts.length > 0,
      onReorderNodes() {}, onReorderTasks: (_side: number, parent: string, ids: string[]) => { order = ids; reorderedParent = parent; } }))));
    assert.equal(viewModel().topology.tasks.find((task: any) => task.id === session.id).parent, expectedParent);
    assert.equal(viewModel().topology.nodes.find((node: any) => node.id === expectedParent).parent, mode === "tree" ? "codex" : undefined);
    const page = within(mount), button = page.getByRole("button", { name: t("activity.markRead"), exact: true });
    const body = page.getByRole("button", { name: name => name.startsWith(session.title) });
    const pointer = async (target: Element, type: string, x: number, y: number, pointerType = "mouse") => act(() => {
      target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, pointerType }));
    });
    const click = async (target: Element, detail = 1) => act(() => { fireEvent.click(target, { detail }); });
    await click(page.getByTitle(origin.label));
    assert.equal(read, true); assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, []);
    for (const kind of ["mouse", "touch", "pen"]) {
      read = false;
      await pointer(button, "pointerdown", 20, 20, kind);
      await pointer(button, "pointermove", 23, 22, kind);
      await pointer(button, "pointerup", 23, 22, kind); await click(button);
      assert.equal(read, true); assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, []);
      for (const [dx, dy] of [[60, 0], [0, 60]]) {
        read = false; order = [];
        const checkStart = position();
        await pointer(button, "pointerdown", 20, 20, kind);
        await pointer(button, "pointermove", 20 + dx, 20 + dy, kind);
        const checkMoved = position();
        assert.notDeepEqual(checkMoved, checkStart);
        // Returning inside the click threshold must not turn a drag into a read.
        await pointer(button, "pointermove", 20, 20, kind);
        await pointer(button, "pointerup", 20, 20, kind); await click(button);
        assert.equal(read, false); assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, [session.id]); assert.equal(reorderedParent, expectedParent);
        order = [];
        const bodyStart = position();
        await pointer(body, "pointerdown", 100, 100, kind);
        await pointer(body, "pointermove", 100 + dx, 100 + dy, kind);
        const bodyMoved = position();
        assert.deepEqual({ x: checkMoved.x - checkStart.x, y: checkMoved.y - checkStart.y },
          { x: bodyMoved.x - bodyStart.x, y: bodyMoved.y - bodyStart.y });
        await pointer(body, "pointerup", 100 + dx, 100 + dy, kind); await click(body);
        assert.equal(read, false); assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, [session.id]); assert.equal(reorderedParent, expectedParent);
      }
      order = [];
      await pointer(button, "pointerdown", 20, 20, kind); await pointer(button, "pointercancel", 20, 20, kind); await click(button);
      assert.equal(read, false); assert.deepEqual(order, []);
      await pointer(button, "pointerdown", 20, 20, kind); await pointer(button, "pointermove", 20, 80, kind);
      await pointer(button, "pointercancel", 20, 80, kind); await click(button);
      assert.equal(read, false); assert.deepEqual(order, []);
    }
    for (const key of ["Enter", " "]) {
      read = false;
      await act(() => { fireEvent.keyDown(button, { key }); fireEvent.keyUp(button, { key }); });
      // Happy DOM does not synthesize the native keyboard button click.
      await click(button, 0);
      assert.equal(read, true); assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, []);
    }
    await pointer(body, "pointerdown", 100, 100); await pointer(body, "pointermove", 102, 101);
    await pointer(body, "pointerup", 102, 101); await click(body);
    assert.equal(agentPanel.get()?.session?.id, session.id);
    await act(() => agentPanel.set(undefined));
    await pointer(body, "pointerdown", 100, 100); await pointer(body, "pointermove", 100, 180);
    await pointer(body, "pointerup", 100, 180); await click(body);
    assert.equal(agentPanel.get(), undefined); assert.deepEqual(order, [session.id]);
    // A check click after a body drag must not inherit its suppressed click.
    read = false;
    await pointer(button, "pointerdown", 20, 20); await pointer(button, "pointerup", 20, 20); await click(button);
    assert.equal(read, true); assert.equal(agentPanel.get(), undefined);
    if (accounts.length) {
      const account = page.getAllByRole("button", { name: name => name.includes(accounts[0].alias) })
        .find(button => button.getAttribute("aria-haspopup") === "dialog")!;
      await click(account);
      assert.deepEqual(navigation, { side: 1, platform: "codex", accountId: accounts[0].id });
      assert.equal(agentPanel.get(), undefined);
    }
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});

test("agents and UI share completion read state without opening details or mutating pending tasks", async () => {
  // Regression: completion reads lived inside a component and were unavailable to agents or snapshots.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  try {
    const { useActivityTracking, acceptActivity, resetActivityCore } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { controlActivityBubble } = await server.ssrLoadModule("/ui/state/activityBubbles.ts");
    const { ActivityBubble } = await server.ssrLoadModule("/ui/components/ActivityBubbles.tsx");
    const { agentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    const { viewModel } = await server.ssrLoadModule("/ui/acceptance.ts");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const base = { source: "arc-task", phase: "idle", phaseSince: null, headline: "", timeline: true };
    const sessions = ["agent-read", "ui-read", "detail-read"].map(id => ({ ...base, id, title: id }));
    const pending = { ...base, id: "pending", title: "Pending task", phase: "interaction", interaction: { kind: "permission", summary: "Allow execution", respond: { op: "codex_respond", args: {} } } };
    function Harness() {
      const { tracked, markRead } = useActivityTracking();
      return h("div", null, (tracked.codex ?? []).map((session: any) => h("section", { key: session.id, "aria-label": session.title }, h(ActivityBubble, { agent: "codex", session, now: 1, onRead: () => markRead("codex", session.id) }))));
    }
    resetActivityCore("first");
    await act(() => root.render(h(Harness)));
    const snapshot = async (active: any[], time: number) => act(() => acceptActivity({ observedAt: new Date(time).toISOString(), agents: { codex: { sessions: active } }, activeAgents: ["codex"] }));
    await snapshot([...sessions, pending], 1); await snapshot([pending], 2);
    const page = within(mount), request = { agent: "codex", id: sessions[0].id };
    const catalog = JSON.parse(await readFile(new URL("../native/src/catalog.json", import.meta.url), "utf8"));
    const management = JSON.parse(await readFile(new URL("../native/src/management.json", import.meta.url), "utf8"));
    const validator = new AjvJsonSchemaValidator();
    for (const name of ["task_bubble", "task_mark_read"]) {
      const op = catalog.ops.find((op: any) => op.name === name);
      assert.ok(op); assert.equal(validator.getValidator(op.inputSchema)(request).valid, true);
    }
    const snapshotOp = management.operations.find((op: any) => op.name === "app.snapshot");
    assert.equal(validator.getValidator(snapshotOp.inputSchema)({ body: { modelOnly: true, taskBubble: { ...request, action: "mark-read" } } }).valid, true);
    assert.equal(controlActivityBubble(request).unread, true);
    await act(() => controlActivityBubble({ ...request, action: "mark-read" }));
    const read = controlActivityBubble(request);
    assert.equal(read.unread, false); assert.equal(typeof read.readAt, "number"); assert.equal(read.retained, false);
    assert.deepEqual(controlActivityBubble({ ...request, action: "mark-read" }), read);
    assert.ok(viewModel().taskBubbles.some((row: any) => row.id === request.id && row.readAt === read.readAt && !row.unread));
    assert.equal(agentPanel.get(), undefined);
    assert.equal(page.queryByRole("button", { name: name => name.startsWith(sessions[0].title) }), null);
    await act(() => fireEvent.click(within(page.getByRole("region", { name: sessions[1].title })).getByRole("button", { name: t("activity.markRead"), exact: true })));
    assert.equal(controlActivityBubble({ agent: "codex", id: sessions[1].id }).unread, false);
    assert.equal(agentPanel.get(), undefined);
    await act(() => fireEvent.click(page.getByRole("button", { name: name => name.startsWith(sessions[2].title) })));
    assert.equal(agentPanel.get()?.session?.id, sessions[2].id);
    assert.equal(controlActivityBubble({ agent: "codex", id: sessions[2].id }).unread, false);
    const active = controlActivityBubble({ agent: "codex", id: pending.id });
    assert.deepEqual({ completed: active.completed, unread: active.unread, readAt: active.readAt }, { completed: false, unread: false, readAt: null });
    assert.throws(() => controlActivityBubble({ agent: "codex", id: pending.id, action: "mark-read" }), /TASK_BUBBLE_ACTIVE/);
    assert.deepEqual(controlActivityBubble({ agent: "codex", id: pending.id }), active);
    assert.throws(() => controlActivityBubble({ agent: "codex", id: "missing", action: "mark-read" }), /TASK_BUBBLE_NOT_FOUND/);
    await snapshot([sessions[0], pending], 3);
    assert.equal(controlActivityBubble(request).completed, false); assert.equal(controlActivityBubble(request).readAt, null);
    // Completion arriving while its detail is already selected is read too.
    const { selectAgentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    await act(() => selectAgentPanel({ type: "task", agent: "codex", session: { ...sessions[0], orderAt: 1 } }));
    await snapshot([pending], 4);
    assert.equal(controlActivityBubble(request).completed, true); assert.equal(controlActivityBubble(request).unread, false);
    assert.equal(controlActivityBubble(request).retained, true);
    const acknowledgements = () => viewModel().taskBubbles.filter((row: any) => row.completed && row.readAt !== null)
      .map(({ agent, id, readAt }: any) => ({ agent, id, readAt })).sort((a: any, b: any) => a.id.localeCompare(b.id));
    const acknowledged = acknowledgements();
    await act(() => resetActivityCore("second"));
    assert.deepEqual(acknowledgements(), acknowledged);
    assert.equal(viewModel().taskBubbles.every((row: any) => !row.unread && !row.retained), true);
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});

test("read acknowledgements survive a fresh renderer and task replay while a new turn becomes unread", async () => {
  // Regression: accepted completion reads disappeared on reload and app window recreation.
  async function renderer(storage: [string, string][] = []) {
    const window = new Window({ url: "http://localhost" });
    for (const [key, value] of storage) window.localStorage.setItem(key, value);
    const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    window.matchMedia = () => media as unknown as MediaQueryList;
    Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
      matchMedia: window.matchMedia, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
      cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
    const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
    const { createRoot } = await import("react-dom/client");
    const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
    const { useActivityTracking, acceptActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { controlActivityBubble } = await server.ssrLoadModule("/ui/state/activityBubbles.ts");
    const { viewModel } = await server.ssrLoadModule("/ui/acceptance.ts");
    const { ActivityBubble } = await server.ssrLoadModule("/ui/components/ActivityBubbles.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    function Harness() {
      const { tracked, markRead } = useActivityTracking();
      return h("div", null, Object.entries(tracked).flatMap(([agent, sessions]: any) => sessions.map((session: any) =>
        h("section", { key: `${agent}/${session.id}`, "aria-label": `${agent}/${session.id}` },
          h(ActivityBubble, { agent, session, now: 1, onRead: () => markRead(agent, session.id) })))));
    }
    await act(() => root.render(h(Harness)));
    let time = 0;
    return { window, page: within(mount), t, viewModel, controlActivityBubble,
      hideTopology: async () => act(() => root.render(h("div"))),
      snapshot: async (codex: any[], claude: any[] = []) => act(() => acceptActivity({ observedAt: new Date(++time).toISOString(),
        agents: { codex: { sessions: codex }, claude: { sessions: claude } }, activeAgents: ["codex", "claude"] })),
      close: async () => { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); } };
  }
  const uiTask = { id: "same-task", title: "Stored task", source: "arc-task", phase: "idle", phaseSince: null, headline: "", turnId: "first" };
  const agentTask = { ...uiTask, id: "agent-task", turnId: undefined, turnStartedAt: new Date(1).toISOString() };
  let runtime = await renderer();
  try {
    await runtime.snapshot([uiTask, agentTask], [uiTask]); await runtime.snapshot([]);
    await act(() => fireEvent.click(within(runtime.page.getByRole("region", { name: `codex/${uiTask.id}` }))
      .getByRole("button", { name: runtime.t("activity.markRead"), exact: true })));
    await act(() => runtime.controlActivityBubble({ agent: "codex", id: agentTask.id, action: "mark-read" }));
    const before = runtime.viewModel().taskBubbles.filter((row: any) => row.agent === "codex");
    assert.equal(before.every((row: any) => !row.unread && !row.retained && typeof row.readAt === "number"), true);
    const storage: [string, string][] = [];
    for (let i = 0; i < runtime.window.localStorage.length; i++) {
      const key = runtime.window.localStorage.key(i)!; storage.push([key, runtime.window.localStorage.getItem(key)!]);
    }
    await runtime.close(); runtime = await renderer(storage);
    assert.deepEqual(runtime.viewModel().taskBubbles, before);
    // Re-observing the same turn must not erase a durable read acknowledgement.
    await runtime.snapshot([uiTask, agentTask], [uiTask]); await runtime.snapshot([]);
    for (const expected of before) {
      const request = { agent: expected.agent, id: expected.id };
      assert.deepEqual(runtime.controlActivityBubble(request), expected);
      assert.deepEqual(runtime.controlActivityBubble({ ...request, action: "mark-read" }), expected);
      assert.equal(runtime.page.queryByRole("region", { name: `${expected.agent}/${expected.id}` }), null);
    }
    assert.equal(runtime.controlActivityBubble({ agent: "claude", id: uiTask.id }).unread, true);
    // Agent reads and writes remain current while another page owns the window.
    await runtime.hideTopology();
    const next = { ...uiTask, turnId: "second" };
    await runtime.snapshot([next]);
    assert.throws(() => runtime.controlActivityBubble({ agent: "codex", id: next.id, action: "mark-read" }), /TASK_BUBBLE_ACTIVE/);
    await runtime.snapshot([]);
    assert.equal(runtime.controlActivityBubble({ agent: "codex", id: next.id }).unread, true);
    assert.equal(runtime.controlActivityBubble({ agent: "codex", id: next.id }).readAt, null);
    const webStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: webStorage.getItem.bind(webStorage), setItem: () => { throw new Error("storage unavailable"); },
    } });
    try {
      assert.throws(() => runtime.controlActivityBubble({ agent: "codex", id: next.id, action: "mark-read" }), /TASK_READ_PERSIST_FAILED/);
      assert.equal(runtime.controlActivityBubble({ agent: "codex", id: next.id }).unread, true);
    } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: webStorage }); }
    assert.deepEqual(runtime.viewModel().taskBubbles.find((row: any) => row.agent === "codex" && row.id === agentTask.id), before.find((row: any) => row.id === agentTask.id));
    // Sources without a native turn ID still distinguish turns by start time.
    await runtime.snapshot([{ ...agentTask, turnStartedAt: new Date(2).toISOString() }]); await runtime.snapshot([]);
    assert.equal(runtime.controlActivityBubble({ agent: "codex", id: agentTask.id }).unread, true);
    assert.equal(runtime.controlActivityBubble({ agent: "codex", id: agentTask.id }).readAt, null);
  } finally { await runtime.close(); }
});
