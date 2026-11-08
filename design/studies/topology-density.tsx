import { Frame } from "sdg";
import { TopologyScene, type SceneItem, type ScenePath } from "../modules/topology-scene";
import { TopologyNode } from "../modules/topology-node";
import { TopologyMark } from "../modules/topology-mark";
import { TaskBubble } from "../modules/task-presentation";
import { BoardHeader } from "../modules/board-header";
import { NavCapsule } from "../modules/nav-capsule";
import { AgentIcon, BrandMark, type AgentIconReading, type Brand } from "../components/agent-icon";
import { nodes, tasks, links, scenes, dispatch } from "../fixtures/topology";

// Direction study: dense Agent wings with many accounts and folded groups.
// Geometry is hand-solved here; runtime solving stays in ui/topology/solve.ts.

type Point = { x: number; y: number };
type Quota = "ok" | "low" | "out";
const quotaColor: Record<Quota, string> = { ok: "var(--success)", low: "var(--warning)", out: "var(--danger)" };
const quotaDot: Record<Quota, string> = { ok: "bg-success", low: "bg-warning", out: "bg-danger" };
const reading = (q: Quota, value: number): AgentIconReading => ({
  id: "display",
  label: "Display",
  value,
  color: quotaColor[q],
  elapsed: 0.57,
});

const f = (n: number) => n.toFixed(1);
const polar = (c: Point, r: number, deg: number): Point => ({
  x: c.x + r * Math.cos((deg * Math.PI) / 180),
  y: c.y + r * Math.sin((deg * Math.PI) / 180),
});
function arc(c: Point, r: number, lo: number, hi: number, width: number): ScenePath {
  const a = polar(c, r, lo);
  const b = polar(c, r, hi);
  return {
    d: `M ${f(a.x)} ${f(a.y)} A ${r} ${r} 0 0 1 ${f(b.x)} ${f(b.y)}`,
    class: "fill-none stroke-role-agent",
    "stroke-width": String(width),
    "stroke-linecap": "round",
  };
}
// Tapered cubic branch: wide at the port, thin at the target.
function branch(from: Point, angle: number, to: Point, w0: number, w1: number, cls: string, t0 = 0.34, t1 = 0.5): ScenePath {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const c1 = polar(from, dist * t0, angle);
  const c2 = { x: to.x - (to.x - from.x) * t1, y: to.y };
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    };
  };
  const left: Point[] = [];
  const right: Point[] = [];
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = at(t);
    const q = at(Math.min(1, t + 0.01));
    const r = at(Math.max(0, t - 0.01));
    const dx = q.x - r.x;
    const dy = q.y - r.y;
    const len = Math.hypot(dx, dy) || 1;
    const w = (w0 + (w1 - w0) * (1 - (1 - t) * (1 - t))) / 2;
    left.push({ x: p.x - (dy / len) * w, y: p.y + (dx / len) * w });
    right.push({ x: p.x + (dy / len) * w, y: p.y - (dx / len) * w });
  }
  const pts = [...left, ...right.reverse()];
  return { d: "M " + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join(" L ") + " Z", class: cls };
}
// Ports follow each target and keep a minimum separation (solve.ts distribute).
function distribute(raw: number[], follow: number, sep: number, max: number) {
  const a = raw.map((r) => Math.max(-max, Math.min(max, r * follow)));
  for (let i = 1; i < a.length; i++) a[i] = Math.max(a[i], a[i - 1] + sep);
  return a;
}

// ---------------------------------------------------------------- stack forms

type Member = { brand: Brand; quota: Quota };

/** Option A: one front node with plain plates behind it and a count label. */
export function StackDeck({ front, count, label, width = 110 }: { front: Member; count: number; label: string; width?: number }) {
  return (
    <div class="flex h-[76px] flex-col items-center gap-[2px] pt-[2px] text-text" style={{ width }}>
      <span class="relative flex size-12 items-center">
        <span class="absolute left-[22px] top-[9px] size-[30px] rounded-full border border-border bg-canvas" />
        <span class="absolute left-[13px] top-[6px] size-[36px] rounded-full border border-border-strong bg-canvas" />
        <span class="relative ml-[3px] flex size-[42px] items-center justify-center rounded-full border border-border-strong bg-canvas">
          <BrandMark brand={front.brand} size={26} />
        </span>
      </span>
      <span class="text-meta leading-5 text-text-secondary">
        <span class="font-semibold tabular-nums">+{count}</span> {label}
      </span>
    </div>
  );
}

