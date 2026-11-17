import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { act, createElement as h } from "react";

test("late terminal evidence preserves acknowledged completions after activity tracking resets", async () => {
  // Recurring bug class: a reloaded completion reappeared unread when terminal evidence arrived after the activity snapshot.
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
    const { selectAgentPanel } = await server.ssrLoadModule("/ui/state/overviewPanels.ts");
    const session = { id: "replayed-completion", title: "Replayed completion", source: "arc-task", phase: "text", phaseSince: null, headline: "Finished", turnId: "same-turn" };
    function Harness() {
      useActivityTracking();
      return null;
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
    assert.equal(controlActivityBubble({ agent: "codex", id: session.id }).unread, true);
    await act(() => selectAgentPanel({ type: "task", agent: "codex", session: { ...session, orderAt: 1 } }));
    await act(() => selectAgentPanel({ type: "closed" }));
    const acknowledged = controlActivityBubble({ agent: "codex", id: session.id });
    await replay("fresh-renderer");
    assert.equal(controlActivityBubble({ agent: "codex", id: session.id }).unread, false);
    assert.equal(controlActivityBubble({ agent: "codex", id: session.id }).readAt, acknowledged.readAt);
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});
