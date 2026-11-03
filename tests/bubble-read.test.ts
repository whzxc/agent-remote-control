import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

for (const width of [264]) for (const mode of ["default", "tree", "flat"] as const) test(`completed bubble check hands drags to topology in ${mode} layout at width ${width} while preserving origin clicks, jitter, cancellation and keyboard activation`, async () => {
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
    let read = false;
    let navigation: { side: number; platform: string; accountId?: string } | undefined;
    const actions = { open: (side: number, platform: string, _sourceId?: string, accountId?: string) => { navigation = { side, platform, accountId }; } };
    const right = accountViews([{ id: "codex", platform: "codex", platformLabel: "Codex", state: "normal", attention: false, selected: false, reorderable: true,
      content: h("button", null, "Codex"), tasks: [{ id: session.id, agentAccountId: accounts[0]?.id, width, height: 76, state: "completed", selected: false, reorderable: true,
        content: h(ActivityBubble, { agent: "codex", session, now: 1, onRead: () => { read = true; } }) }] }], 1, accounts, mode === "flat" ? "flat" : "tree", {}, actions);
    const expectedParent = mode === "default" ? "codex" : accountNodeId("codex", accounts[0].id);
    await act(() => root.render(h(TooltipProvider, null, h(Topology, { boundary: { current: mount }, left: [], right, accountsEnabled: accounts.length > 0,
      onReorderNodes() {}, onReorderTasks() {} }))));
    assert.equal(viewModel().topology.tasks.find((task: any) => task.id === session.id).parent, expectedParent);
    assert.equal(viewModel().topology.nodes.find((node: any) => node.id === expectedParent).parent, mode === "tree" ? "codex" : undefined);
    const page = within(mount), button = page.getByRole("button", { name: t("activity.markRead"), exact: true });
    const body = page.getByRole("button", { name: name => name.startsWith(session.title) });
    const pointer = async (target: Element, type: string, x: number, y: number, pointerType = "mouse") => act(() => {
      target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, pointerType }));
    });
    const click = async (target: Element, detail = 1) => act(() => { fireEvent.click(target, { detail }); });
    await click(page.getByTitle(origin.label));
    assert.equal(read, true); assert.equal(agentPanel.get(), undefined);
    for (const kind of ["mouse", "touch", "pen"]) {
      read = false;
      await pointer(button, "pointerdown", 20, 20, kind);
      await pointer(button, "pointermove", 23, 22, kind);
      await pointer(button, "pointerup", 23, 22, kind); await click(button);
      assert.equal(read, true); assert.equal(agentPanel.get(), undefined);
      for (const [dx, dy] of [[60, 0], [0, 60]]) {
        read = false;
        const checkStart = position();
        await pointer(button, "pointerdown", 20, 20, kind);
        await pointer(button, "pointermove", 20 + dx, 20 + dy, kind);
        const checkMoved = position();
        assert.notDeepEqual(checkMoved, checkStart);
        // Returning inside the click threshold must not turn a drag into a read.
        await pointer(button, "pointermove", 20, 20, kind);
        await pointer(button, "pointerup", 20, 20, kind); await click(button);
        assert.equal(read, false); assert.equal(agentPanel.get(), undefined);
        const bodyStart = position();
        await pointer(body, "pointerdown", 100, 100, kind);
        await pointer(body, "pointermove", 100 + dx, 100 + dy, kind);
        const bodyMoved = position();
        assert.deepEqual({ x: checkMoved.x - checkStart.x, y: checkMoved.y - checkStart.y },
          { x: bodyMoved.x - bodyStart.x, y: bodyMoved.y - bodyStart.y });
        await pointer(body, "pointerup", 100 + dx, 100 + dy, kind); await click(body);
        assert.equal(read, false); assert.equal(agentPanel.get(), undefined);
      }
      await pointer(button, "pointerdown", 20, 20, kind); await pointer(button, "pointercancel", 20, 20, kind); await click(button);
      assert.equal(read, false);
      await pointer(button, "pointerdown", 20, 20, kind); await pointer(button, "pointermove", 20, 80, kind);
      await pointer(button, "pointercancel", 20, 80, kind); await click(button);
      assert.equal(read, false);
    }
    for (const key of ["Enter", " "]) {
      read = false;
      await act(() => { fireEvent.keyDown(button, { key }); fireEvent.keyUp(button, { key }); });
      // Happy DOM does not synthesize the native keyboard button click.
      await click(button, 0);
      assert.equal(read, true); assert.equal(agentPanel.get(), undefined);
    }
    await pointer(body, "pointerdown", 100, 100); await pointer(body, "pointermove", 102, 101);
    await pointer(body, "pointerup", 102, 101); await click(body);
    assert.equal(agentPanel.get()?.session?.id, session.id);
    await act(() => agentPanel.set(undefined));
    await pointer(body, "pointerdown", 100, 100); await pointer(body, "pointermove", 100, 180);
    await pointer(body, "pointerup", 100, 180); await click(body);
    assert.equal(agentPanel.get(), undefined);
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



test("late terminal evidence preserves acknowledged completions after activity tracking resets", async () => {
  // Regression: a reloaded completion reappeared unread when terminal evidence arrived after the activity snapshot.
  const window = new Window({ url: "http://localhost" });
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: () => media, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("main"); document.body.append(mount); const root = createRoot(mount);
  try {
    const { useActivityTracking, acceptActivity, resetActivityCore } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { acceptTaskExecution } = await server.ssrLoadModule("/ui/state/taskExecution.ts");
    const { controlActivityBubble } = await server.ssrLoadModule("/ui/state/activityBubbles.ts");
    const { ActivityBubble } = await server.ssrLoadModule("/ui/components/ActivityBubbles.tsx");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const session = { id: "replayed-completion", title: "Replayed completion", source: "arc-task", phase: "text", phaseSince: null, headline: "Finished", turnId: "same-turn" };
    function Harness() {
      const { tracked, markRead } = useActivityTracking();
      return h("div", null, (tracked.codex ?? []).map((row: any) => h(ActivityBubble, { key: row.id, agent: "codex", session: row, now: 1,
        onRead: () => markRead("codex", row.id) })));
    }
    await act(() => root.render(h(Harness)));
    let observed = 0;
    const replay = async (core: string) => {
      await act(() => {
        resetActivityCore(core);
        acceptActivity({ observedAt: new Date(++observed).toISOString(), agents: { codex: { sessions: [session] } }, activeAgents: ["codex"] });
        acceptActivity({ observedAt: new Date(++observed).toISOString(), agents: { codex: { sessions: [] } }, activeAgents: ["codex"] });
        acceptTaskExecution("codex", session.id, { sessionId: session.id, status: "completed", turnId: session.turnId, entries: [], cursor: 1,
          turnStatuses: { [session.turnId]: "completed" }, executionEvidence: true, coverage: { state: "complete", truncated: false } });
      });
    };
    await replay("first-renderer");
    await act(() => fireEvent.click(within(mount).getByRole("button", { name: t("activity.markRead"), exact: true })));
    const acknowledged = controlActivityBubble({ agent: "codex", id: session.id });
    await replay("fresh-renderer");
    assert.equal(within(mount).queryByRole("button", { name: t("activity.markRead"), exact: true }), null);
    assert.deepEqual(controlActivityBubble({ agent: "codex", id: session.id }), acknowledged);
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});
