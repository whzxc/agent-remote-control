import { Frame, Icon } from "adg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { StatePill } from "./task-presentation";
import { DispatchSpec } from "./model-configuration";
import { PermissionCard, RequestRouting } from "./request";
import {
  timelineTask as task, relayParties, relayCopy, relayTurns, relaySteps, relayPlan, relayReply,
  relayFailure, type RelayKind, type RelayStep,
} from "../fixtures/timeline";
import { taskDispatch } from "../fixtures/task-presentation";

type RelayParty = { name: string; brand: "claude" | "codex" };
const { source, agent } = relayParties;
const edge = "absolute inset-y-0 left-0 w-[3px]";

/** Directional address shared by relay messages, replies, requests and the task header. */
export function RelayRoute({ from = source, to = agent, label, time, tone }: {
  from?: RelayParty; to?: RelayParty; label?: string; time?: string; tone?: "warning" | "danger";
}) {
  return (
    <div class="flex min-w-0 flex-1 items-center gap-[6px] text-meta leading-4 text-text-secondary"
      aria-label={`${from.name} → ${to.name}${label ? ` · ${label}` : ""}`}>
      <BrandMark brand={from.brand} size={14} />
      <strong class="font-semibold text-text">{from.name}</strong>
      <Icon name="arrow-right" size={12} class="text-text-tertiary" />
      <BrandMark brand={to.brand} size={14} />
      <span class="text-text">{to.name}</span>
      {label && <span class={tone === "danger" ? "font-semibold text-danger"
        : tone === "warning" ? "font-semibold text-warning" : ""}>· {label}</span>}
      {time && <span class="ml-auto tabular-nums text-text-tertiary">{time}</span>}
    </div>
  );
}

/** A controller instruction. Left-aligned with a source edge; never a right-aligned human bubble. */
export function RelayMessage({ kind = "followup", text = relayTurns.second.prompt, time = relayTurns.second.time }: {
  kind?: RelayKind; text?: string; time?: string;
}) {
  const local = kind === "local", queued = kind === "queued";
  return (
    <article class={`relative overflow-hidden rounded-card py-3 pl-[18px] pr-4
      ${queued ? "border border-dashed border-border-strong" : "bg-surface-subtle"}`}>
      <span class={`${edge} ${local ? "bg-border-strong" : queued ? "bg-role-source/45" : "bg-role-source"}`} />
      {local ? (
        <div class="flex items-center text-meta leading-4 text-text-secondary">
          {relayCopy.kind.local}<span class="ml-auto tabular-nums text-text-tertiary">{time}</span>
        </div>
      ) : <RelayRoute label={relayCopy.kind[kind]} time={time} />}
      <p class={`mt-2 text-body leading-6 ${queued ? "text-text-secondary" : "text-text"}`}>{text}</p>
    </article>
  );
}

const stepIcon: Record<RelayStep["kind"], [string, string]> = {
  thought: ["brain", "text-phase-thinking"], thinking: ["brain", "text-phase-thinking"], say: ["", ""],
  tools: ["file-search", "text-phase-file"], edit: ["file-pen-line", "text-phase-file"],
  failed: ["circle-x", "text-danger"], live: ["loader-circle", "text-role-agent"],
  request: ["shield-alert", "text-warning"], answered: ["shield-check", "text-success"],
};
const shimmer = "bg-linear-to-r from-text-tertiary via-text to-text-tertiary bg-clip-text text-transparent";

