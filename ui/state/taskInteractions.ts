import type { AgentInteraction } from "../types.ts";
import { interactionKey, type ApprovalPayload, type ApprovalSubmission } from "./activityModel.ts";
export interface Question {
  id: string; text: string; multiple: boolean; other: boolean; secret: boolean;
  options: { label: string; description?: string }[];
}
export function interactionQuestions(interaction: AgentInteraction): Question[] {
  if (interaction.kind !== "question") return [];
  if (Array.isArray(interaction.questions)) return interaction.questions.map(q => ({ id: q.id, text: q.question, multiple: q.multiSelect === true, other: q.isOther !== false, secret: q.isSecret === true, options: q.options ?? [] }));
  const options = Array.isArray(interaction.options) ? interaction.options.flatMap(option => typeof option === "string" ? [{ label: option }] : option && typeof option.label === "string" ? [option] : []) : [];
  return [{ id: "answer", text: interaction.summary, multiple: false, other: interaction.method !== "select", secret: false, options }];
}
export function inputResponse(interaction: AgentInteraction, answers: Record<string, string[]>, skip = false, skippedAnswer?: string): ApprovalPayload | undefined {
  const { op, args } = interaction.respond;
  if (interaction.kind !== "question" || interaction.canRespond === false || !op || !args) return;
  const questions = interactionQuestions(interaction);
  if (!skip && questions.some(q => !answers[q.id]?.some(answer => answer.trim()))) return;
  if (op === "codex_respond") {
    if (interaction.method === "request_user_input_async" && (!skip || skippedAnswer?.trim())) return { op, args: { ...args, ...(skip ? { skipped: true } : {}), result: { answer: skip ? skippedAnswer : answers.answer?.join("\n") ?? "" } } };
    if (interaction.method === "item/tool/requestUserInput" && questions.length) return { op, args: { ...args, result: { answers: Object.fromEntries(questions.map(q => [q.id, { answers: skip ? [] : answers[q.id] }])) } } };
    return;
  }
  if (args.agent !== "pi") return;
  const value = answers.answer?.[0] ?? "";
  if (!skip && interaction.method === "select" && !questions[0].options.some(o => o.label === value)) return;
  return { op, args: { ...args, ...(skip ? { cancelled: true } : { value }) } };
}
export function answerLabel(payload: ApprovalPayload) {
  const result = payload.args.result as { answer?: string; answers?: Record<string, { answers: string[] }> } | undefined;
  return typeof payload.args.value === "string" ? payload.args.value : result?.answer ?? Object.values(result?.answers ?? {}).flatMap(v => v.answers).join(" · ");
}

export function pendingSessions(agent: string, session: import("../types.ts").AgentActivitySession, entries: import("../types.ts").AgentTimelineEntry[], submissions: Record<string, ApprovalSubmission> = {}) {
  const sameRequest = (interaction: AgentInteraction | undefined) => JSON.stringify(interaction?.respond) === JSON.stringify(session.interaction?.respond);
  const pending: import("../types.ts").AgentActivitySession[] = entries.filter(e => e.type === "interaction" && e.status === "pending" && !e.response && e.interaction && (!session.turnId || !e.turnId || e.turnId === session.turnId))
    .map(e => ({ ...session, turnId: e.turnId || session.turnId, phaseSince: e.startedAt, interaction: e.interaction }));
  // A stale activity snapshot must not resurrect a request already resolved in history.
  if (session.interaction && !entries.some(e => e.type === "interaction" && sameRequest(e.interaction))) pending.push(session);
  return pending.filter(s => s.interaction?.canRespond !== false && !!s.interaction?.respond.op && !!s.interaction.respond.args
    && submissions[interactionKey(agent, s)]?.status !== "submitted");
}

export function interactionSummary(interaction: AgentInteraction | undefined): string {
  if (!interaction) return "";
  const questions = interactionQuestions(interaction);
  return questions.length ? questions.map(q => `${q.text}${q.options.length ? ` (${q.options.map(o => o.label).join(" / ")})` : ""}`).join("; ") : interaction.summary;
}
