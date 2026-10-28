import test from "node:test";
import assert from "node:assert/strict";
import { assertNodeIdentity } from "./helpers/dom-assert.ts";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";
import { within, fireEvent } from "@testing-library/dom";

test("Agent panel keeps a nonmodal shell across task/back/peer navigation and restores focus on Escape", { timeout: 10000 }, async () => {
  // Regression: task/back navigation must not remount the nonmodal shell or lose return focus.
  const beforeFetch = globalThis.fetch;
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement, CustomEvent: window.CustomEvent,
    Event: window.Event, MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, CSS: window.CSS,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: Observer, matchMedia: () => media, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1280 });
  window.matchMedia = () => media as unknown as MediaQueryList;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute("role") === "dialog" ? new window.DOMRect(864, 16, 400, 768) : new window.DOMRect(680, 260, 44, 44);
  };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount);
  const root = createRoot(mount);
  try {
    const { default: AgentPanel } = await server.ssrLoadModule("/ui/components/AgentPanel.tsx");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { agentPanel, selectAgentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { panelLayers } = await server.ssrLoadModule("/ui/state/panels.ts");
    const { capturePanelOrigin } = await server.ssrLoadModule("/ui/components/panelMorph.ts");
    const session = { id: "example", source: "transcript", title: "External example", phase: "thinking", phaseSince: null, headline: "Summary", timeline: false, orderAt: 1 };
    globalThis.fetch = async (input, init) => {
      const path = String(input).replace("/api/", "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = path === "agents/conversations" ? {
        data: body.agent === "claude" ? [{ id: "example", source: "arc-task", title: "External example", createdAt: "2026-01-01" }] : [],
        nextCursor: null, scope: "arc-tasks",
      } : { sessionId: "example", readOnly: true, status: "completed", entries: [], cursor: 0, coverage: { state: "complete" } };
      return new Response(JSON.stringify(result), { status: 200 });
    };
    agentActivity.set({ error: "", snapshot: { observedAt: "2026-01-01", agents: { claude: { sessions: [session] } }, activeAgents: ["claude"] } });
    function Harness() {
      const view = agentPanel.use();
      const layers = panelLayers.use();
      return h("div", { onClickCapture: (event: { target: EventTarget }) => capturePanelOrigin(event.target) },
        h("main", { inert: layers.some((layer: HTMLElement) => !layer.dataset.panelDock) },
          ...["claude", "codex"].map(agent => h("div", { key: agent, "data-agent-node": agent },
            h("button", { className: "graph-node", "data-panel-anchor": true, onClick: () => selectAgentPanel({ type: "toggle", agent }) }, agent)))),
        view && h(AgentPanel, { agent: { agent: view.agent }, state: "connected", expanded: false, onToggleWidth() {},
          onSettings() {}, onPanelFrame() {} }));
    }
    const flush = async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      await act(() => { for (let i = 0; frames.size && i < 10; i++) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); } });
    };
    const click = async (node: Element) => { await act(async () => { fireEvent.click(node); await Promise.resolve(); }); await flush(); };
    await act(() => root.render(h(TooltipProvider, null, h(Harness))));
    const page = within(document.body);
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const claude = page.getByRole("button", { name: "claude" }), codex = page.getByRole("button", { name: "codex" });
    await click(claude);
    const shell = page.queryByRole("dialog");
    assert.ok(shell);
    assert.equal(page.getByRole("main").inert, false);
    assert.equal(page.queryByRole("dialog")?.getAttribute("aria-modal"), null);
    await click(page.getByRole("button", { name: /External example/ }));
    assertNodeIdentity(page.queryByRole("dialog"), shell);
    assertNodeIdentity(page.queryByRole("region", { name: t("activity.needsAttention") }), null, "external detail remains read-only");
    await click(page.getByRole("button", { name: t("back"), exact: true }));
    assertNodeIdentity(page.queryByRole("dialog"), shell);
    assert.equal(agentPanel.get().session, undefined);
    assert.ok(page.getByRole("button", { name: /External example/ }).matches(":focus"));
    await click(codex);
    assertNodeIdentity(page.queryByRole("dialog"), shell, "peer switch never remounts the shell");
    assert.equal(agentPanel.get().agent, "codex");
    await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    assert.equal(agentPanel.get(), undefined);
    assertNodeIdentity(page.queryByRole("dialog"), null);
    assert.ok(codex.matches(":focus"));
    await click(claude); await click(claude);
    assert.equal(agentPanel.get(), undefined, "clicking the same node dismisses the panel");
    // A bubble can open the second layer without visiting the Agent list first.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/agents/conversations")) return originalFetch(input, init);
      return new Response(JSON.stringify({ sessionId: "owned", status: "completed", cursor: 1,
        coverage: { state: "partial", truncated: true }, entries: [{ id: "result", type: "text", text: "Retained result", status: "completed", cursor: 1, turnId: "turn", startedAt: null, updatedAt: "2026-01-01" }] }), { status: 200 });
    };
    try {
      await act(async () => selectAgentPanel({ type: "task", agent: "claude", session: { ...session, id: "owned", source: "arc-task", timeline: true } }));
      await flush();
      const detailShell = page.queryByRole("dialog");
      assert.ok(page.getByText("Retained result"));
      await act(() => agentActivity.set({ error: "offline", snapshot: { observedAt: "2026-01-02", agents: {}, activeAgents: [] } }));
      assertNodeIdentity(page.queryByRole("dialog"), detailShell);
      assert.ok(page.getByText("Retained result"));
      await click(page.getByRole("button", { name: t("back"), exact: true }));
      assertNodeIdentity(page.queryByRole("dialog"), detailShell);
      assertNodeIdentity(page.queryByRole("button", { name: t("back"), exact: true }), null);
      await act(() => selectAgentPanel({ type: "closed" }));
      await flush();
    } finally { globalThis.fetch = originalFetch; }

  } finally {
    globalThis.fetch = beforeFetch;
    await act(() => root.unmount());
    await server.close(); await window.happyDOM.close();
  }
});

