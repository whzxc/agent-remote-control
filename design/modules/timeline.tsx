import { Frame, Icon } from "adg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { StatePill, TaskMessage } from "./task-presentation";
import { DispatchSpec } from "./model-configuration";
import { InlineRequest } from "./request";
import SourceArt from "../art/source.svg";
import { timelineTask as task, timelineCopy } from "../fixtures/timeline";
import { taskDispatch } from "../fixtures/task-presentation";

export function TimelineChanges() {
  return (
    <div class="text-meta leading-4 font-semibold text-text-secondary">
      {timelineCopy.changes}<span class="font-normal text-text">{timelineCopy.filename}</span>
    </div>
  );
}
export function TimelineProcessButton({ failed = false }: { failed?: boolean }) {
  return (
    <Button>
      <span class="text-meta font-normal text-text-secondary">
        {timelineCopy.process}{failed ? timelineCopy.failedOperations : ""}
      </span>
      <Icon
        name={failed ? "chevron-down" : "chevron-right"}
        class="ml-2 text-text-secondary"
      />
    </Button>
  );
}
export function TimelinePrompt() {
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
export function TimelineProcess({
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
          {timelineCopy.commandCount}
          <Icon name="chevron-right" size={12} />
        </span>
        <span class="flex items-center gap-3">
          {timelineCopy.fileTools}
          <Icon name="chevron-right" size={12} />
        </span>
      </div>
      <div class="mt-6 flex items-center gap-2 leading-4">
        <Icon
          name={failed ? "check" : "circle"}
          class={failed ? "text-success" : "text-accent-text"}
        />
        <span class="text-meta text-text-secondary">{timelineCopy.plan}</span>
        <span
          class={
            failed
              ? "text-small text-text-secondary"
              : "text-small font-semibold text-accent-text"
          }
        >
          {timelineCopy.planTitle}
        </span>
      </div>
      {running && (
        <div class="mt-[23px] flex items-center gap-2 text-meta leading-4">
          <Icon name="terminal" class="text-phase-command" />
          <code class="font-mono">{timelineCopy.command}</code>
          <Icon name="chevron-right" class="ml-1 text-text-secondary" />
          <span class="ml-7 text-text-secondary">{timelineCopy.commandRunning}</span>
          <Icon name="chevron-down" class="ml-2 text-text-secondary" />
        </div>
      )}
    </div>
  );
}
export function TimelineTurn({ expanded = false }: { expanded?: boolean }) {
  return (
    <article
      class={`flex flex-col gap-4 rounded-card bg-surface-subtle px-4 ${expanded ? "py-4" : "py-[14px]"}`}
    >
      {expanded ? (
        <>
          <div class="flex items-center gap-4">
            <span class="text-meta leading-4 text-text-secondary">
              {timelineCopy.turn}
            </span>
            <TimelineProcessButton />
            <span class="ml-auto">
              <Icon name="chevron-down" class="text-text-secondary" />
            </span>
          </div>
          <TimelinePrompt />
          <section class="flex flex-col rounded-card bg-surface px-4 pt-4 pb-[14px]">
            <header class="flex h-4 items-center gap-2">
              <Icon name="check" size={16} class="text-success" />
              <strong class="text-meta leading-4 text-success">{timelineCopy.finalReply}</strong>
              <span class="ml-auto">
                <Icon name="copy" />
              </span>
            </header>
            <p class="mt-[18px] text-body leading-4">
              {timelineCopy.completed}
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
              <TimelineChanges />
            </div>
          </section>
        </>
      ) : (
        <div class="flex items-center justify-between">
          <div class="flex flex-col gap-2">
            <span class="text-meta leading-4 text-text-secondary">
              {timelineCopy.turn}
            </span>
            <p class="text-small leading-4">
              {timelineCopy.completed}
            </p>
          </div>
          <Icon name="chevron-right" class="text-text-secondary" />
        </div>
      )}
    </article>
  );
}
export function TaskTimeline({ form }: { form: string }) {
  const failed = form === "failed-turn",
    waiting = form === "needs-you";
  return (
    <PanelShell size="m" viewportHeight={1100} class="overflow-hidden p-6 pt-[13px]">
      <header class="flex h-[34px] items-center gap-2">
        <Icon name="arrow-left" size={16} />
        <span class="flex flex-1 items-center gap-1 text-meta font-semibold">{timelineCopy.agent.split(" · ").map((part, index) => <span>{index ? `· ${part}` : part}</span>)}</span>
        <IconButton icon="maximize-2" label="Expand" />
      </header>
      <h2 class="mt-[10px] truncate text-title leading-6 font-[650]">
        {failed ? timelineCopy.failedTitle : task.title}
      </h2>
      <div class="mt-[14px] flex items-center gap-2">
        <StatePill
          class="pr-[6px]"
          state={failed ? "failed" : waiting ? "waiting" : "running"}
        >
          {failed ? timelineCopy.state.failed : waiting ? timelineCopy.state.waiting : timelineCopy.state.running}
        </StatePill>
        <DispatchSpec {...taskDispatch} />
        <span class="flex h-5 items-center gap-1 rounded-field bg-surface-sunken px-2 text-caption text-text-secondary">
          <SourceArt
            data-brand
            width={12}
            height={12}
            class="text-role-source"
          />
          {timelineCopy.source}
        </span>
        <span class="text-meta text-text-tertiary">
          {failed ? timelineCopy.duration.failed : timelineCopy.duration.current}
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
            <TimelinePrompt />
            <div>
              <TimelineProcessButton failed />
            </div>
            <div class="mt-[10px]">
              <TimelineProcess failed />
            </div>
            <section class="mt-1 flex flex-col gap-[10px] rounded-card bg-surface p-4">
              <header class="flex items-center gap-3">
                <Icon name="circle-alert" class="text-danger" />
                <strong class="text-small leading-4 text-danger">
                  {timelineCopy.failure}
                </strong>
                <span class="ml-4 flex items-center gap-2 text-meta text-danger">
                  {timelineCopy.commandCount}
                  <Icon name="chevron-right" size={14} />
                </span>
              </header>
              <p class="text-body leading-4">
                {timelineCopy.failureMessage}
              </p>
              <p class="text-body leading-4">
                {timelineCopy.retained}
              </p>
              <TimelineChanges />
              <div class="mt-[6px] flex gap-2">
                <Button class="px-5">{timelineCopy.retry}</Button>
                <Button variant="ghost">{timelineCopy.copyLog}</Button>
              </div>
            </section>
          </article>
        ) : (
          <>
            <TimelineTurn expanded={!waiting} />
            <article
              class={`flex flex-col gap-[26px] rounded-card bg-surface-subtle p-4 ${waiting ? "pb-4" : "pb-[25px]"}`}
            >
              <div class="ml-auto w-[370px]">
                <TaskMessage text={task.followup} />
              </div>
              <TimelineProcess running={!waiting} />
            </article>
          </>
        )}
      </div>
      {waiting && (
        <InlineRequest class="mt-8" />
      )}
    </PanelShell>
  );
}

export default () => [
  <Frame name="timeline-changes" width={536}>
    <div class="w-full bg-surface"><TimelineChanges /></div>
  </Frame>,
  <Frame name="timeline-process-button-failed" width={256}>
    <div class="flex w-full bg-surface-subtle"><TimelineProcessButton failed /></div>
  </Frame>,
  <Frame name="timeline-prompt" width={420}>
    <div class="w-full bg-surface-subtle"><TimelinePrompt /></div>
  </Frame>,
  <Frame name="timeline-process" width={568}>
    <div class="w-full bg-surface-subtle"><TimelineProcess /></div>
  </Frame>,
  <Frame name="timeline-process-running" width={568}>
    <div class="w-full bg-surface-subtle"><TimelineProcess running /></div>
  </Frame>,
  <Frame name="timeline-process-failed" width={568}>
    <div class="w-full bg-surface-subtle"><TimelineProcess failed /></div>
  </Frame>,
  <Frame name="timeline-turn-collapsed" width={600}>
    <div class="w-full bg-surface-raised"><TimelineTurn /></div>
  </Frame>,
  <Frame name="timeline-turn-expanded" width={600}>
    <div class="w-full bg-surface-raised"><TimelineTurn expanded /></div>
  </Frame>,
];
