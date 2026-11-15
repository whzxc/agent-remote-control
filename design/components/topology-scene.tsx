import { Frame, Icon } from 'adg';
import { topologyScenes } from '../fixtures/topology';
import { BrandMark, type Brand } from './brand-mark';
import { AgentIcon, type AgentIconReading } from './agent-quota-mark';
import { NodeCapsule, type NodeTaskState } from './node-capsule';
import { TopologyGroup } from './topology-group';
import { TopologyMark } from './topology-mark';

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

/** Places solver output; shared nodes own their artwork and state. */
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
              'font-size': 12 * node.scale * 44 / 42, 'line-height': `${14 * node.scale * 44 / 42}px` }}>{node.label}</span>}
        </>}
      </div>;
    })}
  </div>;
}
export default () => <Frame name="hub-and-earcups" width={300} height={280}>
  <div data-free class="relative w-[300px] h-[280px] overflow-hidden bg-canvas">
    <div class="absolute -left-[490px] -top-[296px] w-[1280px] h-[800px]"><TopologyScene scene={topologyScenes.idle}/></div>
  </div>
</Frame>;
