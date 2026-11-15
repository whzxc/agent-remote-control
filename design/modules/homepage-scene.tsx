import { IconButton } from '../components/icon-button';
import { agentQuotas } from '../fixtures/quota';
import { agentIconForms, iconExampleBrand } from '../fixtures/agent-icons';
import { topologyScenes } from '../fixtures/topology';
import { BrandMark, type Brand } from '../components/brand-mark';
import { capsuleForms, quotaReadings, accountContrast, stepCopy } from '../fixtures/node-capsule';
import { items } from '../fixtures/nav-capsule';
import { Icon, Frame } from 'adg';
import { SingleChoice } from '../components/single-choice';
import { modeCopy as copy, modeForms } from '../fixtures/homepage-mode';
import { recentSteps } from '../fixtures/task-activity';
import { example } from '../fixtures/topology-node';
import ArcMarkArt from '../art/arc-mark.svg';
import { Button } from '../components/button';
import { Dialog } from '../components/panel';
import { markForms, recoveryForms, ringCopy } from '../fixtures/topology-mark';

export function NodePanelHeading() {
  return <div class="flex items-center gap-3 w-full"><TopologyNode bare label="Codex" graphic={<AgentIcon brand="codex" size={44} readings={agentQuotas.map((quota,index)=>({id:String(index),label:quota.label,value:quota.value,color:`var(--${quota.tone})`,elapsed:quota.elapsed}))}/>}/>
    <div class="flex flex-col flex-1 gap-1"><div class="flex gap-2 h-6 items-center"><h2 class="text-title font-[650] leading-6">Codex</h2><IconButton icon="arrow-up-right" label="Open Agent"/></div>
      <p class="text-meta text-text-secondary leading-4">fixture · 0 个任务进行中</p></div>
    <div class="flex gap-1"><IconButton icon="refresh-cw" label="Refresh"/><IconButton icon="settings" label="Settings"/>
      <IconButton icon="maximize-2" label="Expand"/></div>
  </div>;
}

const arcs = {
  1: [[0, 360]],
  2: [
    [-8, -172],
    [8, 172],
  ],
  3: [
    [8, 112],
    [128, 232],
    [248, 352],
  ],
};

export type AgentIconReading = {
  id: string;
  label: string;
  value: number;
  color: string;
  elapsed?: number;
};

function arcPath(start: number, end: number, radius = 21) {
  const point = (angle: number) => {
    const r = (angle * Math.PI) / 180;
    return `${24 + radius * Math.sin(r)} ${24 - radius * Math.cos(r)}`;
  };
  const sweep = end > start ? 1 : 0;
  const span = Math.abs(end - start);
  const command = `A${radius} ${radius} 0`;
  return span === 360
    ? `M${point(start)} ${command} 0 ${sweep} ${point(start + (end - start) / 2)} ${command} 0 ${sweep} ${point(start)} Z`
    : `M${point(start)} ${command} ${span > 180 ? 1 : 0} ${sweep} ${point(end)}`;
}

