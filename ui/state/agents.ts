import { decorativeSvg } from "../assets/brand-reserve/decorative";
import { api } from "../api";
import { createStore, preference } from "./store";
import builtins from "../../native/src/agents/builtins.json";
import gooseIcon from "../assets/brand-reserve/agents/goose/mono.svg?raw";
import codebuddyIcon from "../assets/brand-reserve/agents/codebuddy/mono.svg?raw";
import antigravityIcon from "../assets/brand-reserve/agents/antigravity/mono.svg?raw";
import geminiIcon from "../assets/brand-reserve/agents/gemini/mono.svg?raw";
import codexIcon from "../assets/agents/openai.svg?raw";
import piIcon from "../assets/brand-reserve/agents/pi/mono.svg?raw";
import opencodeIcon from "../assets/brand-reserve/agents/opencode/mono.svg?raw";
import claudeIcon from "../assets/brand-reserve/agents/claude/color.svg?raw";
import cursorIcon from "../assets/brand-reserve/agents/cursor/mono.svg?raw";
import grokIcon from "../assets/brand-reserve/agents/grok/mono.svg?raw";
import copilotIcon from "../assets/brand-reserve/agents/copilot/color.svg?raw";
import kimiIcon from "../assets/brand-reserve/agents/kimi/mono.svg?raw";
import qwenIcon from "../assets/brand-reserve/agents/qwen/color.svg?raw";
import kiroIcon from "../assets/brand-reserve/agents/kiro/color.svg?raw";
import devinIcon from "../assets/brand-reserve/agents/devin/color.svg?raw";
import clineIcon from "../assets/brand-reserve/agents/cline/mono.svg?raw";
import junieIcon from "../assets/brand-reserve/agents/junie/color.svg?raw";
import hermesIcon from "../assets/brand-reserve/agents/hermes/mono.svg?raw";

export type Agent = {
  adapter?: { state: string; error?: string | null };
  agent: string;
  installed?: boolean;
  available?: boolean;
  enabled?: boolean;
  status?: string;
  version?: string | null;
  displayName?: string;
  protocol?: string;
  discoveryError?: string | null;
  descriptor?: {
    command?: string;
    args?: string[];
    compatibility?: { caveats?: string[]; sources?: string[] };
  };
};
export const icons: Record<string, string> = Object.fromEntries(
  Object.entries({
    antigravity: antigravityIcon,
    goose: gooseIcon,
    codebuddy: codebuddyIcon,
    codex: codexIcon,
    pi: piIcon,
    opencode: opencodeIcon,
    claude: claudeIcon,
    cursor: cursorIcon,
    gemini: geminiIcon,
    grok: grokIcon,
    copilot: copilotIcon,
    kimi: kimiIcon,
    qwen: qwenIcon,
    kiro: kiroIcon,
    devin: devinIcon,
    cline: clineIcon,
    junie: junieIcon,
    hermes: hermesIcon,
  }).map(([name, svg]) => [name, decorativeSvg(svg)]),
);
export const agentLinks: Record<string, string> = {
  ...Object.fromEntries(builtins.map((agent) => [agent.id, agent.compatibility.sources[0]])),
  codex: "https://github.com/openai/codex",
  claude: "https://github.com/anthropics/claude-code",
  pi: "https://pi.dev/",
  antigravity: "https://antigravity.google/",
};
export const name = (agent: Agent) =>
  agent.displayName ||
  builtins.find((entry) => entry.id === agent.agent)?.displayName ||
  ({ codex: "Codex", pi: "Pi", antigravity: "Antigravity" })[agent.agent] ||
  agent.agent;
export const agentStatus = (agent: Agent) =>
  agent.adapter?.state === "preparing" ? "agentAdapterPreparing" :
  agent.installed !== true ? "agentNotInstalled" :
  agent.adapter?.state === "failed" ? "agentAdapterFailed" :
  agent.available !== true ? "agentEntryUnavailable" :
  agent.enabled !== true ? "disabled" :
  agent.status === "ready" ? "agentSessionReady" : "agentEntryAvailable";