test("control source dock preserves editing, field navigation and cross-side dispatch paths", { timeout: 10000 }, async () => {
  // Regression: editing or switching sources must preserve the panel and return focus.
  const window = new Window({ url: "http://localhost" });
  window.localStorage.setItem("arc.privacy", "false");
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    CustomEvent: window.CustomEvent, Event: window.Event, MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, CSS: window.CSS,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: Observer, matchMedia: () => media, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1280 });
  // Happy DOM has no layout engine; expose a visible viewport for dock sizing.
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get() { return globalThis.innerWidth; } },
    clientHeight: { configurable: true, get() { return globalThis.innerHeight; } },
  });
  window.matchMedia = () => media as unknown as MediaQueryList;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute("role") === "dialog" ? new window.DOMRect(16, 16, 400, 768) : new window.DOMRect(550, 260, 44, 44);
  };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  try {
    const { default: Overview } = await server.ssrLoadModule("/ui/components/ConnectionOverview.tsx");
    const { default: UiProvider } = await server.ssrLoadModule("/ui/components/UiProvider.tsx");
    const { capturePanelOrigin } = await server.ssrLoadModule("/ui/components/panelMorph.ts");
    const { connector } = await server.ssrLoadModule("/ui/state/connector.ts");
    const { agentPanel, ingressPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    const { navigation } = await server.ssrLoadModule("/ui/state/navigation.ts");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { tasks } = await server.ssrLoadModule("/ui/state/tasks.ts");
    const { agents } = await server.ssrLoadModule("/ui/state/agents.ts");
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const config = { configured: true, httpsProvider: "cloudflare", cloudflareMode: "quick", httpsUrl: "", tunnelId: "tunnel_fixture", hasApiKey: true };
    const source = (id: string) => ({ id, sources: [{ id, ingressId: id, credential: { type: "oauth-grant", grantId: `grant-${id}`, clientId: `client-${id}` }, product: "claude", platform: "anthropic", label: `Source ${id}`, createdAt: "2026-01-01", connectedAt: 1, lastSeenAt: 1, state: "connected" }], name: `Source ${id}`, controlSource: "claude", enabled: true, running: true, state: "ready", auth: "oauth", transport: "https", error: "", config, url: "https://example.com/mcp" });
    const status = { ingresses: [source("one"), source("two")], core: { backendSession: "fixture", appServer: { state: "ready" } }, platform: "darwin", logs: [], autoOpenCodex: false };
    connector.set({ status, sources: status.ingresses.flatMap(i => i.sources), sourcesLoaded: true, loading: false, busy: "", error: "", feedback: { text: "", error: false } });
    agents.set({ items: [{ agent: "codex", installed: true, enabled: true, available: true, status: "ready" }], loading: false, error: "" });
    const session = { id: "thread", source: "codex-thread", title: "Dispatch fixture", phase: "command", headline: "Fixture", phaseSince: null, timeline: true };
    agentActivity.set({ snapshot: { observedAt: "2026-01-01", activeAgents: ["codex"], agents: { codex: { sessions: [session] } } }, error: "" });
    tasks.set({ records: [{ requestId: "dispatch", origin: { ingressId: "one", sourceId: "one" }, state: "completed", createdAt: "2026-01-01", task: { kind: "create", threadId: "thread", title: "Dispatch fixture", prompt: "Fixture" } }], error: "", loading: false });
    globalThis.fetch = async (input, init) => {
      const path = String(input).replace("/api/", ""), method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : {};
      let value: unknown = {};
      if (path === "tasks/control" && body.op === "codex_queue") value = { items: [] };
      else if (path === "status") value = status;
      else if (path === "accounts") value = { accounts: [], login: null };
      else if (path === "setup/next") value = { hasState: false, complete: false, goal: null, steps: [], step: null, progress: { done: 0, total: 0 }, cliPath: "arc", stateDir: "fixture" };
      else if (path === "relay/list") value = { relays: [], version: "test" };
      else if (path === "relay/progress") value = { phase: "idle" };
      else if (path === "tool-catalog") value = { tools: [], groups: [], required: [] };
      else if (path === "codex/login") value = { state: "authenticated" };
      else if (path === "agents/conversations") value = { data: [], nextCursor: null, scope: "arc-tasks" };
      else if (path === "source") value = { sources: status.ingresses.flatMap(i => i.sources) };
      else if (path.endsWith("/oauth")) value = { grants: [] };
      else if (path.startsWith("tasks/runtime/")) value = { runtimeStatus: "active", observedAt: "2026-01-01" };
      else if (path.startsWith("agents/timeline/")) value = { sessionId: "thread", status: "running", entries: [], cursor: 0, coverage: { state: "complete" } };
      else if (["ingress/one/start", "ingress/one/stop"].includes(path) && method === "POST") {
        const running = path.endsWith("/start"), ingress = status.ingresses[0];
        Object.assign(ingress, { running, state: running ? "ready" : "stopped" });
        ingress.sources.forEach(source => { source.state = running ? "connected" : "disconnected"; });
      }
      else if (path === "ingress/one" && method === "PUT") { Object.assign(status.ingresses[0], body); value = status.ingresses[0]; }
      else if (path === "ingress/one" && method === "DELETE") status.ingresses = status.ingresses.filter(i => i.id !== "one");
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const flush = async () => {
      for (let i = 0; i < 4; i++) await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(16));
      });
    };
    const click = async (node: Element | null) => { assert.ok(node); await act(() => fireEvent.click(node)); await flush(); };
    const page = within(document.body);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const escape = async () => { await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await flush(); };
    await act(() => root.render(h(UiProvider, null, h("div", { onClickCapture: (e: { target: EventTarget }) => capturePanelOrigin(e.target) }, h(Overview)))));
    await flush();
    const first = () => page.getByRole("button", { name: /Source one/ });
    const second = () => page.getByRole("button", { name: /Source two/ });
    await click(first());
    const shell = page.getByRole("dialog");
    assert.equal(shell.getAttribute("aria-modal"), null);
    assert.equal(page.queryByRole("switch"), null);
    const { controlSource } = await server.ssrLoadModule("/ui/controlSources.ts");
    await click(button(controlSource("claude").displayName));
    assertNodeIdentity(page.getByRole("dialog"), shell);
    await click(page.getByRole("switch"));
    assert.ok(page.getByRole("switch", { checked: false }));
    await click(page.getByRole("switch"));
    assert.ok(page.getByRole("switch", { checked: true }));
    await click(first());
    assertNodeIdentity(page.getByRole("dialog"), shell);
    await act(() => navigation.set({ ingressEdit: { id: "one" } })); await flush();
    assertNodeIdentity(page.getByRole("dialog"), shell);
    await click(button(t("back")));
    assertNodeIdentity(page.getByRole("dialog"), shell);
    await act(() => navigation.set({ ingressEdit: { id: "one", field: "name" } })); await flush();
    assert.ok(page.getByRole("textbox", { name: t("sourceName") }).matches(":focus"));
    assert.equal(navigation.get().ingressEdit, undefined);
    await click(button(t("save")));
    assertNodeIdentity(page.getByRole("dialog"), shell);
    await act(() => navigation.set({ ingressEdit: { id: "one" } })); await flush();
    await click(button(t("cancel")));
    await click(second());
    assertNodeIdentity(page.getByRole("dialog"), shell);
    assert.equal(ingressPanel.get().ingress.id, "two");
    await escape(); assert.equal(ingressPanel.get(), undefined);
    assert.ok(second().matches(":focus"));
    await click(first()); await click(first()); assert.equal(ingressPanel.get(), undefined);
    await click(first()); await click(within(page.getByRole("dialog")).getByRole("button", { name: /Dispatch fixture/ }));
    assert.equal(ingressPanel.get(), undefined); assert.equal(agentPanel.get().session.id, "thread");
    await click(first()); assert.equal(agentPanel.get(), undefined); assert.ok(ingressPanel.get());
    await escape();
    const { onboarding } = await server.ssrLoadModule("/ui/state/onboarding.ts");
    for (const id of ["claude", "chatgpt", "custom"]) {
      await click(button(t("addControlSource")));
      await click(page.getByRole("radio", { name: id === "custom" ? t("setup.otherClient") : controlSource(id).displayName, exact: true }));
      await click(button(t("source.next")));
      await click(button(t("source.next")));
      assert.equal(onboarding.get().step, "address");
      assert.equal(page.getByRole("textbox", { name: t("source.copyAddress"), exact: true }).textContent, status.ingresses[0].url);
      await click(button(t("back"))); await click(button(t("back")));
      assert.equal(onboarding.get().step, "product");
      assert.equal(page.getByRole("radio", { name: id === "custom" ? t("setup.otherClient") : controlSource(id).displayName, exact: true }).getAttribute("aria-checked"), "true");
      await escape();
    }
    await click(first());
    await act(() => navigation.set({ ingressEdit: { id: "one" } })); await flush();
    await click(button(t("remove")));
    assert.equal(ingressPanel.get(), undefined); assertNodeIdentity(page.queryByRole("dialog"), null);
    assertNodeIdentity(page.queryByRole("button", { name: /Source one/ }), null);
    const { default: RecordsPage } = await server.ssrLoadModule("/ui/components/RecordsPage.tsx");
    await act(() => {
      connector.set({ ...connector.get(), status: { ...status, ingresses: [source("one"), source("two")], logs: [
        JSON.stringify({ ingressId: "one", msg: "Request processed: fixture-one" }),
        JSON.stringify({ ingressId: "two", msg: "Request processed: fixture-two" }),
      ] } });
      navigation.set({ recordsSource: "one" }); root.render(h(UiProvider, null, h(RecordsPage)));
    });
    await flush();
    assert.ok(page.getByRole("cell", { name: /fixture-one/ }));
    assertNodeIdentity(page.queryByRole("cell", { name: /fixture-two/ }), null);
    assert.ok(page.getByRole("button", { name: /Dispatch fixture/ }));

  } finally {
    await act(() => root.unmount()); globalThis.fetch = originalFetch;
    await server.close(); await window.happyDOM.close();
  }
});