/** One executor row on the work rail: thought, narration, tool, edit, failure, live work or request. */
export function TimelineStep({ step }: { step: RelayStep }) {
  const [icon, paint] = stepIcon[step.kind];
  const live = step.kind === "live" || step.kind === "thinking";
  const disclose = step.kind !== "say" && !live && step.kind !== "request";
  return (
    <li class="relative flex gap-[10px] not-last:after:absolute not-last:after:left-[9px] not-last:after:top-[23px]
      not-last:after:-bottom-[9px] not-last:after:w-[2px] not-last:after:rounded-[1px] not-last:after:bg-role-agent/20">
      <span class={`relative z-1 grid size-5 shrink-0 place-items-center rounded-full ${paint}
        ${step.kind === "say" ? "mt-[2px]" : ""} ${live ? "bg-role-agent/15" : "bg-surface-raised"}`}>
        {step.kind === "say" ? <span class="size-[6px] rounded-full bg-role-agent" /> : <Icon name={icon} size={13} />}
      </span>
      <div class="flex min-w-0 flex-1 flex-col">
        {step.kind === "say" ? (
          <p class="text-body leading-6 text-text">
            {step.label}
            {step.streaming && <span aria-hidden="true"
              class="ml-[2px] inline-block h-[15px] w-[2px] translate-y-[2px] rounded-[1px] bg-role-agent" />}
          </p>
        ) : (
          <div class="flex min-h-5 min-w-0 items-center gap-2 text-small leading-5">
            <span class={`flex min-w-0 flex-1 items-center gap-[6px]
              ${step.kind === "failed" ? "text-danger" : step.kind === "request" ? "text-warning" : "text-text-secondary"}`}>
              {step.kind === "answered" && step.by && <BrandMark brand={source.brand} size={13} />}
              {(step.kind === "thought" || step.kind === "thinking") && (
                <span class="shrink-0">{step.kind === "thought" ? relayCopy.thought : relayCopy.thinking} ·</span>
              )}
              {step.kind === "request" || step.kind === "answered" || step.kind === "edit"
                ? <span class={`shrink-0 ${step.kind === "request" ? "font-semibold" : ""}`}>
                  {step.by ? `${step.by} ${step.label}` : step.label}</span> : null}
              {step.kind === "request" || step.kind === "answered" ? <span class="shrink-0">·</span> : null}
              {step.target ? (
                <code class={`min-w-0 truncate font-mono text-meta ${step.kind === "failed" ? "text-danger"
                  : step.kind === "live" ? `font-semibold ${shimmer}` : "text-text"}`}>{step.target}</code>
              ) : step.kind !== "edit" && step.kind !== "request" && step.kind !== "answered" && (
                <span class={`min-w-0 truncate ${step.kind === "thinking" ? `font-semibold ${shimmer}` : "text-text"}`}>
                  {step.label}
                </span>
              )}
              {step.added !== undefined && <span class="shrink-0 font-mono text-meta text-success">+{step.added}</span>}
              {step.removed !== undefined && <span class="shrink-0 font-mono text-meta text-danger">−{step.removed}</span>}
            </span>
            {step.meta && <span class={`shrink-0 tabular-nums text-meta ${live ? "font-mono text-role-agent"
              : step.kind === "failed" ? "text-danger" : "text-text-tertiary"}`}>{step.meta}</span>}
            {disclose && <Icon name={step.expanded ? "chevron-down" : "chevron-right"} size={12}
              class="shrink-0 text-text-tertiary" />}
          </div>
        )}
        {step.detail && (step.kind !== "thought" || step.expanded) && (
          <div class={`mt-[6px] flex flex-col font-mono text-meta leading-5 ${step.kind === "thought"
            ? "border-l-2 border-phase-thinking/30 pl-3 font-sans text-small text-text-tertiary"
            : step.kind === "failed" ? "rounded-field bg-danger/8 px-3 py-2 text-danger"
            : "rounded-field bg-surface-sunken px-3 py-2 text-text-tertiary"}`}>
            {step.detail.map((line) => <span class="truncate">{line}</span>)}
          </div>
        )}
      </div>
    </li>
  );
}

