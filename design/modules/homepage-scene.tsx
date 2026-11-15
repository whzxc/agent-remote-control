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
import { TopologyScene, type TopologySceneData } from '../components/topology-scene';
import { topologyScenes } from '../fixtures/topology';

export function HomepageScene({ scene, chrome = true }: { scene: TopologySceneData; chrome?: boolean }) {
  return <div data-free class="relative bg-canvas text-text" style={{ width: scene.width, height: scene.height }}>
    <TopologyScene scene={scene} />
    {chrome && <>
      <div class="absolute top-6 inset-x-6"><HomepageBar mode="topology" compact={scene.width < 1000} time={scene.time} date={scene.date} title={scene.language === "zh-CN" ? "公示牌" : "Board"} language={scene.language} /></div>
    </>}
    <div class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
  </div>;
}
export default () => <Frame name="idle" width={1280} height={800} fixture="portrait-topology-0"
  capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.idle} /></Frame>;
