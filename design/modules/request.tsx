import { Frame, Icon } from "adg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Dialog } from "../components/panel";
import { Input } from "../components/field";
import { SingleChoice } from "../components/single-choice";
import {
  permissionExample, requestCopy, requestExample, questionOptions, routingForms, routingActions,
} from "../fixtures/request";

function PermissionActions({ sheet = false }: { sheet?: boolean } = {}) {
  return (
      <div class="flex justify-end gap-2">
        <Button>{permissionExample.deny}</Button>
        <Button disabled class="opacity-42">
          {permissionExample.bypass}
        </Button>
        <Button variant="primary" class={sheet ? "px-4" : "px-5"}>
          {permissionExample.approve}
        </Button>
      </div>
  );
}

export function PermissionCard({
  title = permissionExample.title,
  scope = permissionExample.scope,
  command = permissionExample.command,
  sheet = false,
}: { title?: string; scope?: string; command?: string; sheet?: boolean } = {}) {
  return (
    <Card padded class="gap-4">
      <div class="flex flex-col gap-1">
        <strong class={`text-body ${sheet ? "leading-[18px]" : "leading-4"} font-semibold`}>
          {title}
        </strong>
        <span class={`text-meta ${sheet ? "leading-4" : "leading-3"} text-text-secondary`}>
          {scope}
        </span>
      </div>
      <pre class="flex h-11 items-center rounded-field bg-surface-sunken px-[14px] text-meta font-mono">
        {command}
      </pre>
      {!sheet && <PermissionActions />}
    </Card>
  );
}

function QuestionActions({ sheet = false }: { sheet?: boolean } = {}) {
  return (
      <div class="flex justify-end gap-2">
        <Button variant="ghost">{requestCopy.skip}</Button>
        <Button variant="primary" disabled class={`opacity-42 ${sheet ? "px-4" : "px-[30px]"}`}>
          {requestCopy.send}
        </Button>
      </div>
  );
}

export function QuestionCard({ sheet = false }: { sheet?: boolean } = {}) {
  return (
    <Card padded class="gap-4">
      <strong class={`text-body ${sheet ? "leading-5" : "leading-[14px]"} font-semibold`}>
        {requestCopy.question}
      </strong>
      <SingleChoice
        value=""
        options={questionOptions}
        label={requestCopy.answer}
        optionCards
        class="[&_button]:text-text"
      />
      <div class="flex flex-col gap-2">
        <label class="text-small leading-4 text-text font-semibold">
          {requestCopy.other}
        </label>
        <Input />
      </div>
      {!sheet && <QuestionActions />}
    </Card>
  );
}

export function RequestSheet({ question = false }: { question?: boolean }) {
  return (
    <Dialog size={question ? "m" : "s"} title={requestCopy.title}
      description={<div class="text-meta leading-[18px]">{requestCopy.status}</div>}
      footer={question ? <QuestionActions sheet /> : <PermissionActions sheet />}>
      {question ? <QuestionCard sheet /> : <PermissionCard sheet />}
    </Dialog>
  );
}

export function InlineRequest({ class: extra = "" }: { class?: string }) {
  return (
    <section class={`flex flex-col gap-4 ${extra}`}>
      <div class="flex flex-col gap-[6px]">
        <h3 class="text-body leading-4 font-semibold">{requestCopy.title}</h3>
        <p class="text-meta leading-4 text-text-tertiary">{requestCopy.status}</p>
      </div>
      <PermissionCard />
    </section>
  );
}

export function RequestEntry({
  title,
  summary,
  action,
}: {
  title: string;
  summary?: string;
  action: string;
}) {
  return (
    <div class={`flex w-full items-center gap-[10px] rounded-card relative isolate before:absolute before:inset-0 before:-z-10
        before:rounded-[inherit] before:bg-warning before:opacity-10 p-4`}>
      <Icon name="shield-alert" size={18} class="self-start text-warning" />
      <div class="flex flex-1 flex-col gap-[10px]">
        <strong class="text-meta leading-4 text-warning">{title}</strong>
        {summary && (
          <span class="text-small leading-[18px] text-text">{summary}</span>
        )}
      </div>
      <Button>{action}</Button>
    </div>
  );
}
export function ReviewUnavailable({
  children,
  action,
}: {
  children?: unknown;
  action?: unknown;
}) {
  return (
    <div
      class="flex w-full items-center justify-between gap-4 rounded-card bg-surface-subtle
        px-4 py-[18px] text-small text-text-secondary"
    >
      <span>{children}</span>
      {action}
    </div>
  );
}

