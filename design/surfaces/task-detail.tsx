import { Frame, Icon } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { StatePill } from "../components/state-pill";
import { DispatchSpec } from "../modules/model-configuration";
import { TaskMessage } from "../components/task-message";
import { PermissionCard } from "../components/card";
import SourceArt from "../art/source.svg";
import { Tile } from "../components/tile";
const task = {
  title: "Review project configuration and verify the requested changes",
  prompt: [
    "Review the project and check the configuration.",
    "Keep the existing behavior while making the requested changes.",
  ],
  followup: "Apply the changes and run the project checks.",
  progress: [
    "The project configuration is ready. I am applying the change next.",
    "The existing check command covers the changed TypeScript files.",
  ],
  results: [
    ["Check", "Result"],
    ["Configuration", "Updated"],
    ["TypeScript", "Passed"],
  ],
  bullets: ["Preserved existing behavior.", "Verified the changed files."],
};
const forms = [
  { name: "running-multi-turn", fixture: "timeline-multi-turn" },
  { name: "needs-you", fixture: "timeline-pending" },
  { name: "failed-turn", fixture: "task-detail-failed" },
];
function Changes() {
  return (
    <div class="text-meta leading-4 font-semibold text-text-secondary">
      1 个文件有改动 · <span class="font-normal text-text">config.json</span>
    </div>
  );
}
function ProcessButton({ failed = false }: { failed?: boolean }) {
  return (
    <Button>
      <span class="text-meta font-normal text-text-secondary">
        过程 · 1 条进展 · 0 次答复{failed ? " · 4 项操作" : ""}
      </span>
      <Icon
        name={failed ? "chevron-down" : "chevron-right"}
        class="ml-2 text-text-secondary"
      />
    </Button>
  );
}
function PromptMessage() {
  return (
    <div class="ml-auto w-[420px]">
      <TaskMessage class="pr-1">
        <span class="flex flex-col gap-[6px]">
          {task.prompt.map((line) => (
            <span>{line}</span>
          ))}
        </span>
      </TaskMessage>
    </div>
  );
}
function Process({
  failed = false,
  running = false,
}: {
  failed?: boolean;
  running?: boolean;
}) {
  return (
    <div class="flex flex-col">
      <div class="flex items-start gap-3">
        <span class="grid size-8 shrink-0 place-items-center rounded-tile bg-phase-thinking/17">
          <BrandMark brand="codex" size={20} />
        </span>
        <div class="flex flex-1 flex-col gap-[6px]">
          {(failed ? task.progress.slice(0, 1) : task.progress).map(
            (line, i) => (
              <p
                class={
                  i === 0
                    ? "text-body leading-4"
                    : "text-small leading-4 text-text-tertiary"
                }
              >
                {line}
              </p>
            ),
          )}
        </div>
      </div>
      <div
        class={`${failed ? "mt-[6px]" : "mt-[19px]"} ml-11 flex items-center gap-7 text-meta leading-4 text-text-secondary`}
      >
        <span class="flex items-center gap-3">
          1 条命令
          <Icon name="chevron-right" size={12} />
        </span>
        <span class="flex items-center gap-3">
          修改 1 个文件 · 1 项工具调用
          <Icon name="chevron-right" size={12} />
        </span>
      </div>
      <div class="mt-6 flex items-center gap-2 leading-4">
        <Icon
          name={failed ? "check" : "circle"}
          class={failed ? "text-success" : "text-accent-text"}
        />
        <span class="text-meta text-text-secondary">计划 · </span>
        <span
          class={
            failed
              ? "text-small text-text-secondary"
              : "text-small font-semibold text-accent-text"
          }
        >
          Verify project changes
        </span>
      </div>
      {running && (
        <div class="mt-[23px] flex items-center gap-2 text-meta leading-4">
          <Icon name="terminal" class="text-phase-command" />
          <code class="font-mono">npm run check</code>
          <Icon name="chevron-right" class="ml-1 text-text-secondary" />
          <span class="ml-7 text-text-secondary">1 条命令运行中</span>
          <Icon name="chevron-down" class="ml-2 text-text-secondary" />
        </div>
      )}
    </div>
  );
}
function FirstTurn({ expanded = false }: { expanded?: boolean }) {
  return (
    <article
      class={`flex flex-col gap-4 rounded-card bg-surface-subtle px-4 ${expanded ? "py-4" : "py-[14px]"}`}
    >
      {expanded ? (
        <>
          <div class="flex items-center gap-4">
            <span class="text-meta leading-4 text-text-secondary">
              第 1 轮 · 4 项操作 · 37 秒
            </span>
            <ProcessButton />
            <span class="ml-auto">
              <Icon name="chevron-down" class="text-text-secondary" />
            </span>
          </div>
          <PromptMessage />
          <section class="flex flex-col rounded-card bg-surface px-4 pt-4 pb-[14px]">
            <header class="flex h-4 items-center gap-2">
              <Icon name="check" size={16} class="text-success" />
              <strong class="text-meta leading-4 text-success">最终回复</strong>
              <span class="ml-auto">
                <Icon name="copy" />
              </span>
            </header>
            <p class="mt-[18px] text-body leading-4">
              The requested changes are complete.
            </p>
            <div class="mt-[14px] overflow-hidden rounded-field bg-surface-subtle">
              <table class="w-full text-small leading-4">
                <tbody>
                  {task.results.map((row, i) => (
                    <tr class={i === 0 ? "font-semibold" : ""}>
                      {row.map((cell) => (
                        <td
                          class={`w-1/2 px-3 ${i === 0 ? "py-[6px]" : "py-[7px]"}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="mt-[14px] flex flex-col gap-[6px] text-body leading-4">
              {task.bullets.map((line) => (
                <p>•&nbsp; {line}</p>
              ))}
            </div>
            <div class="mt-[10px]">
              <Changes />
            </div>
          </section>
        </>
      ) : (
        <div class="flex items-center justify-between">
          <div class="flex flex-col gap-2">
            <span class="text-meta leading-4 text-text-secondary">
              第 1 轮 · 4 项操作 · 37 秒
            </span>
            <p class="text-small leading-4">
              The requested changes are complete.
            </p>
          </div>
          <Icon name="chevron-right" class="text-text-secondary" />
        </div>
      )}
    </article>
  );
}
function TaskDetail({ form }: { form: string }) {
  const failed = form === "failed-turn",
    waiting = form === "needs-you";
  return (
    <PanelShell width={640} class="p-5 pt-[14px]">
      <header class="flex h-[34px] items-center gap-2">
        <Icon name="arrow-left" size={16} />
        <span class="w-0" />
        <span class="flex-1 text-small font-semibold">Codex · acceptance</span>
        <IconButton icon="maximize-2" label="Expand" />
      </header>
      <h2 class="mt-[10px] text-title leading-6 font-[650]">
        {failed ? "Failed task" : task.title}
      </h2>
      <div class="mt-[14px] flex items-center gap-2">
        <StatePill
          class="pr-[6px]"
          state={failed ? "failed" : waiting ? "waiting" : "running"}
        >
          {failed ? "失败" : waiting ? "等待输入" : "运行中"}
        </StatePill>
        <DispatchSpec
          model="GPT-6.1 Sol"
          effort="高推理强度"
          position={{ count: 4, index: 2 }}
          fast
          tier="快速"
        />
        <span class="flex h-5 items-center gap-1 rounded-field bg-surface-sunken px-2 text-caption text-text-secondary">
          <SourceArt
            data-brand
            width={12}
            height={12}
            class="text-role-source"
          />
          来自 Claude
        </span>
        <span class="text-meta text-text-tertiary">
          {failed ? "37 秒" : "22 分 31 秒"}
        </span>
      </div>
      <div class="mt-3 flex gap-1">
        {(failed
          ? ["bg-danger"]
          : ["bg-success", waiting ? "bg-warning" : "bg-accent-text"]
        ).map((paint) => (
          <span class={`h-[3px] flex-1 rounded-[2px] ${paint}`} />
        ))}
      </div>
      <div class="mt-[19px] flex flex-col gap-4">
        {failed ? (
          <article class="flex flex-col gap-4 rounded-card bg-surface-subtle p-4">
            <PromptMessage />
            <div>
              <ProcessButton failed />
            </div>
            <div class="mt-[10px]">
              <Process failed />
            </div>
            <section class="mt-1 flex flex-col gap-[10px] rounded-card bg-surface p-4">
              <header class="flex items-center gap-3">
                <Icon name="circle-alert" class="text-danger" />
                <strong class="text-small leading-4 text-danger">
                  本轮失败
                </strong>
                <span class="ml-4 flex items-center gap-2 text-meta text-danger">
                  1 条命令
                  <Icon name="chevron-right" size={14} />
                </span>
              </header>
              <p class="text-body leading-4">
                The sample verification command failed.
              </p>
              <p class="text-body leading-4">
                已记录的改动保留在磁盘上，ARC 未执行回退。
              </p>
              <Changes />
              <div class="mt-[6px] flex gap-2">
                <Button class="px-5">重试本轮</Button>
                <Button variant="ghost">复制日志</Button>
              </div>
            </section>
          </article>
        ) : (
          <>
            <FirstTurn expanded={!waiting} />
            <article
              class={`flex flex-col gap-[26px] rounded-card bg-surface-subtle p-4 ${waiting ? "pb-4" : "pb-[25px]"}`}
            >
              <div class="ml-auto w-[370px]">
                <TaskMessage text={task.followup} />
              </div>
              <Process running={!waiting} />
            </article>
          </>
        )}
      </div>
      {waiting && (
        <section class="mt-8 flex flex-col gap-4">
          <div class="flex flex-col gap-[6px]">
            <h3 class="text-body leading-4 font-semibold">待处理请求</h3>
            <p class="text-meta leading-4 text-text-tertiary">
              将在控制源下次检查时处理
            </p>
          </div>
          <PermissionCard />
        </section>
      )}
    </PanelShell>
  );
}
export default () =>
  forms.map(({ name, fixture }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{
        selector: ".dialog:has(.task-detail-layer)",
        viewport: "1280x1100",
      }}
      note="The implementation shell follows topology panel geometry; its width is not fixed to the drawing's 640px. failed-turn uses task preparation in the adapter."
    >
      <TaskDetail form={name} />
    </Frame>
  ));
