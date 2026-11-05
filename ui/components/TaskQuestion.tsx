import { readOnlyBrowser } from "../browserMode";
import { useId, type ReactNode } from "react";
import type { AgentActivitySession } from "../types";
import { t } from "../i18n";
import { activityApprovals, submitActivityResponse } from "../state/activity";
import { interactionKey } from "../state/activityModel";
import { inputResponse, interactionQuestions, type Question } from "../state/taskInteractions";
import { Button, Checkbox, Field, Input, SingleChoice } from "./ui";
import { taskErrorText } from "../state/taskErrors";

function QuestionField({ question, value, onChange, disabled }: { question: Question; value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  const id = useId();
  const other = value.find(answer => !question.options.some(option => option.label === answer)) ?? "";
  const custom = !!other;
  const pick = (label: string) => {
    if (disabled) return;
    onChange(question.multiple ? value.includes(label) ? value.filter(v => v !== label) : [...value, label] : [label]);
  };
  return <fieldset className="task-question-field" disabled={disabled} onKeyDown={event => {
    if ((event.target as HTMLElement).closest("input,textarea") || event.altKey || event.metaKey || event.ctrlKey) return;
    const option = question.options[Number(event.key) - 1];
    if (option) { event.preventDefault(); pick(option.label); }
  }}><legend>{question.text}</legend>
    {question.multiple ? question.options.map((option, index) => <div className="task-multi-option" key={option.label}><Checkbox checked={value.includes(option.label)} onChange={() => pick(option.label)} disabled={disabled}>{option.label}</Checkbox>{option.description && <small>{option.description}</small>}<kbd>{index + 1}</kbd></div>)
      : !!question.options.length && <SingleChoice optionCards label={question.text} value={custom ? "" : value[0] ?? ""} onChange={pick} disabled={disabled} options={question.options.map((option, index) => ({ value: option.label, label: option.label, description: option.description, graphic: <kbd>{index + 1}</kbd> }))} />}
    {(question.other || !question.options.length) && <Field id={id} label={t(question.options.length ? "detail.other" : "timeline.answer")}><Input id={id} type={question.secret ? "password" : "text"} value={other} onFocus={() => { if (!question.multiple) onChange(other ? [other] : []); }} onChange={event => onChange([...(question.multiple ? value.filter(answer => question.options.some(option => option.label === answer)) : []), event.target.value])} disabled={disabled} /></Field>}
  </fieldset>;
}
export default function TaskQuestion({ agent, session, answers, onAnswersChange, routing }: { routing?: ReactNode; agent: string; session: AgentActivitySession; answers: Record<string, string[]>; onAnswersChange: (answers: Record<string, string[]>) => void }) {
  const submissions = activityApprovals.use();
  const submission = submissions[interactionKey(agent, session)];
  const interaction = session.interaction!;
  const questions = interactionQuestions(interaction);
  const locked = !!submission;
  const supported = !!inputResponse(interaction, {}, true, t("detail.skippedAnswer"));
  const send = (skip: boolean) => {
    const payload = inputResponse(interaction, answers, skip, t("detail.skippedAnswer"));
    if (payload) void submitActivityResponse(agent, session, skip ? "cancel" : "answer", payload);
  };
  return <form className="task-question" onSubmit={event => { event.preventDefault(); send(false); }}>
    <div className="task-question-options">{questions.map(question => <QuestionField key={question.id} question={question} value={answers[question.id] ?? []} onChange={value => onAnswersChange({ ...answers, [question.id]: value })} disabled={readOnlyBrowser || locked || !supported} />)}</div>
    {!supported && <p className="timeline-meta">{t("timeline.responseUnavailable")}</p>}
    {submission?.status === "unconfirmed" && <p role="status">{t("activity.unconfirmed")}</p>}
    {submission?.status === "failed" && <p role="alert">{taskErrorText(submission.error)}</p>}
    {routing}
    <div className="actions"><Button variant="ghost" disabled={readOnlyBrowser || !supported || locked && submission.decision !== "cancel" || submission?.status === "unconfirmed" || submission?.status === "submitted"} busy={submission?.status === "submitting" && submission.decision === "cancel"} onClick={() => send(true)}>{t("detail.skip")}</Button>
      <Button type="submit" variant="primary" disabled={readOnlyBrowser || !inputResponse(interaction, answers) || locked && submission.decision !== "answer" || submission?.status === "unconfirmed" || submission?.status === "submitted"} busy={submission?.status === "submitting" && submission.decision === "answer"}>{t(submission?.status === "pending" || submission?.status === "failed" ? "activity.checkResult" : "detail.sendAnswer")}</Button></div>
  </form>;
}