test("timeline turn disclosures preserve choices through incremental work and render GFM", { timeout: 10000 }, async () => {
  // Regression: backfilled turn work must not reset a manually expanded step.
  const window = new Window({ url: "http://localhost" });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, DocumentFragment: window.DocumentFragment, localStorage: window.localStorage,
    getComputedStyle: window.getComputedStyle.bind(window), matchMedia: window.matchMedia,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount);
  const root = createRoot(mount);
  try {
    const { default: TimelineEntries } = await server.ssrLoadModule("/ui/components/TimelineEntries.tsx");
    const { locale } = await server.ssrLoadModule("/ui/i18n.ts"); locale.set("en");
    const base = { cursor: 1, position: 1, turnId: "turn", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" };
    const first = { ...base, id: "first", type: "command", status: "running", command: "npm test", cwd: "/project", output: { text: "example output" } };
    const second = { ...base, id: "second", type: "file", operation: "read", status: "completed", path: "/project/src/file.ts", durationMs: 1000, changes: [{ path: "/project/src/file.ts", operation: "edit" }] };
    const session = { id: "example", source: "arc-task", phase: "command", phaseSince: null, headline: "npm test", timeline: true, project: "/project" };
    const render = async (entries: { status: string }[], now = Date.parse("2026-01-01T00:00:03Z"), status?: string) => {
      await act(async () => { root.render(h(TimelineEntries, { entries, session, agent: "claude", now, running: entries.some(e => ["running", "pending"].includes(e.status)), status: status ?? (entries.some(e => e.status === "failed") ? "failed" : entries.some(e => ["running", "pending"].includes(e.status)) ? "running" : "completed") })); });
    };
    const click = async (element: Element) => { await act(async () => { fireEvent.click(element); }); };
    const page = within(mount);
    const { t } = await server.ssrLoadModule("/ui/i18n.ts");
    const group = () => page.getByRole("button", { name: name => name.includes(t("detail.tools.read", { count: 1 })) });
    await render([first, second]);
    assert.ok(page.getAllByText(first.output.text).length > 0);
    await click(group());
    assert.equal(group().getAttribute("aria-expanded"), "false");
    await render([first, second, { ...second, id: "third", path: "/project/src/other.ts" }]);
    assert.equal(group().getAttribute("aria-expanded"), "false");
    assertNodeIdentity(page.queryByText(first.output.text), null);
    await click(group());
    await render([{ ...first, status: "failed", exitCode: 1 }, second]);
    const process = () => page.getByRole("button", { name: name => name.includes(t("detail.process.actions", { count: 2 })) });
    assert.equal(process().getAttribute("aria-expanded"), "true");
    assert.ok(page.getAllByText(first.output.text).length > 0);
    await click(process());
    assert.equal(process().getAttribute("aria-expanded"), "false");
    await click(process());
    assert.equal(process().getAttribute("aria-expanded"), "true");
    await render([{ ...first, status: "completed" }, second], undefined, "interrupted");
    assert.equal(process().getAttribute("aria-expanded"), "true");
    await click(process());
    assert.equal(process().getAttribute("aria-expanded"), "false");
    await click(process());
    assert.equal(process().getAttribute("aria-expanded"), "true");
    await render([{ ...first, status: "completed" }, second]);
    assert.equal(process().getAttribute("aria-expanded"), "false");
    const thinking = { ...base, id: "thinking", type: "thinking", status: "completed", text: "Reasoning detail" };
    const text = { ...base, id: "text", type: "text", status: "completed", phase: "final_answer", text: '| Name | Value |\n| --- | --- |\n| A | B |\n\n- [x] Done\n\n[Docs](https://example.com/docs)\n\n```js\nconst value = 1;\n```\n\n<script>window.bad = true</script>' };
    await render([thinking, text]);
    assertNodeIdentity(page.queryByText(thinking.text), null);
    assert.ok(page.getByRole("cell", { name: "B" }));
    assert.ok(page.getByText("const value = 1;"));
    assertNodeIdentity(page.queryByText("window.bad = true"), null);
    assert.equal((page.getByRole("checkbox") as HTMLInputElement).disabled, true);
    let opened = ""; window.open = ((url: string) => { opened = url; return null; }) as typeof window.open;
    await click(page.getByRole("link", { name: "Docs" }));
    assert.equal(opened, "https://example.com/docs");
    const { activityApprovals } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { interactionKey } = await server.ssrLoadModule("/ui/state/activityModel.ts");
    const interaction = { kind: "question", summary: "Choose an option", respond: { op: "agent_respond", args: { agent: "claude", taskId: "example", interactionId: 1 } } };
    const pending = { ...base, id: "interaction", type: "interaction", status: "pending", interaction };
    await render([pending]);
    assert.ok(page.getByText(t("detail.needsYou")));
    const key = interactionKey("claude", { ...session, phaseSince: base.startedAt, interaction });
    for (const [decision, label] of [["answer", "timeline.answered"], ["deny", "detail.verdict.reject"]]) {
      await act(() => activityApprovals.set({ [key]: { status: "submitted", decision, payload: { op: "agent_respond", args: { value: "A" } } } }));
      assert.ok(page.getByText(t(label)));
      assertNodeIdentity(page.queryByText(t("detail.needsYou")), null);
    }
    await act(() => activityApprovals.set({}));
    await render([{ ...pending, status: "completed" }]);
    assert.ok(page.getByText(interaction.summary));
    assert.ok(page.getByText(t("detail.resolvedElsewhere")));

  } finally {
    await act(() => root.unmount()); await server.close(); window.happyDOM.abort(); mount.remove();
  }
});