export function AgentIcon({
  brand,
  readings = [],
  used = false,
  size = 48,
}: {
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  size?: number;
}) {
  const ranges = arcs[readings.length as keyof typeof arcs];
  return (
    <span
      style={{ width: size, height: size }}
      class="grid shrink-0 place-items-center text-text"
      role="img"
      aria-label={readings.map((r) => r.label).join(" · ")}
    >
      {ranges && (
        <svg
          data-free
          class="col-start-1 row-start-1"
          width={size}
          height={size}
          viewBox="0 0 48 48"
          fill="none"
          stroke-width="3"
          stroke-linecap="round"
        >
          {ranges.map(([start, end], i) => {
            const { value, color, elapsed } = readings[i];
            const track = arcPath(start, end);
            const single = readings.length === 1;
            const time = elapsed !== undefined && single && !used ? 1 - elapsed : elapsed ?? 0;
            const tick = start + (end - start) * time;
            const quotaEnd = start + (end - start) * value / 100;
            const pace = (used ? value : 100 - value) / 100 - (elapsed ?? 0);
            const showPace = single && elapsed !== undefined && Math.abs(pace) > Number.EPSILON;
            return (
              <g>
                <path d={track} stroke="var(--border-strong)" />
                <path
                  d={
                    readings.length === 2 && !used ? arcPath(end, start) : track
                  }
                  pathLength="100"
                  stroke={color}
                  stroke-dasharray={`${value} 100`}
                />
                {showPace && (
                  <path
                    d={arcPath(Math.min(tick, quotaEnd), Math.max(tick, quotaEnd), 17)}
                    stroke={pace > 0 ? "var(--danger)" : "var(--success)"}
                    stroke-width="1.5"
                    stroke-dasharray="2 2.4"
                  />
                )}
                <path
                  d={showPace ? "M24 1V7" : "M24 1V5"}
                  transform={`rotate(${tick} 24 24)`}
                  stroke="var(--text-secondary)"
                  stroke-width="1.5"
                />
              </g>
            );
          })}
        </svg>
      )}
      <span class="col-start-1 row-start-1 flex">
        <BrandMark
          brand={brand}
          size={Math.round(((ranges ? 28 : 38) * size) / 48)}
        />
      </span>
    </span>
  );
}

type Rect = { x: number; y: number; width: number; height: number };

export type TopologySceneData = {
  width: number; height: number; fixture: string; origin: { x: number; y: number };
  time: string; date: string; language?: "en" | "zh-CN"; nav: boolean; hub: Rect;
  paths: { d: string; fill: string; stroke: string; strokeWidth: string; opacity: number }[];
  nodes: {
    id: string; device?: boolean; label: string; brand?: string; x: number; y: number; scale: number;
    wing: string; capsule: boolean; width: number;
    group?: { count: number; layout: string };
    labelBox?: Rect;
    items: { kind?: string; phase?: string }[];
    readings: { value: number; color: string; elapsed?: number }[];
  }[];
};

export function TopologyScene({ scene }: { scene: TopologySceneData }) {
  return <div data-free class="absolute inset-0 overflow-hidden">
    <svg class="absolute inset-0" width={scene.width} height={scene.height} fill="none">
      <g transform={`translate(${scene.origin.x} ${scene.origin.y})`}>
        {scene.paths.map(path => <path d={path.d} fill={path.fill} stroke={path.stroke}
          stroke-width={path.strokeWidth} opacity={path.opacity} stroke-linecap="round" />)}
      </g>
    </svg>
    <div class="absolute" style={{ left: scene.hub.x, top: scene.hub.y }}>
      <TopologyMark size={scene.hub.width} sourceAction={false} agentAction={false} />
    </div>
    {scene.nodes.map(node => {
      const brand = node.brand as Brand;
      const readings: readonly AgentIconReading[] = node.readings.map((reading,index)=>({id:String(index),label:node.label,...reading}));
      const state: NodeTaskState = {
        attention: node.items.filter(item => item.kind === 'attention').length,
        running: node.items.filter(item => item.kind === 'step').length,
        steps: node.items.filter(item => item.kind === 'step').map(item => item.phase as 'thinking'),
        ...(node.items.some(item => item.kind === 'failed') ? { exception: 'failed' as const } : {}),
      };
      const deviceMark = <span class="relative flex size-7"><BrandMark brand="codex" size={28}/><span class="absolute -bottom-1 -right-1 rounded-full bg-surface p-px"><Icon name="laptop" size={10}/></span></span>;
      const graphic = node.device ? deviceMark : node.wing === 'left'
        ? <BrandMark brand={brand} size={39.81} />
        : <AgentIcon brand={brand} size={44} readings={readings} />;
      return <div class="absolute size-11" style={{ left: node.x, top: node.y }}>
        {node.group ? <div style={{ transform: `scale(${node.scale})`, 'transform-origin': '22px 22px' }}>
          <TopologyGroup label={node.label} members={Array.from({ length: node.group.count }, () => ({ brand: 'codex' as const }))}
            layout={node.group.layout as 'vertical'} />
        </div> : <>
          <div class="absolute" style={{ left: -2, top: -2, transform: `scale(${node.scale})`, 'transform-origin': '24px 24px' }}>
            <TopologyNode bare hideLabel taskState={state} label={node.label} graphic={graphic}
              capsuleMark={node.device ? deviceMark : <BrandMark brand={brand} size={28} />}
              capsuleNeutralRing={node.device} readings={readings} capsuleWing={node.wing as 'left' | 'right'} capsuleCompact={scene.width < scene.height} />
          </div>
          {node.labelBox && <span class={`absolute text-text text-meta leading-[14px] text-center ${node.device ? "whitespace-pre-line" : "truncate"}`}
            style={{ left: node.labelBox.x, top: node.labelBox.y, width: node.labelBox.width,
              'font-size': 12 * node.scale * 44 / 42, 'line-height': `${14 * node.scale * 44 / 42}px` }}>{node.device ? <>{node.label.split("\n")[0]}<small class="block text-[83.3333%] leading-[14px] text-text-secondary">{node.label.split("\n")[1]}</small></> : node.label}</span>}
        </>}
      </div>;
    })}
  </div>;
}