export type Routing = {
  state: "deferred" | "paused" | "routed" | "not-routable";
  deferUntil?: number | null;
  pausedBy?: string | null;
  reason?: string;
};
export function RoutingRow({
  children,
  inline = true,
}: {
  children?: unknown;
  inline?: boolean;
}) {
  return (
    <div
      class={`flex gap-2 text-meta text-text-secondary ${inline ? "items-center" : "flex-col items-start"}`}
    >
      {children}
    </div>
  );
}
export function RequestRouting({
  routing,
  source = "Claude",
  busy = false,
  mode = "all",
  now = 0,
  status,
  resumeLabel,
  handoffLabel,
  inline = false,
}: {
  routing?: Routing;
  source?: string;
  busy?: boolean;
  mode?: "all" | "passive" | "actionable";
  now?: number;
  status?: string;
  resumeLabel?: string;
  handoffLabel?: string;
  inline?: boolean;
}) {
  const actionable =
    routing?.state === "paused" || routing?.state === "deferred";
  if (
    routing &&
    ((mode === "passive" && actionable) ||
      (mode === "actionable" && !actionable))
  )
    return null;
  if (routing) {
    status ??=
      routing.state === "paused"
        ? "Paused"
        : routing.state === "deferred"
          ? `Hand to ${source} in ${Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000))}s`
          : routing.state === "not-routable"
            ? "Will be handled at the source’s next check"
            : `Handed to ${source}`;
    if (actionable) {
      resumeLabel ??= routing.state === "paused" ? "Resume" : "Pause";
      handoffLabel ??= `Hand to ${source} now`;
    }
  }
  if (!status) return null;
  return (
    <div class={!inline && resumeLabel ? "pb-[6px]" : ""}>
      <RoutingRow inline={inline}>
        <span
          class={
            resumeLabel && !inline
              ? "leading-6"
              : resumeLabel
                ? "leading-[34px] mr-[1px]"
                : "leading-7"
          }
        >
          {status}
        </span>
        {resumeLabel && (
          <div class="flex items-center gap-2">
            <Button disabled={busy} variant="ghost" class="px-5">
              {resumeLabel}
            </Button>
            {handoffLabel && (
              <Button disabled={busy} class="px-[18px]">
                {handoffLabel}
              </Button>
            )}
          </div>
        )}
      </RoutingRow>
    </div>
  );
}

export default () => [
  <Frame
    name="request-sheet-permission"
    width={358}
    fixture="approval-permission"
    capture={{
      selector: ".layer-dialog:has(.task-input-sheet)",
      viewport: "390x844",
      clicks: ["打开"],
    }}
    note="Narrow task body (at most 360px) opens an S dialog in the full-width portrait slot, with fixed actions."
  >
    <RequestSheet />
  </Frame>,
  <Frame
    name="request-sheet-question"
    width={358}
    fixture="approval-question"
    capture={{
      selector: ".layer-dialog:has(.task-input-sheet)",
      viewport: "390x844",
      clicks: ["打开"],
    }}
    note="Narrow task body opens an M dialog, capped to the portrait slot width, with fixed actions."
  >
    <RequestSheet question />
  </Frame>,
  <Frame name="request-entry" width={560}>
    <RequestEntry
      title={requestExample.request}
      summary={requestExample.summary}
      action={requestExample.open}
    />
  </Frame>,
  <Frame name="review-unavailable" width={560}>
    <ReviewUnavailable
      action={<Button variant="ghost">{requestExample.retry}</Button>}
    >
      {requestExample.unavailable}
    </ReviewUnavailable>
  </Frame>,
  ...routingForms.map(({ name, status }) => (
    <Frame name={`request-routing-${name}`} width={name === "actionable-inline" ? undefined : 520}>
      <RequestRouting
        status={status}
        inline={name === "actionable-inline"}
        resumeLabel={name === "passive" ? undefined : routingActions.resume}
        handoffLabel={routingActions.handoff}
      />
    </Frame>
  )),
  <Frame name="permission-card" width={312}>
    <div class="w-full bg-surface-raised"><PermissionCard /></div>
  </Frame>,
  <Frame name="question-card" width={312}>
    <div class="w-full bg-surface-raised"><QuestionCard /></div>
  </Frame>,
  <Frame name="inline-request" width={600}>
    <div class="w-full bg-surface-raised"><InlineRequest /></div>
  </Frame>,
  <Frame name="routing-row" width={239}>
    <RoutingRow inline={false}><span class="leading-7">{routingForms[0].status}</span></RoutingRow>
  </Frame>,
];