test("task detail limits input to pending execution requests and consolidates header actions", { timeout: 10000 }, async () => {
  // Regression: b5cf7c6 made ARC-origin questions answerable; obsolete absence assertions hung while inspecting Happy DOM nodes.
  const window = new Window({ url: "http://localhost" });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  let panelWidth = 480, expanded = false;
  const observers = new Set<Observer>();
  class Observer {
    constructor(callback: (entries: { target: Element }[]) => void) { this.callback = callback; }
    callback: (entries: { target: Element }[]) => void;
    targets = new Set<Element>();
    observe(target: Element) { this.targets.add(target); observers.add(this); }
    unobserve(target: Element) { this.targets.delete(target); if (!this.targets.size) observers.delete(this); }
    disconnect() { this.targets.clear(); observers.delete(this); }
    notify() { this.callback([...this.targets].map(target => ({ target }))); }
  }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    NodeFilter: window.NodeFilter, HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement,
    HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, CSS: window.CSS, innerHeight: 800,
    CustomEvent: window.CustomEvent, DOMRect: window.DOMRect, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => panelWidth });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => new Response(JSON.stringify(String(input).endsWith("/tasks/reviews") ? { reviews: [] } : init?.body && JSON.parse(String(init.body)).op === "codex_queue" ? { items: [] } : { state: "completed" }));
  try {
    const { default: ActivityTimeline } = await server.ssrLoadModule("/ui/components/ActivityTimeline.tsx");
    const { agentActivity } = await server.ssrLoadModule("/ui/state/activity.ts");
    const { connector } = await server.ssrLoadModule("/ui/state/connector.ts");
    const { TooltipProvider } = await server.ssrLoadModule("/ui/components/ui/index.tsx");
    const { t, locale } = await server.ssrLoadModule("/ui/i18n.ts");
    const source = { id: "example-source", kind: "claude", label: "Example source" };
    const session = { id: "detail", turnId: "turn", source: "arc-task", phase: "text", headline: "Response", phaseSince: null,
      timeline: false, orderAt: 0, dispatchSummary: { controlSource: source } };
    const update = async (interaction?: object, running = true) => act(() => agentActivity.set({ error: "", snapshot: { observedAt: "", activeAgents: running ? ["codex"] : [], agents: { codex: { sessions: running ? [{ ...session, interaction }] : [] } } } }));
    connector.set({ ...connector.get(), sources: [{ id: source.id, connectionName: source.label }] });
    await update();
    await act(() => root.render(h(TooltipProvider, null, h(ActivityTimeline, { agent: "codex", session, expanded, onToggleWidth: () => { expanded = !expanded; }, onBack() {} }))));
    const page = within(document.body);
    const click = async (element: Element) => act(async () => { fireEvent.click(element); });
    assert.equal(page.queryAllByRole("textbox").length, 0);
    assert.equal(page.queryAllByRole("region", { name: t("detail.needsYou") }).length, 0);
    for (const language of ["en", "zh-CN"]) {
      await act(() => locale.set(language));
      await update();
      assert.ok(page.getByText(t("detail.via", { source: source.label })));
      assert.equal(page.queryAllByText(source.label, { exact: true }).length, 0);
      const question = { kind: "question", summary: "Question", method: "item/tool/requestUserInput", questions: [{ id: "choice", question: "Choose", options: [{ label: "A" }] }], respond: { op: "codex_respond", args: { respondToken: language } } };
      await update(question);
      assert.ok(page.getByRole("region", { name: t("detail.needsYou") }));
      assert.ok(page.getByRole("textbox", { name: t("detail.other") }));
      assert.equal(page.queryAllByRole("textbox", { name: t("detail.message") }).length, 0);
      await click(page.getByRole("button", { name: t("detail.skip"), exact: true }));
      assert.equal(page.queryAllByRole("region", { name: t("detail.needsYou") }).length, 0);
      assert.equal(page.queryAllByRole("button", { name: t("detail.skip"), exact: true }).length, 0);
      assert.equal(page.queryAllByRole("textbox").length, 0);
    }
    await update({ kind: "permission", summary: "Command approval", respond: { op: "codex_respond", args: { respondToken: "approval" } } });
    assert.equal(page.queryAllByRole("textbox", { name: t("detail.message") }).length, 0);
    assert.ok(page.getByRole("region", { name: t("detail.needsYou") }));
    await update(undefined, false);
    assert.equal(page.queryAllByRole("region", { name: t("detail.needsYou") }).length, 0);
    assert.equal(page.queryAllByRole("textbox").length, 0);
    await update();
    assert.equal(page.queryAllByRole("region", { name: t("detail.needsYou") }).length, 0);
    assert.equal(page.queryAllByRole("textbox").length, 0);
    await act(() => connector.set({ ...connector.get(), sources: [{ id: source.id, connectionName: "Separate connection" }] }));
    assert.equal(page.queryAllByText("Separate connection").length, 0);
    await act(() => agentActivity.set({ error: "", snapshot: { observedAt: "", activeAgents: ["codex"], agents: { codex: { sessions: [{ ...session, dispatchSummary: undefined,
      interaction: { kind: "question", summary: "Native user question", method: "request_user_input_async", respond: { op: "codex_respond", args: { respondToken: "native" } } } }] } } } }));
    const nativeDock = within(page.getByRole("region", { name: t("detail.needsYou") }));
    assert.ok(nativeDock.getByRole("textbox", { name: t("timeline.answer") }));
    assert.equal(page.queryAllByRole("textbox", { name: t("detail.message") }).length, 0);
    await click(nativeDock.getByRole("button", { name: t("detail.skip"), exact: true }));
    assert.equal(page.queryAllByRole("region", { name: t("detail.needsYou") }).length, 0);
    assert.equal(page.queryAllByRole("textbox").length, 0);
    assert.ok(page.getByRole("button", { name: t("expandPanelWidth") }));
    await act(() => { panelWidth = 320; [...observers].forEach(observer => observer.notify()); });
    assert.equal(page.queryAllByRole("button", { name: t("expandPanelWidth") }).length, 0);
    await act(() => fireEvent.keyDown(page.getByRole("button", { name: t("detail.taskActions") }), { key: "Enter" }));
    await click(page.getByRole("menuitem", { name: t("expandPanelWidth") }));
    assert.equal(expanded, true);
  } finally {
    await act(() => root.unmount()); globalThis.fetch = originalFetch;
    await server.close(); await window.happyDOM.close();
  }
});

