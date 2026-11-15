import { Frame } from 'adg';
import { SingleChoice } from './single-choice';
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
        {title}{!compact && <span class="text-meta text-text-secondary font-semibold whitespace-pre"> · {date.split(" · ").map((text,i)=><>{i>0 && " · "}<span>{text}</span></>)}</span>}
      </button>
    </div>
    <div class={language === "en" ? "w-[157px]" : "w-[114px]"}><HomepageModeSwitch mode={mode} language={language} /></div>
  </div>;
}

export default () => [
  ...modeForms.map(({ name, ...props }) => <Frame name={name}><HomepageModeSwitch {...props} /></Frame>),
  <Frame name="homepage-bar-topology" width={760}><HomepageBar mode="topology" /></Frame>,
  <Frame name="homepage-bar-tasks" width={760}><HomepageBar mode="tasks" /></Frame>,
  <Frame name="homepage-bar-tasks-compact" width={358}><HomepageBar mode="tasks" compact /></Frame>,
];
