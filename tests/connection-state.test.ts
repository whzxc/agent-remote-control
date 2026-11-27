import test from "node:test";
import assert from "node:assert/strict";
import { agentConnectionState, ingressState, isSourceAuthorized, sourceConnectionState, wireState } from "../ui/topology/connectionState.ts";
import type { ControlSource, Ingress } from "../ui/state/types.ts";

function makeIngress(overrides: Partial<Ingress> = {}): Ingress {
  return {
    id: "ing-1",
    name: "Primary",
    controlSource: "claude",
    transport: "https",
    auth: "oauth",
    enabled: true,
    running: true,
    state: "ready",
    error: "",
    url: "https://example.com/mcp",
    config: {},
    oauth: { grants: [{ id: "grant-1", clientName: "Claude", clientId: "c1", connectedAt: 1, registeredAt: 1 }], pending: [] },
    ...overrides,
  } as Ingress;
}

function makeSource(overrides: Partial<ControlSource> = {}): ControlSource {
  return {
    id: "src-1",
    ingressId: "ing-1",
    credential: { type: "oauth-grant", grantId: "grant-1" },
    product: "claude",
    platform: "anthropic",
    label: "Claude",
    createdAt: "2026-11-27T00:00:00Z",
    connectedAt: 1,
    lastSeenAt: null,
    state: "connected",
    ...overrides,
  } as ControlSource;
}

test("left connection wire depends only on source authorization and tunnel readiness", () => {
  // Contract: a control source connects when authorized (or auth-free) and its ingress tunnel is ready, unaffected by lagged source.state or stale ingress errors.
  const readyIngress = makeIngress({ state: "ready", error: "stale error" });
  const laggedSource = makeSource({ state: "disconnected" });
  assert.equal(sourceConnectionState(laggedSource, readyIngress), "connected");
  assert.equal(wireState(sourceConnectionState(laggedSource, readyIngress)), "normal");

  const localSource = makeSource({ credential: { type: "local" }, connectedAt: null, state: "disconnected" });
  const localIngress = makeIngress({ auth: "local", transport: "local", oauth: undefined, state: "ready" });
  assert.equal(isSourceAuthorized(localSource, localIngress), true);
  assert.equal(sourceConnectionState(localSource, localIngress), "connected");

  const pendingIngress = makeIngress({ oauth: { grants: [], pending: [{ id: "p1", sourceId: "src-pending", product: "claude", clientName: "Claude", redirectUri: "", resource: "", pairingCode: "", status: "pending" }] } });
  const pendingSource = makeSource({ id: "src-pending", credential: { type: "oauth-grant", grantId: "p1" }, connectedAt: null });
  assert.equal(sourceConnectionState(pendingSource, pendingIngress), "disconnected");
  assert.equal(wireState(sourceConnectionState(pendingSource, pendingIngress)), "inactive");

  const revokedSource = makeSource({ state: "revoked" });
  assert.equal(sourceConnectionState(revokedSource, readyIngress), "disconnected");

  assert.equal(wireState(sourceConnectionState(makeSource(), makeIngress({ state: "starting" }))), "connecting");
  assert.equal(wireState(sourceConnectionState(makeSource(), makeIngress({ state: "error" }))), "error");
  assert.equal(wireState(sourceConnectionState(makeSource(), makeIngress({ state: "stopped" }))), "inactive");
  assert.equal(wireState(ingressState({ enabled: false, state: "ready" })), "inactive");
});

test("right connection wire depends only on agent detection and dispatchability across all agents", () => {
  // Recurring bug class: lifecycle right-side agent wires must not depend on Codex desktop IPC or pre-warmed app-server processes.
  const codexIdle = { installed: true, enabled: true, available: true };
  assert.equal(agentConnectionState(codexIdle), "connected");
  assert.equal(wireState(agentConnectionState(codexIdle)), "normal");

  assert.equal(wireState(agentConnectionState({ installed: true, enabled: true, available: false })), "error");
  assert.equal(wireState(agentConnectionState({ installed: true, enabled: false, available: true })), "inactive");
  assert.equal(wireState(agentConnectionState({ installed: false, enabled: true, available: false })), "inactive");
  assert.equal(wireState(agentConnectionState({ installed: true, enabled: false, available: false, adapter: { state: "preparing" } })), "connecting");
  assert.equal(wireState(agentConnectionState({ installed: true, enabled: false, available: false, adapter: { state: "failed" } })), "error");
});