test("timeline UI and agent navigation restore follow mode and focus", { timeout: 10000 }, async () => {
  // Regression: jump-to-latest and agent navigation must restore follow mode after manual scrolling.
  const window = new Window({ url: "http://localhost" });
  let top = 0, height = 3482, latestLabel = "";
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    NodeFilter: window.NodeFilter, HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement,
    HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, CustomEvent: window.CustomEvent,
    DOMRect: window.DOMRect, CSS: window.CSS, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return this.getAttribute("aria-label") ? 754 : 0; } },
    scrollHeight: { configurable: true, get() { return this.getAttribute("aria-label") ? height : 0; } },
    scrollTop: { configurable: true, get() { return Math.min(top, Math.max(0, height - this.clientHeight)); }, set(value: number) { top = Math.min(value, Math.max(0, height - this.clientHeight)); } },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import("react-dom/client");
  const mount = document.createElement("div"); document.body.append(mount); const root = createRoot(mount);
  const originalFetch = globalThis.fetch;
  let revision = 1;
  globalThis.fetch = async () => { return new Response(JSON.stringify({ sessionId: 'follow', status: 'running', cursor: revision, coverage: { state: 'complete' }, entries: [{ id: 'answer', type: 'text', status: 'running', startedAt: null, updatedAt: '', turnId: 'turn', position: 1, cursor: revision, text: 'Increment '+revision }] })); };
  try {
    const { default: ActivityTimeline } = await server.ssrLoadModule('/ui/components/ActivityTimeline.tsx');
    const { agentActivity } = await server.ssrLoadModule('/ui/state/activity.ts');
    const session = { id: 'follow', turnId: 'turn', source: 'arc-task', phase: 'text', headline: 'Response', phaseSince: null, timeline: true, orderAt: 0 };
    agentActivity.set({ error: '', snapshot: { observedAt: '', activeAgents: ['claude'], agents: { claude: { sessions: [session] } } } });
    await act(async () => { root.render(h(ActivityTimeline, { agent: 'claude', session, expanded: false, onToggleWidth() {}, onBack() {} })); });
    const page = within(mount);
    const { t } = await server.ssrLoadModule("/ui/i18n.ts"); latestLabel = t("timeline.latest");
    const viewport = page.getByLabelText(t("timeline.title"));
    const { taskPanelSnapshot, controlTaskPanel } = await server.ssrLoadModule('/ui/state/taskPanel.ts');
    const { agentPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
    agentPanel.set({ agent: 'claude', session });
    assert.equal(taskPanelSnapshot().following, true);
    assert.equal(taskPanelSnapshot().atLatest, true);
    await act(() => { fireEvent.wheel(viewport, { deltaY: -1 }); viewport.scrollTop = 100; viewport.dispatchEvent(new window.Event('scroll')); });
    assert.ok(page.queryByRole("button", { name: latestLabel }));
    assert.equal(taskPanelSnapshot().following, false);
    await act(async () => controlTaskPanel({ agent: 'claude', id: session.id, action: 'latest' }));
    assert.equal(taskPanelSnapshot().following, true);
    assert.equal(taskPanelSnapshot().atLatest, true);
    assert.ok(viewport.matches(":focus"));
    await act(() => { fireEvent.wheel(viewport, { deltaY: -1 }); viewport.scrollTop = 100; viewport.dispatchEvent(new window.Event('scroll')); });
    await act(() => fireEvent.click(page.getByRole("button", { name: latestLabel })));
    assert.equal(taskPanelSnapshot().following, true);
    assert.ok(viewport.matches(":focus"));
    await act(async () => controlTaskPanel({ agent: 'claude', id: session.id, action: 'follow', following: false }));
    assert.equal(taskPanelSnapshot().following, false);
    await act(() => { fireEvent.wheel(viewport, { deltaY: 1 }); viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 24; viewport.dispatchEvent(new window.Event('scroll')); });
    assertNodeIdentity(page.queryByRole("button", { name: latestLabel }), null);
    assert.equal(taskPanelSnapshot().atLatest, true);
    await act(() => viewport.dispatchEvent(new window.Event('scroll')));
    revision++; height = 3750;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    assert.ok(page.getByText("Increment 2"));
    assert.equal(taskPanelSnapshot().following, true);
    assert.equal(taskPanelSnapshot().atLatest, true);
    assertNodeIdentity(page.queryByRole("button", { name: latestLabel }), null);
  } finally {
    await act(() => root.unmount()); globalThis.fetch = originalFetch;
    await server.close(); await window.happyDOM.close();
  }
});
