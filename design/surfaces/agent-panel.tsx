import { Frame, Icon } from "sdg";
import { PanelShell } from "../components/panel";
import { AgentIcon } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaSummary } from "../modules/quota";
import { TaskBubble } from "../modules/task-presentation";
import { Tile } from "../components/tile";
import { AgentTaskHistory } from "../modules/agent-activity";
import { active, agentHistory, agentTaskMeta } from "../fixtures/agent-activity";
import { taskDispatch } from "../fixtures/task-presentation";
import { agentQuotas as quotas } from "../fixtures/quota";
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
                project={agentTaskMeta.project}
                date={agentTaskMeta.date}
                dispatch={taskDispatch}
              />
            </section>
          ))}
          <AgentTaskHistory groups={agentHistory} />
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
