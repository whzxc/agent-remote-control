import { Frame, Icon } from "adg";
import { PanelLoading, PanelShell } from "../components/panel";
import { AgentIcon } from '../modules/homepage-scene';
import { IconButton } from "../components/icon-button";
import { QuotaCards } from '../components/quota';
import { TaskCard } from '../components/task-card';
import { origins } from "../fixtures/tasks";
import { Tile } from "../components/tile";
import { AgentTaskHistory, AgentSectionHeading } from "../modules/agent-activity";
import { active, agentHistory, agentHistoryLoading, agentTaskMeta, shortAgentHistory } from "../fixtures/agent-activity";
import { taskDispatch } from "../fixtures/task-presentation";
import { agentQuotas as quotas } from "../fixtures/quota";
function AgentPanel({ history = "long", portrait = false }: {
  history?: "long" | "short" | "empty" | "loading";
  portrait?: boolean;
}) {
  const tasks = history === "long" ? active : [];
  return (
    <PanelShell viewportHeight={800} viewportWidth={portrait ? 640 : 1280} className="gap-[25px] overflow-hidden pt-[13px] px-6 pb-6">
      <header className="flex shrink-0 items-center gap-3">
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
        <div className="flex flex-1 flex-col gap-1">
          <h2 className="text-title leading-6 font-[650] flex items-center gap-2">
            Codex
            <Icon name="arrow-up-right" size={16} />
          </h2>
          <p className="text-meta leading-4 text-text-secondary">
            fixture · {tasks.length} 个任务进行中
          </p>
        </div>
        <div className="flex items-center gap-1">
          {["refresh-cw", "settings", "maximize-2"].map((icon) => (
            <IconButton icon={icon} label={icon} />
          ))}
        </div>
      </header>
      <div className="min-h-0 overflow-y-auto">
        <div><QuotaCards windows={quotas} /></div>
        {history === "empty" ? (
          <div className="mt-12 flex flex-col items-center gap-[10px] text-text-tertiary">
            <Tile icon="messages-square" tone="neutral" />
            <p className="text-small leading-4">暂无未归档对话。</p>
          </div>
        ) : history === "loading" ? (
          <div className="mt-4"><PanelLoading label={agentHistoryLoading} /></div>
        ) : (
          <div className="mt-6 flex flex-col gap-7">
            {tasks.map(({ heading, ...task }) => (
              <section className="flex flex-col gap-2">
                <AgentSectionHeading label={heading} attention={task.tone === "warning"} />
                <TaskCard form="detail" task={{
                  id: task.title, node: 'codex', title: task.title, group: task.tone === 'warning' ? 'needs-me' : 'running',
                  state: task.phase, detail: task.headline, icon: task.icon, origin: origins.local,
                  project: { name: agentTaskMeta.project }, dispatch: taskDispatch, turns: 2,
                  elapsed: 'duration' in task ? task.duration : undefined,
                  activity: task.tone === 'warning' ? undefined : task.headline,
                }} />
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
  <Frame name="centered-portrait" fixture="agent-panel-short"
    capture={{ region: "Codex", viewport: "640x800" }}>
    <AgentPanel history="short" portrait />
  </Frame>,
];
