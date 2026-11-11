import { Frame, Icon } from "sdg";
import { PanelShell } from "../components/panel";
import { AgentIcon } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaCards } from "../modules/quota";
import { TaskBubble } from "../modules/task-presentation";
import { Tile } from "../components/tile";
import { AgentTaskHistory } from "../modules/agent-activity";
import { active, agentHistory, agentHistoryLoading, agentTaskMeta, shortAgentHistory } from "../fixtures/agent-activity";
import { taskDispatch } from "../fixtures/task-presentation";
import { agentQuotas as quotas } from "../fixtures/quota";
function AgentPanel({ history = "long" }: { history?: "long" | "short" | "empty" | "loading" }) {
  const tasks = history === "long" ? active : [];
  return (
    <PanelShell width={420} class="max-h-[768px] overflow-hidden pt-4">
      <header class="mx-5 flex shrink-0 items-center gap-3">
        <AgentIcon
          brand="codex"
          size={44}
          readings={quotas.map((q, i) => ({
            id: String(i),
            label: q.label,
            value: q.value,
            color: `var(--${q.tone})`,
            elapsed: q.elapsed,
          }))}
        />
        <div class="flex flex-1 flex-col gap-1">
          <h2 class="text-title leading-6 font-[650] flex items-center gap-2">
            Codex
            <Icon name="arrow-up-right" size={16} />
          </h2>
          <p class="text-meta leading-4 text-text-secondary">
            fixture · {tasks.length} 个任务进行中
          </p>
        </div>
        <div class="flex items-center gap-1">
          {["refresh-cw", "settings", "maximize-2"].map((icon) => (
            <IconButton icon={icon} label={icon} />
          ))}
        </div>
      </header>
      <div class={`min-h-0 overflow-y-auto px-5 ${history === "empty" ? "pb-8" : "pb-3"}`}>
        <div class="mt-5"><QuotaCards windows={quotas} /></div>
        {history === "empty" ? (
          <div class="mt-12 flex flex-col items-center gap-[10px] text-text-tertiary">
            <Tile icon="messages-square" tone="neutral" />
            <p class="text-small leading-4">暂无未归档对话。</p>
          </div>
        ) : history === "loading" ? (
          <div class="flex items-center justify-center gap-2 p-6 text-text-secondary" role="status">
            <Icon name="loader-circle" size={16} />
            {agentHistoryLoading}
          </div>
        ) : (
          <div class="mt-6 flex flex-col gap-7">
            {tasks.map(({ heading, ...task }) => (
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
            <AgentTaskHistory groups={history === "short" ? shortAgentHistory : agentHistory} />
          </div>
        )}
      </div>
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="overview"
    fixture="agent-panel"
    capture={{ region: "Codex", viewport: "1280x800" }}
    note="The header stays visible while the body scrolls within the 800px viewport."
  >
    <AgentPanel />
  </Frame>,
  <Frame
    name="empty"
    fixture="agent-panel-empty"
    capture={{ region: "Codex", viewport: "1280x800" }}
  >
    <AgentPanel history="empty" />
  </Frame>,
  <Frame name="short" note="The current runtime fills the available height when history contains a conversation.">
    <AgentPanel history="short" />
  </Frame>,
  <Frame name="loading" note="The current runtime does not fit the panel to available content while waiting for history.">
    <AgentPanel history="loading" />
  </Frame>,
];