export type TopologyGroupQuota = "ok" | "low" | "out" | "unknown";

export type TopologyGroupMember = { brand: Brand; quota?: TopologyGroupQuota };

export type TopologyGroupProps = {
  label: string;
  members: readonly TopologyGroupMember[];
  layout?: "vertical" | "source" | "agent";
  hideLabel?: boolean;
};

export function TopologyGroup({ label, members, layout = "vertical", hideLabel = false }: TopologyGroupProps) {
  const brands = [...new Set(members.map((m) => m.brand))];
  const pool = brands.length === 1;
  const capsuleLayout = layout === "agent"
    ? `flex-row-reverse pl-3 ${pool ? "pr-[9px]" : "pr-2"}`
    : `pr-3 ${pool ? "pl-[9px]" : "pl-2"}`;
  const capsule = (
    <span
      aria-label={hideLabel ? label : undefined}
      class={
        "flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface shadow-sm " + capsuleLayout
      }
    >
      {pool ? (
        <BrandMark brand={brands[0]} size={28} />
      ) : (
        <span class="flex">
          {brands.slice(0, 3).map((brand, i) => (
            <span
              class={
                "flex size-[30px] items-center justify-center rounded-full border border-border bg-surface " +
                String(i ? "-ml-[4px]" : "")
              }
            >
              <BrandMark brand={brand} size={18} />
            </span>
          ))}
        </span>
      )}
      <span aria-hidden="true" class="text-meta font-semibold tabular-nums text-text-secondary">{members.length}</span>
    </span>
  );
  if (hideLabel) return capsule;
  if (layout === "source")
    return (
      <div class="flex h-12 items-center gap-[5px] text-text">
        <span class="flex w-[85px] shrink-0 justify-end text-meta text-text-secondary">{label}</span>
        {capsule}
      </div>
    );
  if (layout === "agent")
    return (
      <div class="flex h-12 items-center gap-2 text-text">
        {capsule}
        <span class="whitespace-nowrap text-meta text-text-secondary">{label}</span>
      </div>
    );
  return (
    <div class="flex w-max flex-col items-start gap-1 text-text">
      {capsule}
      <span aria-hidden="true" class="pl-[6px] whitespace-nowrap text-meta leading-5 text-text-secondary">{label}</span>
    </div>
  );
}

export function GraphFeedback({children}:{children:unknown}){return <div class="text-small text-danger">{children}</div>}

export function GraphAction({children}:{children:unknown}){return <span class="relative grid size-[30px] place-items-center"><span class="absolute size-5 rounded-full bg-accent"/><span class="relative text-canvas">{children}</span></span>}

export function HubEntry({children}:{children:unknown}){return <button class="grid size-7 place-items-center rounded-full border-0 bg-transparent">{children}</button>}

