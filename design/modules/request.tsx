import type { ReactNode } from "react";
import { PermissionActions, PermissionCard, RoutingRow, RequestRouting } from '../components/request';
import { Frame, Icon } from "adg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Dialog } from "../components/panel";
import { Input } from "../components/field";
import { SingleChoice } from "../components/single-choice";
import { permissionExample, requestCopy, requestExample, questionOptions, routingForms, routingActions } from '../fixtures/request';

function QuestionActions({ sheet = false }: { sheet?: boolean } = {}) {
  return (
      <div className="flex justify-end gap-2">
        <Button variant="ghost">{requestCopy.skip}</Button>
        <Button variant="primary" disabled className={`opacity-42 ${sheet ? "px-4" : "px-[30px]"}`}>
          {requestCopy.send}
        </Button>
      </div>
  );
}

export function QuestionCard({ sheet = false }: { sheet?: boolean } = {}) {
  return (
    <Card padded className="gap-4">
      <strong className={`text-body ${sheet ? "leading-5" : "leading-[14px]"} font-semibold`}>
        {requestCopy.question}
      </strong>
      <SingleChoice
        value=""
        options={questionOptions}
        label={requestCopy.answer}
        optionCards
        className="[&_button]:text-text"
      />
      <div className="flex flex-col gap-2">
        <label className="text-small leading-4 text-text font-semibold">
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
    <Dialog viewportWidth={390} viewportHeight={844} title={requestCopy.title}
      description={<div className="text-meta leading-[18px]">{requestCopy.status}</div>}
      footer={question ? <QuestionActions sheet /> : <PermissionActions sheet />}>
      {question ? <QuestionCard sheet /> : <PermissionCard sheet />}
    </Dialog>
  );
}

export function InlineRequest({ className: extra = "" }: { className?: string }) {
  return (
    <section className={`flex flex-col gap-4 ${extra}`}>
      <div className="flex flex-col gap-[6px]">
        <h3 className="text-body leading-5 font-semibold">{requestCopy.title}</h3>
        <p className="text-meta leading-4 text-text-tertiary">{requestCopy.status}</p>
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
    <div className={`flex w-full items-center gap-[10px] rounded-card relative isolate before:absolute before:inset-0 before:-z-10
        before:rounded-[inherit] before:bg-warning before:opacity-10 p-4`}>
      <Icon name="shield-alert" size={18} className="self-start text-warning" />
      <div className="flex flex-1 flex-col gap-[10px]">
        <strong className="text-meta leading-4 text-warning">{title}</strong>
        {summary && (
          <span className="text-small leading-[18px] text-text">{summary}</span>
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
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex w-full items-center justify-between gap-4 rounded-card bg-surface-subtle
        px-4 py-[18px] text-small text-text-secondary"
    >
      <span>{children}</span>
      {action}
    </div>
  );
}

export default () => [
  <Frame
    name="request-sheet-permission"
    width={390}
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
    width={390}
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
  <Frame name="question-card" width={312}>
    <div className="w-full bg-surface-raised"><QuestionCard /></div>
  </Frame>,
  <Frame name="inline-request" width={600}>
    <div className="w-full bg-surface-raised"><InlineRequest /></div>
  </Frame>,
];
