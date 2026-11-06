import { Frame, Icon } from "sdg";
import { PanelShell } from "../components/panel";
import { AgentIcon } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaSummary } from "../components/quota-card";
import { TaskBubble } from "../components/task-bubble";
import { Tile } from "../components/tile";
import { Tag } from "../components/tag";

const quotas = [
  {
    label: "5h 额度 · 2h 0m",
    remaining: 27,
    estimate: "≈ 1h 7m",
    elapsed: 0.4,
  },
  {
    label: "周额度 · 3d 0h",
    remaining: 32,
    estimate: "≈ 1d 21h",
    elapsed: 3 / 7,
  },
];
const active = [
  {
    heading: "需要你处理 · 1",
    title: "Confirm access to project files",
    phase: "等待输入",
    headline: "Read README.md",
    tone: "warning",
    icon: "shield-alert",
    form: "row-attention",
  },
  {
    heading: "运行中 · 1",
    title: "Verify project changes",
    phase: "执行命令",
    headline: "npm run check",
    duration: "21:54",
    tone: "command",
    icon: "terminal",
    form: "row",
  },
] as const;
const history = [
  { heading: "今天 · 3", tasks: [1, 2, 3], date: "1月1日" },
  { heading: "昨天 · 1", tasks: [4], date: "2025年12月31日" },
];
const spec = {
  model: "GPT-6.1 Sol",
  effort: "高推理强度",
  position: { count: 4, index: 2 },
  fast: true,
  tier: "快速",
};
function AgentPanel({ empty = false }: { empty?: boolean }) {
  return (
    <PanelShell width={420} height={empty ? 320 : 840} class="px-5 pt-4 pb-3">
      <header class="flex items-center gap-3">
        <AgentIcon
          brand="codex"
          size={44}
          readings={quotas.map((q, i) => ({
            id: String(i),
            label: q.label,
            value: q.remaining,
            color: "var(--warning)",
            elapsed: 1 - q.elapsed,
          }))}
        />
        <div class="flex flex-1 flex-col gap-1">
          <h2 class="text-title leading-6 font-[650] flex items-center gap-2">
            Codex
            <Icon name="arrow-up-right" size={16} />
          </h2>
          <p class="text-meta leading-4 text-text-secondary">
            fixture · {empty ? 0 : 2} 个任务进行中
          </p>
        </div>
        <div class="flex items-center gap-1">
          {["refresh-cw", "settings", "maximize-2"].map((icon) => (
            <IconButton icon={icon} label={icon} />
          ))}
        </div>
      </header>
      <div class="mt-5 grid grid-cols-2 gap-2">
        {quotas.map((q) => (
          <QuotaSummary {...q} />
        ))}
      </div>
      {empty ? (
        <div class="mt-12 flex flex-col items-center gap-[10px] text-text-tertiary">
          <Tile icon="messages-square" tone="neutral" />
          <p class="text-small leading-4">暂无未归档对话。</p>
        </div>
      ) : (
        <div class="mt-6 flex flex-col gap-7">
          {active.map(({ heading, ...task }) => (
            <section class="flex flex-col gap-2">
              <h3
                class={`text-meta leading-4 font-semibold ${task.tone === "warning" ? "text-warning" : "text-text-secondary"}`}
              >
                {heading}
              </h3>
              <TaskBubble
                {...task}
                project="acceptance"
                date="1月1日"
                dispatch={spec}
              />
            </section>
          ))}
          {history.map((group) => (
            <section class="flex flex-col gap-2">
              <h3 class="text-meta leading-4 font-semibold text-text-secondary">
                {group.heading}
              </h3>
              {group.tasks.map((n) => (
                <div class="flex h-16 items-start gap-3 rounded-card bg-surface-subtle p-3">
                  <Tile icon="circle" form="phase" tone="neutral" />
                  <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <strong class="text-small leading-[18px] font-[650]">
                      Review project change {n}
                    </strong>
                    <div class="flex items-center justify-between">
                      <Tag>acceptance</Tag>
                      <span class="text-caption text-text-tertiary">
                        {group.date}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="overview"
    fixture="agent-panel"
    capture={{ region: "Codex", viewport: "1280x1100" }}
    note="Full-content drawing exceeds the scroll viewport; inspect remaining scroll content during browser acceptance."
  >
    <AgentPanel />
  </Frame>,
  <Frame
    name="empty"
    fixture="agent-panel-empty"
    capture={{ region: "Codex", viewport: "1280x800" }}
  >
    <AgentPanel empty />
  </Frame>,
];
