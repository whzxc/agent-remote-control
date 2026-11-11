import { Frame, Icon } from "sdg";
import { PanelLoading, PanelShell } from "../components/panel";
import { AgentIcon } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaCards } from "../modules/quota";
import { TaskBubble } from "../modules/task-presentation";
import { Tile } from "../components/tile";
import { AgentTaskHistory } from "../modules/agent-activity";
import { TopologyScreen } from "../modules/homepage-topology";
import { active, agentHistory, agentHistoryLoading, agentTaskMeta, shortAgentHistory } from "../fixtures/agent-activity";
import { centeredAgentPanelScenes } from "../fixtures/agent-panel-topology";
import { taskDispatch } from "../fixtures/task-presentation";
import { agentQuotas as quotas } from "../fixtures/quota";
function AgentPanel({ history = "long", width = 420, portrait = false }: {
  history?: "long" | "short" | "empty" | "loading";
  width?: number;
  portrait?: boolean;
}) {
  const tasks = history === "long" ? active : [];
  return (
    <PanelShell width={width} class="max-h-[768px] overflow-hidden pt-4">
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
          {(portrait ? ["refresh-cw", "settings"] : ["refresh-cw", "settings", "maximize-2"]).map((icon) => (
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
          <PanelLoading label={agentHistoryLoading} />
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
  <Frame name="short" fixture="agent-panel-short" capture={{ region: "Codex", viewport: "1280x800" }}>
    <AgentPanel history="short" />
  </Frame>,
  <Frame name="loading" fixture="agent-panel-loading" capture={{ region: "Codex", viewport: "1280x800" }}>
    <AgentPanel history="loading" />
  </Frame>,
  <Frame name="centered-landscape" width={1280} height={800} fixture="agent-panel-short"
    capture={{ page: true, origin: "0 0", viewport: "1280x800" }}>
    <TopologyScreen width={1280} height={800} scene={centeredAgentPanelScenes.landscape}>
      <div class="absolute inset-4 flex items-center justify-end"><AgentPanel history="short" /></div>
    </TopologyScreen>
  </Frame>,
  <Frame name="centered-portrait" width={640} height={800} fixture="agent-panel-short"
    capture={{ page: true, origin: "0 0", viewport: "640x800" }}>
    <TopologyScreen width={640} height={800} scene={centeredAgentPanelScenes.portrait} hideNodeLabels>
      <div class="absolute top-4 bottom-24 left-4 flex items-center"><AgentPanel history="short" width={515} portrait /></div>
    </TopologyScreen>
  </Frame>,
];
