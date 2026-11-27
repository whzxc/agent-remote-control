import { items } from '../../fixtures/nav-capsule';
import { Icon } from 'adg';
import { SingleChoice } from '../../components/single-choice';
import { modeCopy as copy } from '../../fixtures/homepage-mode';

export function NavCapsule({
  items: entries = items,
  hosting = false,
  active = "permissions",
}: {
  items?: { id: string; icon: string; label: string }[];
  active?: string;
  hosting?: boolean;
}) {
  return (
    <nav className="inline-flex items-center gap-1 px-[6px] py-(--dock-padding-block) rounded-panel bg-surface-raised shadow-lg">
      {(hosting ? [...entries, {id: "relay-hosting", icon: "cloud", label: "Relay hosting"}] : entries).map((item) => (
        <button
          key={item.id}
          data-adg-id={`nav-${item.id}`}
          aria-label={item.label}
          className={
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
  return <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-text">
    <div className="flex items-baseline gap-2 min-w-0 overflow-visible">
      <time className="text-title leading-6 font-[650] tabular-nums">{time}</time>
      <button className="flex items-center gap-1.5 min-w-0 h-9 text-small font-semibold whitespace-nowrap shrink-0">
        {title}{!compact && <span className="text-meta text-text-secondary font-semibold">{` · ${date}`}</span>}
      </button>
    </div>
    <div className={language === "en" ? "w-[157px]" : "w-[114px]"}><HomepageModeSwitch mode={mode} language={language} /></div>
  </div>;
}