/** The executor's work stream between a relay message and its reply. */
export function TimelineRail({ steps, status, live = false }: {
  steps: readonly RelayStep[]; status?: string; live?: boolean;
}) {
  return (
    <section class="flex flex-col gap-3" aria-label={`${agent.name} ${status ?? ""}`}>
      {status && (
        <header class="flex items-center gap-[10px]">
          <span class="grid size-5 place-items-center"><BrandMark brand={agent.brand} size={16} /></span>
          <span class="flex items-center gap-[6px] text-meta leading-4 text-text-secondary">
            <strong class="font-semibold text-text">{agent.name}</strong>
            {live && <span class="size-[6px] rounded-full bg-role-agent" />}{status}
          </span>
        </header>
      )}
      <ol class="flex flex-col gap-3">
        {steps.map((step) => <TimelineStep step={step} />)}
      </ol>
    </section>
  );
}

/** Completed or failed work collapses to duration and counts; opening it reveals the rail. */
export function TimelineFold({ failed = false, expanded = false }: { failed?: boolean; expanded?: boolean }) {
  return (
    <button aria-expanded={expanded} class={`flex items-center gap-2 text-meta leading-4
      ${failed ? "text-danger" : "text-text-secondary"}`}>
      <Icon name={failed ? "circle-x" : "circle-check"} size={14} class={failed ? "text-danger" : "text-success"} />
      {failed ? relayCopy.failedFold : relayCopy.worked}
      <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} class="text-text-tertiary" />
    </button>
  );
}

function RelayChanges() {
  return (
    <div class="flex items-center gap-2 text-meta leading-4 text-text-secondary">
      <Icon name="git-compare-arrows" size={14} />
      {relayCopy.changes} ·<code class="font-mono text-text">{relayReply.file}</code>
      <span class="font-mono text-success">+12</span><span class="font-mono text-danger">−3</span>
    </div>
  );
}