export function NavCapsule({
  items: entries = items,
  active = "permissions",
}: {
  items?: { id: string; icon: string; label: string }[];
  active?: string;
}) {
  return (
    <nav class="inline-flex items-center gap-1 px-[6px] py-(--dock-padding-block) rounded-[22px] bg-surface-raised shadow-lg">
      {entries.map((item) => (
        <button
          aria-label={item.label}
          class={
            "flex items-center justify-center size-(--dock-button-size) rounded-card " +
            String(item.id === active ? "bg-surface-sunken text-text" : "text-text-secondary")
          }
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
    </nav>
  );
}

export type HomepageMode = 'topology' | 'tasks';

export function HomepageModeSwitch({ mode, language = "en" }: { mode: HomepageMode; language?: "en" | "zh-CN" }) {
  return <SingleChoice label={copy.label} value={mode} options={[
    { value: 'topology', label: language === "en" ? copy.topology : "拓扑" }, { value: 'tasks', label: language === "en" ? copy.tasks : "任务" },
  ]} />;
}

export function HomepageBar({ mode, compact = false, date = copy.date, time = copy.time, title = copy.board, language = "en" }: {
  mode: HomepageMode; compact?: boolean; date?: string; time?: string; title?: string; language?: "en" | "zh-CN";
}) {
  return <div class="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-text">
    <div class="flex items-baseline gap-2 min-w-0 overflow-visible">
      <time class="text-title leading-6 font-[650] tabular-nums">{time}</time>
      <button class="flex items-center gap-0 min-w-0 h-9 text-small font-semibold whitespace-nowrap shrink-0">
        {title}{!compact && <span class="text-meta text-text-secondary font-semibold">{` · ${date}`}</span>}
      </button>
    </div>
    <div class={language === "en" ? "w-[157px]" : "w-[114px]"}><HomepageModeSwitch mode={mode} language={language} /></div>
  </div>;
}

export function HomepageScene({ scene, chrome = true }: { scene: TopologySceneData; chrome?: boolean }) {
  return <div data-free class="relative bg-canvas text-text" style={{ width: scene.width, height: scene.height }}>
    <TopologyScene scene={scene} />
    {chrome && <>
      <div class="absolute top-6 inset-x-6"><HomepageBar mode="topology" compact={scene.width < 1000} time={scene.time} date={scene.date} title={scene.language === "zh-CN" ? "公示牌" : "Board"} language={scene.language} /></div>
    </>}
    <div class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
  </div>;
}

const homepageSpecimen = () => <Frame name="idle" width={1280} height={800} fixture="portrait-topology-0"
  capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.idle} /></Frame>;

export const capsuleSpecimens = () => [
  ...capsuleForms.filter(form => !['unread', 'compact'].includes(form.name)).map(({ name, state, compact, wing, brand = 'codex', label = 'Codex' }) => {
    const model = nodeCapsuleLayout(state, compact);
    return <Frame name={`capsule-${name}`} width={model.width} height={48}
      note="The quota ring is the capsule outline. Logo anchor stays fixed; width and the outer port use the topology spring 210/26; reduced motion is direct.">
      <div class="flex h-12" style={{ width: model.width }}>
        {wing === 'left' && <span class="flex-1" />}
        <NodeCapsule label={label} graphic={<AgentIcon brand={brand} readings={quotaReadings} />}
          mark={<BrandMark brand={brand} size={28} />} readings={quotaReadings}
          state={state} compact={compact} wing={wing} />
      </div>
    </Frame>;
  }),
  <Frame name="account-contrast" width={420} height={72}>
    <div class="flex w-[420px] items-start justify-between gap-6 pt-1">
      <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
        mark={<BrandMark brand="codex" size={28} />} readings={quotaReadings} state={capsuleForms[1].state} />
      <TopologyGroup {...accountContrast} />
    </div>
  </Frame>,
];

const homepage_sceneFrames = () => [homepageSpecimen(), ...capsuleSpecimens()];


export type TaskStepKind = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting';

export type TaskStep = { kind: TaskStepKind; text: string; status: 'completed' | 'running' | 'pending'; elapsed?: string };

export type TaskPlan = { completed: number; total: number; current: string };

export type TaskChange = { kind: 'file' | 'diff' | 'command'; summary: string; added?: number; removed?: number; output?: string };

const icons: Record<TaskStepKind, string> = {
  reading: 'file-search', editing: 'file-pen-line', command: 'terminal', thinking: 'brain', waiting: 'clock-3',
};

export function TaskActivityIcon({ kind, size = 14 }: { kind: TaskStepKind; size?: number }) {
  return <Icon name={icons[kind]} size={size} />;
}

export function PhaseLabel({ children, phase = 'thinking', running = false }: { children: unknown; phase?: string; running?: boolean }) {
  return <span data-free class="relative min-w-0 overflow-hidden text-ellipsis" style={{ color: `var(--phase-${phase})` }}>
    {children}{running && <span class="absolute inset-0 opacity-15" aria-hidden="true">{children}</span>}
  </span>;
}

const task_activityFrames = () => [
  <Frame name="phase-label"><PhaseLabel>Thinking</PhaseLabel></Frame>,

  <Frame name="task-activity-icons">
    <div class="flex items-center gap-3">
      {[...new Set(recentSteps.map(step => step.kind)), 'waiting' as const].map(kind => <TaskActivityIcon kind={kind} />)}
    </div>
  </Frame>
];


export type NodeTaskState = {
  running?: number; attention?: number; unread?: number; exception?: 'failed' | 'interrupted'; steps?: readonly TaskStepKind[];
};

const height = 48, radius = 21, step = 28, disc = 20;

const limits = { full: 5, compact: 2 };

export const capsuleMaximum = { full: height + limits.full * step, compact: height + limits.compact * step };

type Item = { kind: 'attention' } | { kind: 'step'; step: TaskStepKind | 'running' }
  | { kind: 'overflow' } | { kind: 'failed' } | { kind: 'interrupted' };

export function nodeCapsuleLayout(state?: NodeTaskState, compact = false) {
  const items: Item[] = [];
  const limit = compact ? limits.compact : limits.full;
  if (state?.attention) items.push({ kind: 'attention' });
  if (state?.exception) items.push({ kind: state.exception });
  const room = limit - items.length;
  const running = state?.running ?? 0;
  const shown = running > room ? Math.max(0, room - 1) : running;
  for (let index = 0; index < shown; index++) items.push({ kind: 'step', step: state?.steps?.[index] ?? 'running' });
  if (room && running > shown) items.push({ kind: 'overflow' });
  return { width: height + items.length * step, active: items.length > 0, items };
}

function stadium(width: number, r: number) {
  const straight = width - height, arc = Math.PI * r, total = 2 * straight + 2 * arc;
  const at = (d: number): [number, number, number, number] => {
    d = ((d % total) + total) % total;
    if (d < straight) return [24 + d, 24 - r, 0, -1];
    d -= straight;
    if (d < arc) { const a = d / r; return [width - 24 + r * Math.sin(a), 24 - r * Math.cos(a), Math.sin(a), -Math.cos(a)]; }
    d -= arc;
    if (d < straight) return [width - 24 - d, 24 + r, 0, 1];
    d -= straight;
    const a = d / r; return [24 - r * Math.sin(a), 24 + r * Math.cos(a), -Math.sin(a), Math.cos(a)];
  };
  const path = (from: number, to: number) => {
    const n = Math.max(2, Math.ceil(Math.abs(to - from) * 2));
    return Array.from({ length: n + 1 }, (_, i) => at(from + (to - from) * i / n))
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  };
  return { total, at, path };
}

function CapsuleRing({ width, readings = [], used = false }: {
  width: number; readings?: readonly AgentIconReading[]; used?: boolean;
}) {
  // The pace trace stays on the idle ring and in the panel; on a straight run it reads as an underline.
  const ring = stadium(width, radius);
  const ranges = ({ 1: [[0, 360]], 2: [[-8, -172], [8, 172]], 3: [[8, 112], [128, 232], [248, 352]] } as
    Record<number, number[][]>)[readings.length];
  const d = (s: { total: number }, angle: number) => s.total * angle / 360;
  return <svg data-free class="pointer-events-none absolute inset-0" width={width} height={height}
    viewBox={`0 0 ${width} ${height}`} fill="none" stroke-width="3" stroke-linecap="round">
    {!ranges && <path d={ring.path(0, ring.total)} stroke="var(--border-strong)" />}
    {ranges?.map(([start, end], i) => {
      const { value, color, elapsed } = readings[i];
      const single = readings.length === 1;
      const reverse = readings.length === 2 && !used;
      const time = elapsed !== undefined && single && !used ? 1 - elapsed : elapsed ?? 0;
      const tick = start + (end - start) * time;
                  const [tx, ty, nx, ny] = ring.at(d(ring, tick));
      return <g>
        <path d={ring.path(d(ring, start), d(ring, end))} stroke="var(--border-strong)" />
        <path d={reverse ? ring.path(d(ring, end), d(ring, start)) : ring.path(d(ring, start), d(ring, end))}
          pathLength="100" stroke={color} stroke-dasharray={`${value} 100`} />
        <path d={`M${tx + nx * 2} ${ty + ny * 2}L${tx - nx * 2} ${ty - ny * 2}`}
          stroke="var(--text-secondary)" stroke-width="1.5" />
      </g>;
    })}
  </svg>;
}

const stepTone: Record<TaskStepKind | 'running', string> = {
  reading: 'text-phase-file', editing: 'text-phase-file', command: 'text-phase-command',
  thinking: 'text-phase-thinking', waiting: 'text-text-tertiary', running: 'text-role-agent',
};

function CapsuleItem({ item }: { item: Item }) {
  const base = 'flex shrink-0 items-center justify-center rounded-full';
  const size = { width: disc, height: disc };
  if (item.kind === 'attention') return <span style={size} class={`${base} bg-warning text-canvas`}>
    <Icon name="shield-alert" size={12} /></span>;
  if (item.kind === 'overflow') return <span style={size}
    class={`${base} bg-surface-sunken text-text-secondary`}><Icon name="ellipsis" size={13} /></span>;
  if (item.kind === 'failed' || item.kind === 'interrupted') return <span style={size}
    class={`${base} bg-surface-subtle ${item.kind === 'failed' ? 'text-danger' : 'text-warning'}`}>
    <Icon name={item.kind === 'failed' ? 'circle-x' : 'circle-pause'} size={12} /></span>;
  return <span style={size} class={`${base} bg-surface-subtle ${stepTone[item.step]}`}>
    {item.step === 'running' ? <Icon name="loader" size={12} /> : <TaskActivityIcon kind={item.step} size={12} />}
  </span>;
}

export function NodeCapsule({ state, label, graphic, mark, readings, used, neutralRing = false, compact = false, wing = 'right', expanded }: {
  state?: NodeTaskState; label: string; graphic: unknown; mark?: unknown; readings?: readonly AgentIconReading[];
  used?: boolean; neutralRing?: boolean; compact?: boolean; wing?: 'left' | 'right'; expanded?: boolean;
}) {
  const model = nodeCapsuleLayout(state, compact);
  const summary = [
    state?.exception ? stepCopy[state.exception] : '',
    state?.attention ? `${state.attention} need me` : '', state?.running ? `${state.running} running` : '',
    state?.unread ? `${state.unread} completed unread` : '', ...(state?.steps ?? []).map(s => stepCopy[s]),
  ].filter(Boolean).join(', ');
  const width = model.width;
  const mirror = wing === 'left';
  const buttonLeft = 40;
  return <span data-free class="relative inline-flex size-12 shrink-0" data-capsule-logo-anchor
    data-spring-stiffness="210" data-spring-damping="26">
    <span class={`absolute top-0 h-12 motion-reduce:transition-none ${mirror ? 'right-0' : 'left-0'}`}
      style={{ width, transform: mirror ? 'scaleX(-1)' : undefined }}>
      {model.active ? <>
        <span class="absolute inset-[1.5px] rounded-full bg-surface shadow-sm" />
        <CapsuleRing width={width} readings={readings} used={used} />
        <button aria-label={`Open ${label} panel`} aria-expanded={expanded}
          class="absolute left-0 top-0 z-10 flex size-12 items-center justify-center rounded-full"
          style={{ transform: mirror ? 'scaleX(-1)' : undefined }}><span class="flex scale-[.92]">{mark ?? graphic}</span></button>
        <button aria-label={`${label}: ${summary}. Open Tasks`} title={summary}
          class="absolute top-0 z-10 h-12 rounded-r-full" style={{ left: buttonLeft, width: width - buttonLeft }}>
          {model.items.map((item, i) => <span class="absolute flex size-5 items-center justify-center"
            style={{ left: 24 + (i + 1) * step - disc / 2 - buttonLeft, top: (height - disc) / 2, width: disc,
              transform: mirror ? 'scaleX(-1)' : undefined }}><CapsuleItem item={item} /></span>)}
        </button>
      </> : <span class="absolute left-0 top-0 flex size-12" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        {neutralRing && <CapsuleRing width={48} />}
        {graphic}</span>}

    </span>
  </span>;
}

const node_capsuleFrames = () => <Frame name="capsule" width={132} height={48}>
  <NodeCapsule label="Codex" graphic={<BrandMark brand="codex" size={38}/>} mark={<BrandMark brand="codex" size={28}/>} state={{running:2,steps:['reading','thinking']}}/>
</Frame>;


export type TopologyNodeProps = {
  label: string;
  bare?: boolean;
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  width?: number;
  layout?: "vertical" | "source" | "agent";
  hideLabel?: boolean;
  graphic?: unknown;
  /** The logo drawn inside a working capsule, whose outline replaces the quota ring. */
  capsuleMark?: unknown;
  capsuleReadings?: readonly AgentIconReading[];
  taskState?: NodeTaskState;
  capsuleNeutralRing?: boolean;
  capsuleCompact?: boolean;
  capsuleWing?: "left" | "right";
  panelExpanded?: boolean;
  hasChildren?: boolean;
};

export function TopologyNode({
  label, bare = false,
  brand,
  readings,
  used,
  width = 110,
  layout = "vertical",
  hideLabel = false,
  graphic: customGraphic,
  capsuleMark,
  capsuleReadings,
  taskState,
  capsuleNeutralRing = false,
  capsuleCompact = false,
  capsuleWing = "right",
  panelExpanded, hasChildren = false,
}: TopologyNodeProps) {
  const horizontal = layout !== "vertical";
  const baseGraphic = customGraphic ?? (
    <span class={horizontal ? "grid size-12 shrink-0 place-items-center" : "flex"}>
      {horizontal && (
        <span
          class={
            "col-start-1 row-start-1 rounded-full bg-canvas " +
            String(readings?.length ? "size-[46px]" : "size-[42px]")
          }
        />
      )}
      <span class="col-start-1 row-start-1 flex">
        <BrandMark brand={brand} size={readings?.length ? 28 : 38} />
      </span>
    </span>
  );
  const mark = capsuleMark ?? (customGraphic ? undefined : <BrandMark brand={brand} size={readings?.length ? 28 : 32} />);
  const graphic = taskState && !hasChildren ? <NodeCapsule state={taskState} label={label} graphic={baseGraphic} mark={mark}
    readings={capsuleReadings ?? readings} used={used} neutralRing={capsuleNeutralRing}
    compact={capsuleCompact} wing={capsuleWing} expanded={panelExpanded} /> : baseGraphic;
  if (bare) return graphic;
  return (
    <div
      aria-label={hideLabel ? label : undefined}
      style={{ width: hideLabel ? 48 : width }}
      class={
        "flex text-text " +
        String(
          hideLabel
            ? "h-12 items-center justify-center"
            : horizontal
              ? "h-[76px] items-start pt-[2px] gap-[5px]"
              : "h-[76px] flex-col items-center gap-[2px] pt-[2px]",
        )
      }
    >
      {hideLabel ? (
        graphic
      ) : layout === "source" ? (
        <>
          <span class="flex w-[85px] shrink-0 justify-end items-center h-12 text-meta">{label}</span>
          {graphic}
        </>
      ) : (
        <>
          {graphic}
          {label && (
            <span class={`text-meta ${horizontal ? "flex items-center h-12 whitespace-nowrap" : "leading-5"}`}>
              {label}
            </span>
          )}
        </>
      )}
    </div>
  );
}

const topology_nodeFrames = () => (
  <Frame name="node-default">
    <TopologyNode {...example} />
  </Frame>
);


type ArcHealth = "healthy" | "unhealthy";

type ArcSide = "remote" | "core";

const geometry = {
  size: 240,
  sourceX: 36.52,
  agentX: 203.48,
  centerY: 120,
  dotRadius: 3.91,
  dotGap: 15.65,
};

export function TopologyMark({
  size = geometry.size,
  remote = "healthy",
  core = "healthy",
  revealed,
  sourceAction = true,
  agentAction = true,
}: {
  size?: number;
  remote?: ArcHealth;
  core?: ArcHealth;
  revealed?: ArcSide;
  sourceAction?: boolean;
  agentAction?: boolean;
}) {
  const g = geometry;
  const fault = {
    ...(remote === "unhealthy" ? { "--remote-arc-color": "var(--danger)" } : {}),
    ...(core === "unhealthy" ? { "--core-arc-color": "var(--danger)" } : {}),
  };
  const mark = (
    <svg
      data-free width={size} height={size} viewBox="0 0 240 240" role="img"
      aria-label={`${ringCopy.remote.status[remote]}. ${ringCopy.core.status[core]}.`}
    >
      <ArcMarkArt data-brand width={240} height={240} style={fault} />
      {sourceAction && (
        <g fill="none" stroke="var(--canvas)" stroke-width={7.82} stroke-linecap="round">
          <path d={`M${g.sourceX - 9.333} ${g.centerY}h18.666M${g.sourceX} ${g.centerY - 9.333}v18.666`} />
        </g>
      )}
      {agentAction &&
        [-1, 0, 1].map((i) => (
          <circle cx={g.agentX + i * g.dotGap} cy={g.centerY} r={g.dotRadius} fill="var(--canvas)" />
        ))}
    </svg>
  );
  if (!revealed) return mark;
  const upper = revealed === "remote";
  const actions = upper
    ? remote === "unhealthy" ? [ringCopy.remote.healthy, ringCopy.remote.unhealthy] : [ringCopy.remote.healthy]
    : [{ icon: "laptop", label: "Device link" }, ringCopy.core[core]];
  return (
    <div class={`relative flex justify-center ${upper ? "pt-4" : "pb-4"}`} style={{ width: size }}>
      {mark}
      <div class={`absolute left-1/2 flex -translate-x-1/2 gap-2 ${upper ? "top-0" : "bottom-0"}`}>
        {actions.map((action) => <IconButton {...action} compact active />)}
      </div>
    </div>
  );
}

export function ArcRecovery({ form }: { form: typeof recoveryForms[number]["form"] }) {
  const { title, reason, impact, secondary, primary } = ringCopy.recovery[form];
  return (
    <Dialog title={title}>
      <div class="flex flex-col gap-2">
        <p class="text-small leading-5">{reason}</p>
        {impact && <p class="text-meta leading-5 text-text-secondary">{impact}</p>}
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        {secondary && <Button>{secondary}</Button>}
        <Button variant="primary">{primary}</Button>
      </div>
    </Dialog>
  );
}

const topology_markFrames = () => [
  ...markForms.map(({ name, note, ...props }) => (
    <Frame name={name} note={note}>
      <TopologyMark {...props} />
    </Frame>
  )),
  ...recoveryForms.filter(form => !['core', 'blocked'].includes(form.form)).map(({ form, note }) => (
    <Frame name={`arc-recovery-${form}`} note={note}>
      <ArcRecovery form={form} />
    </Frame>
  )),
];

export default () => [...[homepage_sceneFrames()].flat(), ...[task_activityFrames()].flat(), ...[node_capsuleFrames()].flat(), ...[topology_nodeFrames()].flat(), ...[topology_markFrames()].flat()];