const order = preference<string[]>("arc.agent-order", []);
function cachedAgents(): Agent[] {
  try {
    const value = JSON.parse(localStorage.getItem("arc.agents") || "[]");
    return Array.isArray(value)
      ? value.filter(
          (a) =>
            typeof a.agent === "string" && typeof a.installed === "boolean",
        )
      : [];
  } catch {
    return [];
  }
}
const cached = cachedAgents();
export const agents = createStore({
  items: cached,
  loaded: cached.length > 0,
  loading: false,
  saving: "",
  error: "",
});
const patch = (next: Partial<ReturnType<typeof agents.get>>) =>
  agents.set((old) => ({ ...old, ...next }));
export function orderedAgents() {
  return [...agents.get().items].sort((a, b) => {
    const priority =
      Number(b.installed && b.enabled === true) -
        Number(a.installed && a.enabled === true) ||
      Number(!!b.installed) - Number(!!a.installed);
    if (priority) return priority;
    const ai = order.get().indexOf(a.agent),
      bi = order.get().indexOf(b.agent);
    if (a.installed && a.enabled && b.installed && b.enabled && (ai >= 0 || bi >= 0))
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return (
      Number(b.agent === "codex") - Number(a.agent === "codex") ||
      name(a).localeCompare(name(b))
    );
  });
}
export function moveAgent(from: string, to: string) {
  const ids = orderedAgents()
      .filter((a) => a.installed && a.enabled)
      .map((a) => a.agent),
    start = ids.indexOf(from),
    end = ids.indexOf(to);
  if (start < 0 || end < 0 || start === end) return;
  ids.splice(start, 1);
  ids.splice(end, 0, from);
  order.set(ids);
  patch({});
}
function persist() {
  try {
    localStorage.setItem(
      "arc.agents",
      JSON.stringify(
        agents
          .get()
          .items.map(
            ({
              agent,
              installed,
              available,
              enabled,
              version,
              displayName,
            }) => ({
              agent,
              installed,
              available,
              enabled,
              version,
              displayName,
            }),
          ),
      ),
    );
  } catch {
    /* Retain the live discovery even if storage fails. */
  }
}
let pending: Promise<void> | undefined,
  revision = 0,
  preparationPoll: ReturnType<typeof setTimeout> | undefined;
export function refreshAgents(manual = false): Promise<void> {
  if (agents.get().saving) return Promise.resolve();
  if (pending) return pending;
  if (manual || !agents.get().loaded) patch({ loading: true });
  const version = revision;
  pending = api<{ agents: Agent[] }>("agents", manual ? "POST" : "GET")
    .then((result) => {
      if (version !== revision) return;
      const retained = orderedAgents()
        .filter(
          (a) =>
          a.installed && a.enabled &&
            result.agents.some((n) => n.agent === a.agent && n.enabled),
        )
        .map((a) => a.agent);
      patch({ items: result.agents, loaded: true, error: "" });
      order.set([
        ...retained,
        ...orderedAgents()
          .filter((a) => a.installed && a.enabled && !retained.includes(a.agent))
          .map((a) => a.agent),
      ]);
      persist();
      clearTimeout(preparationPoll);
      if (result.agents.some((a) => a.adapter?.state === "preparing"))
        preparationPoll = setTimeout(() => void refreshAgents(), 1500);
    })
    .catch((e) => {
      if (version === revision) patch({ error: String(e) });
    })
    .finally(() => {
      pending = undefined;
      patch({ loading: false });
    });
  return pending;
}
export async function toggleAgent(agent: Agent, enabled: boolean) {
  if (agents.get().saving) return;
  revision++;
  patch({ saving: agent.agent, error: "" });
  try {
    const result = await api<{ enabled: boolean; preparing?: boolean }>(
      "agents",
      "PUT",
      { agent: agent.agent, enabled },
    );
    const retained = orderedAgents()
      .filter((a) => a.installed && a.enabled && a.agent !== agent.agent)
      .map((a) => a.agent);
    patch({
      items: agents
        .get()
        .items.map((a) =>
          a.agent === agent.agent
            ? {
                ...a,
                enabled: result.enabled,
                ...(result.preparing
                  ? { adapter: { state: "preparing" } }
                  : {}),
              }
            : a,
        ),
    });
    order.set(result.enabled ? [...retained, agent.agent] : retained);
    persist();
  } catch (e) {
    patch({ error: String(e) });
  } finally {
    patch({ saving: "" });
  }
  await refreshAgents(true);
}
export function startAgents() {
  void refreshAgents();
  const timer = setInterval(() => void refreshAgents(), 15000);
  return () => {
    clearInterval(timer);
    clearTimeout(preparationPoll);
  };
}
