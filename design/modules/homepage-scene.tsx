import {IconButton} from '../components/icon-button';
import {agentQuotas} from '../fixtures/quota';
export function NodePanelHeading() {
  return <div class="flex items-center gap-3 w-full"><AgentIcon brand="codex" size={44} readings={agentQuotas.map((quota,index)=>({id:String(index),label:quota.label,value:quota.value,color:`var(--${quota.tone})`,elapsed:quota.elapsed}))}/>
    <div class="flex flex-col flex-1 gap-1"><div class="flex gap-2 h-6 items-center"><h2 class="text-title font-[650] leading-6">Codex</h2><IconButton icon="arrow-up-right" label="Open Agent"/></div>
      <p class="text-meta text-text-secondary leading-4">fixture · 0 个任务进行中</p></div>
    <div class="flex gap-1"><IconButton icon="refresh-cw" label="Refresh"/><IconButton icon="settings" label="Settings"/>
      <IconButton icon="maximize-2" label="Expand"/></div>
  </div>;
}

import {agentIconForms,iconExampleBrand} from '../fixtures/agent-icons';
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

import { topologyScenes } from '../fixtures/topology';
import { BrandMark, type Brand } from '../components/brand-mark';
import { NodeCapsule, nodeCapsuleLayout, type NodeTaskState } from '../components/node-capsule';
import { TopologyMark } from '../components/topology-mark';
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
            <NodeCapsule state={state} label={node.label} graphic={graphic}
              mark={node.device ? deviceMark : <BrandMark brand={brand} size={28} />}
              neutralRing={node.device} readings={readings} wing={node.wing as 'left' | 'right'} compact={scene.width < scene.height} />
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


import { capsuleForms, quotaReadings, accountContrast } from '../fixtures/node-capsule';
export function GraphFeedback({children}:{children:unknown}){return <div class="text-small text-danger">{children}</div>}
export function GraphAction({children}:{children:unknown}){return <span class="relative grid size-[30px] place-items-center"><span class="absolute size-5 rounded-full bg-accent"/><span class="relative text-canvas">{children}</span></span>}
export function HubEntry({children}:{children:unknown}){return <button class="grid size-7 place-items-center rounded-full border-0 bg-transparent">{children}</button>}
import { items } from '../fixtures/nav-capsule';
import { Icon } from "adg";


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

import { SingleChoice } from '../components/single-choice';
import { modeCopy as copy, modeForms } from '../fixtures/homepage-mode';


export type HomepageMode = 'topology' | 'tasks';

export function HomepageModeSwitch({ mode, language = "en" }: { mode: HomepageMode; language?: "en" | "zh-CN" }) {
  return <SingleChoice label={copy.label} value={mode} options={[
    { value: 'topology', label: language === "en" ? copy.topology : "拓扑" }, { value: 'tasks', label: language === "en" ? copy.tasks : "任务" },
  ]} />;
}

/** The clock and Board entry share a baseline; mode choice stays centered. */
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


import { Frame } from 'adg';


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
export default () => [homepageSpecimen(), ...capsuleSpecimens()];