/** Option B: a pool capsule. Same-brand pools show one mark and per-account quota dots. */
export function StackCapsule({ members, label }: { members: readonly Member[]; label: string }) {
  const brands = [...new Set(members.map((m) => m.brand))];
  const pool = brands.length === 1;
  return (
    <div class="flex flex-col items-start gap-[4px] text-text">
      <span class="flex h-10 items-center gap-2 rounded-full border border-border bg-surface pl-[5px] pr-3 shadow-sm">
        {pool ? (
          <BrandMark brand={brands[0]} size={28} />
        ) : (
          <span class="flex">
            {brands.slice(0, 4).map((brand, i) => (
              <span class={"flex size-[30px] items-center justify-center rounded-full border border-border bg-surface " + String(i ? "-ml-[4px]" : "")}>
                <BrandMark brand={brand} size={18} />
              </span>
            ))}
          </span>
        )}
        {pool && (
          <span class="grid grid-cols-4 gap-x-[4px] gap-y-[4px]">
            {members.map((m) => (
              <span class={"size-[6px] rounded-full " + quotaDot[m.quota]} />
            ))}
          </span>
        )}
        <span class="text-meta font-semibold tabular-nums text-text-secondary">{members.length}</span>
      </span>
      <span class="pl-[6px] text-meta leading-5 text-text-secondary">{label}</span>
    </div>
  );
}