/** The executor's final reply, addressed back to the controller. */
export function RelayReply() {
  return (
    <article class="relative overflow-hidden rounded-card border border-border py-3 pl-[18px] pr-3">
      <header class="flex items-center gap-2">
        <RelayRoute from={agent} to={source} label={relayCopy.reply} />
        <IconButton icon="copy" label={relayCopy.copy} compact />
      </header>
      <p class="mt-2 pr-1 text-body leading-6">{relayReply.lead}</p>
      <div class="mt-3 mr-1 overflow-hidden rounded-field bg-surface-subtle">
        <table class="w-full text-small leading-4">
          <tbody>
            {relayReply.results.map((row, i) => (
              <tr class={i === 0 ? "font-semibold" : ""}>
                {row.map((cell) => <td class="w-1/2 px-3 py-[7px]">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul class="mt-3 flex flex-col gap-1 pl-4 text-body leading-6">
        {relayReply.bullets.map((line) => <li class="list-disc">{line}</li>)}
      </ul>
      <footer class="mt-3 mr-1 border-t border-border pt-3"><RelayChanges /></footer>
    </article>
  );
}

/** A request travels back to the controller unless someone answers it here first. */
export function RelayRequest() {
  return (
    <article class="relative flex flex-col gap-3 overflow-hidden rounded-card bg-surface-subtle py-3 pl-[18px] pr-4">
      <span class={`${edge} bg-warning`} />
      <RelayRoute from={agent} to={source} label={relayCopy.request} tone="warning" />
      <PermissionCard />
      <RequestRouting inline status={relayCopy.routing} resumeLabel={relayCopy.pause}
        handoffLabel={relayCopy.handoff} />
    </article>
  );
}

/** Turn failure stays in the turn and keeps the failed command one click away. */
export function RelayFailure() {
  return (
    <article class="relative flex flex-col gap-3 overflow-hidden rounded-card border border-danger/35 py-3 pl-[18px] pr-4">
      <span class={`${edge} bg-danger`} />
      <RelayRoute from={agent} to={source} label={relayCopy.failed} tone="danger" />
      <p class="text-body leading-6">{relayFailure.message}</p>
      <p class="text-small leading-5 text-text-secondary">{relayFailure.retained}</p>
      <RelayChanges />
      <div class="flex gap-2">
        <Button class="px-5">{relayCopy.retry}</Button>
        <Button variant="ghost">{relayCopy.copyLog}</Button>
      </div>
    </article>
  );
}

/** Live plan pinned to the panel footer while a turn runs; it expands upward. */
export function TimelinePlanDock({ expanded = false }: { expanded?: boolean }) {
  const plan = relayPlan;
  return (
    <div class="flex flex-col gap-2 border-t border-border pt-3">
      {expanded && (
        <ol class="flex flex-col gap-[6px] pb-1" aria-label={relayCopy.plan}>
          {plan.items.map((item) => (
            <li class="flex items-center gap-2 text-small leading-5">
              <Icon size={14} name={item.status === "completed" ? "circle-check" : "circle-dot"}
                class={item.status === "completed" ? "text-success" : "text-role-agent"} />
              <span class={item.status === "completed" ? "text-text-secondary" : "font-semibold text-text"}>
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      )}
      <button aria-expanded={expanded} class="flex h-6 w-full items-center gap-3">
        <Icon name="list-checks" size={14} class="text-role-agent" />
        <span class="shrink-0 text-meta tabular-nums text-text-secondary">
          {relayCopy.plan} {plan.completed}/{plan.total}
        </span>
        <span class="min-w-0 flex-1 truncate text-left text-small font-semibold text-text">{plan.current}</span>
        <span role="progressbar" aria-valuenow={plan.completed} aria-valuemax={plan.total}
          class="h-1 w-16 overflow-hidden rounded-full bg-surface-sunken">
          <span class="block h-full rounded-full bg-role-agent" style={{ width: `${(plan.completed / plan.total) * 100}%` }} />
        </span>
        <Icon name={expanded ? "chevron-down" : "chevron-up"} size={14} class="text-text-secondary" />
      </button>
    </div>
  );
}

/** Earlier turns collapse to one row: route, outcome and duration. */
export function TimelineEarlierTurn() {
  return (
    <button aria-expanded="false" class="flex w-full items-center gap-3 rounded-field bg-surface-subtle px-3 py-[10px] text-left">
      <span class="shrink-0 text-meta tabular-nums text-text-tertiary">{relayCopy.turn}</span>
      <span class="flex shrink-0 items-center gap-[3px]" aria-label={`${source.name} → ${agent.name}`}>
        <BrandMark brand={source.brand} size={12} />
        <Icon name="arrow-right" size={10} class="text-text-tertiary" />
        <BrandMark brand={agent.brand} size={12} />
      </span>
      <span class="min-w-0 flex-1 truncate text-small text-text">{relayTurns.first.result}</span>
      <Icon name="circle-check" size={14} class="shrink-0 text-success" />
      <span class="shrink-0 text-meta tabular-nums text-text-tertiary">{relayCopy.turnTime}</span>
      <Icon name="chevron-right" size={14} class="shrink-0 text-text-secondary" />
    </button>
  );
}

const s = relaySteps;
/** Task detail: relay header, flat work rail and directional messages. */
export function RelayTimeline({ state }: { state: "running" | "waiting" | "done" | "failed" }) {
  const failed = state === "failed", done = state === "done", waiting = state === "waiting";
  const bars = failed ? ["bg-danger"] : ["bg-success", done ? "bg-success" : waiting ? "bg-warning" : "bg-accent-text"];
  return (
    <PanelShell viewportHeight={1100} class="overflow-hidden px-6 pb-5 pt-[13px]">
      <header class="flex h-[34px] shrink-0 items-center gap-2">
        <Icon name="arrow-left" size={16} />
        <RelayRoute label={agent.workspace} />
        <IconButton icon="maximize-2" label="Expand" />
      </header>
      <h2 class="mt-[10px] shrink-0 truncate text-title leading-6 font-[650]">{task.title}</h2>
      <div class="mt-[14px] flex shrink-0 items-center gap-2">
        <StatePill class="pr-[6px]" state={state}>{relayCopy.state[state]}</StatePill>
        <DispatchSpec {...taskDispatch} />
        <span class="text-meta text-text-tertiary">{relayCopy.duration[state]}</span>
      </div>
      <div class="mt-3 flex shrink-0 gap-1">
        {bars.map((paint) => <span class={`h-[3px] flex-1 rounded-[2px] ${paint}`} />)}
      </div>
      <div class="mt-5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {!failed && <TimelineEarlierTurn />}
        <RelayMessage kind={failed ? "dispatch" : "followup"} text={failed ? relayTurns.second.prompt : undefined} />
        {state === "running" && (
          <TimelineRail live status={`${relayCopy.working} · 1 分 12 秒`}
            steps={[s.thought, s.say, s.tools, s.edit, s.failed, s.recover, s.live]} />
        )}
        {waiting && (
          <>
            <TimelineRail status={`${relayCopy.state.waiting} · 1 分 43 秒`}
              steps={[s.thought, s.say, s.tools, s.edit, s.request]} />
            <RelayRequest />
          </>
        )}
        {done && (<><TimelineFold /><RelayReply /></>)}
        {failed && (
          <>
            <TimelineFold failed expanded />
            <TimelineRail steps={[s.thought, s.tools, s.edit, { ...s.stopped }]} />
            <RelayFailure />
          </>
        )}
      </div>
      {(state === "running" || waiting) && <div class="mt-4 shrink-0"><TimelinePlanDock /></div>}
    </PanelShell>
  );
}

export default () => [
  <Frame name="relay-route" width={420}><RelayRoute label={relayCopy.kind.dispatch} time="13:58" /></Frame>,
  ...(["dispatch", "followup", "queued", "local"] as const).map((kind) => (
    <Frame name={`relay-message-${kind}`} width={512}>
      <div class="w-full bg-surface-raised">
        <RelayMessage kind={kind} text={kind === "queued" ? relayTurns.queued.prompt : undefined}
          time={kind === "queued" ? relayTurns.queued.time : undefined} />
      </div>
    </Frame>
  )),
  ...([
    ["thought", s.thought], ["thought-expanded", { ...s.thought, expanded: true }], ["thinking", s.thinking],
    ["say", s.say], ["say-streaming", s.streaming], ["tools", s.tools], ["edit", s.edit], ["failed", s.failed],
    ["live", s.live], ["request", s.request], ["answered", s.answered], ["answered-unknown", s.answeredUnknown],
  ] as const).map(([name, step]) => (
    <Frame name={`timeline-step-${name}`} width={512}>
      <ol class="w-full bg-surface-raised"><TimelineStep step={step} /></ol>
    </Frame>
  )),
  <Frame name="timeline-rail" width={512}>
    <div class="w-full bg-surface-raised">
      <TimelineRail live status={`${relayCopy.working} · 1 分 12 秒`} steps={[s.thought, s.say, s.tools, s.edit, s.live]} />
    </div>
  </Frame>,
  <Frame name="timeline-fold" width={512}><div class="w-full bg-surface-raised"><TimelineFold /></div></Frame>,
  <Frame name="timeline-fold-failed" width={512}>
    <div class="w-full bg-surface-raised"><TimelineFold failed expanded /></div>
  </Frame>,
  <Frame name="relay-reply" width={512}><div class="w-full bg-surface-raised"><RelayReply /></div></Frame>,
  <Frame name="relay-request" width={512}><div class="w-full bg-surface-raised"><RelayRequest /></div></Frame>,
  <Frame name="relay-failure" width={512}><div class="w-full bg-surface-raised"><RelayFailure /></div></Frame>,
  <Frame name="timeline-plan-dock" width={512}><div class="w-full bg-surface-raised"><TimelinePlanDock /></div></Frame>,
  <Frame name="timeline-plan-dock-expanded" width={512}>
    <div class="w-full bg-surface-raised"><TimelinePlanDock expanded /></div>
  </Frame>,
  <Frame name="timeline-earlier-turn" width={512}>
    <div class="w-full bg-surface-raised"><TimelineEarlierTurn /></div>
  </Frame>,
];