/** Today: real member nodes overlap on one axis with a small offset. */
function StackToday({ members }: { members: readonly Member[] }) {
  return (
    <div class="relative h-[90px] w-[110px]">
      {members.slice(0, 4).map((m, i) => (
        <span class="absolute left-[31px] flex rounded-full border border-border bg-canvas" style={{ top: 2 + i * 7 }}>
          <AgentIcon brand={m.brand} readings={[reading(m.quota, 40 + i * 10)]} />
        </span>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- scene

const idleAccounts: Member[] = [
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "low" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "out" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "low" },
  { brand: "codex", quota: "ok" },
];
const idleAgents: Member[] = [
  { brand: "claude-code", quota: "ok" },
  { brand: "opencode", quota: "ok" },
  { brand: "deepseek", quota: "low" },
  { brand: "cursor", quota: "ok" },
];

const hub = { x: 482.5, y: 400.5 };
const ROOT_X = 768;
const ACCOUNT_X = 872;
const BUBBLE_X = 976;
const BUBBLE_H = 76;

type Account = { label: string; quota: Quota; value: number; tasks: readonly number[] };
const accounts: readonly Account[] = [
  { label: "Pro 200", quota: "ok", value: 73, tasks: [16, 15] },
  { label: "Codex Pro 01", quota: "low", value: 38, tasks: [17] },
  { label: "Codex Pro 02", quota: "ok", value: 81, tasks: [14] },
];

function denseScene(form: "deck" | "capsule") {
  const items: SceneItem[] = [];
  const paths: ScenePath[] = [];

  // Source wing and mark reuse the approved accounts scene.
  const base = scenes["accounts-accounts"];
  for (const [x, y, node] of base.nodes.slice(0, 8)) items.push({ x, y, content: <TopologyNode {...nodes[node]} /> });
  for (const id of [61, 62, 63, 64, 65, 66, 67, 68, 76, 77, 78]) paths.push(links[id]);

  // Account rows: tasks first, then the folded idle group as one row.
  let top = 152;
  const rows: { y: number; account?: Account; taskTops: number[] }[] = [];
  for (const account of accounts) {
    const taskTops = account.tasks.map((_, i) => top + i * (BUBBLE_H + 10));
    const h = account.tasks.length * BUBBLE_H + (account.tasks.length - 1) * 10;
    rows.push({ y: top + h / 2, account, taskTops });
    top += h + 22;
  }
  const idleY = top + 34;
  rows.push({ y: idleY, taskTops: [] });
  const codexY = (rows[0].y + idleY) / 2;
  const agentsY = idleY + 112;

  // Earcup and primary branches.
  const rootTargets = [codexY, agentsY].map((y) => ({ x: ROOT_X, y }));
  const ports = distribute(rootTargets.map((t) => (Math.atan2(t.y - hub.y, t.x - hub.x) * 180) / Math.PI), 0.7, 7, 42);
  paths.push(arc(hub, 109.9, Math.min(-22, ports[0] - 7), Math.max(22, ports[ports.length - 1] + 7), 11.8));
  rootTargets.forEach((t, i) => paths.push(branch(polar(hub, 116, ports[i]), ports[i], { x: t.x - 27, y: t.y }, 7, 2.6, "fill-role-agent/35", 0.3, 0.42)));

  // Codex outer arc and account branches.
  const codex = { x: ROOT_X, y: codexY };
  const childPorts = distribute(rows.map((r) => (Math.atan2(r.y - codexY, 104) * 180) / Math.PI), 0.75, 9, 58);
  paths.push(arc(codex, 32, childPorts[0] - 9, childPorts[childPorts.length - 1] + 9, 3.4));
  rows.forEach((r, i) => {
    const end = r.account || form === "deck" ? ACCOUNT_X - 27 : ACCOUNT_X - 14;
    paths.push(branch(polar(codex, 34, childPorts[i]), childPorts[i], { x: end, y: r.y }, 4, 2, "fill-role-agent/35"));
  });

  // Account nodes, their outer arcs and task branches.
  for (const r of rows) {
    if (!r.account) continue;
    const a = r.account;
    items.push({
      x: ACCOUNT_X - 55,
      y: r.y - 26,
      content: <TopologyNode label={a.label} brand="codex" readings={[reading(a.quota, a.value)]} />,
    });
    const node = { x: ACCOUNT_X, y: r.y };
    const centers = r.taskTops.map((t) => t + BUBBLE_H / 2);
    const tp = distribute(centers.map((c) => (Math.atan2(c - r.y, 104) * 180) / Math.PI), 0.75, 9, 58);
    paths.push(arc(node, 32, Math.min(-14, tp[0] - 9), Math.max(14, tp[tp.length - 1] + 9), 3.4));
    centers.forEach((c, i) => paths.push(branch(polar(node, 34, tp[i]), tp[i], { x: BUBBLE_X, y: c }, 3.2, 1.6, "fill-role-agent/55")));
    r.taskTops.forEach((t, i) => items.push({ x: BUBBLE_X, y: t, content: <TaskBubble {...tasks[a.tasks[i]]} dispatch={dispatch} /> }));
  }

  // Codex root and the two folded groups.
  items.push({ x: ROOT_X - 55, y: codexY - 26, content: <TopologyNode label="Codex" brand="codex" /> });
  if (form === "deck") {
    items.push({ x: ACCOUNT_X - 55, y: idleY - 26, content: <StackDeck front={idleAccounts[0]} count={8} label="idle" /> });
    items.push({ x: ROOT_X - 55, y: agentsY - 26, content: <StackDeck front={idleAgents[0]} count={4} label="idle Agents" /> });
  } else {
    items.push({ x: ACCOUNT_X - 20, y: idleY - 20, content: <StackCapsule members={idleAccounts} label="8 idle accounts" /> });
    items.push({ x: ROOT_X - 20, y: agentsY - 20, content: <StackCapsule members={idleAgents} label="4 idle Agents" /> });
  }

  // Chrome.
  items.push({ x: 381, y: 299, content: <TopologyMark size={203} sourceAction={false} agentAction={false} /> });
  items.push({ x: 362, y: 27, content: <BoardHeader date="November 8 · Sun" time="05:37" title="3 running" /> });
  items.push({ x: 24, y: 732, content: <NavCapsule active="" /> });
  return { items, paths };
}

function DenseScreen({ form }: { form: "deck" | "capsule" }) {
  const { items, paths } = denseScene(form);
  return (
    <div class="relative bg-canvas" style={{ width: 1280, height: 800 }}>
      <TopologyScene width={1280} height={800} items={items} paths={paths} />
    </div>
  );
}

function Specimen() {
  const cell = "flex flex-col items-center gap-3 w-[200px]";
  const caption = "text-meta text-text-secondary";
  return (
    <div data-free class="flex items-start gap-6 p-8 bg-canvas">
      <div class={cell}>
        <StackToday members={idleAgents} />
        <span class={caption}>Today: overlapping members</span>
      </div>
      <div class={cell}>
        <div class="flex gap-2">
          <StackDeck front={idleAccounts[0]} count={8} label="idle" width={90} />
          <StackDeck front={idleAgents[0]} count={4} label="idle" width={90} />
        </div>
        <span class={caption}>A · Deck</span>
      </div>
      <div class={cell + " w-[340px]"}>
        <div class="flex gap-4">
          <StackCapsule members={idleAccounts} label="8 idle accounts" />
          <StackCapsule members={idleAgents} label="4 idle Agents" />
        </div>
        <span class={caption}>B · Capsule</span>
      </div>
    </div>
  );
}

export default () => [
  <Frame name="stack-forms" note="Folded group forms: today, option A and option B.">
    <Specimen />
  </Frame>,
  <Frame name="dense-deck" width={1280} height={800} note="Option A: idle siblings fold per parent into a deck; one wire per group.">
    <DenseScreen form="deck" />
  </Frame>,
  <Frame name="dense-capsule" width={1280} height={800} note="Option B: idle siblings fold into a pool capsule with per-account quota dots.">
    <DenseScreen form="capsule" />
  </Frame>,
];
