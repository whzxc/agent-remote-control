import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { orderedAgents, name } from "../state/agents";
import { useDispatchCatalog } from "../state/dispatchCatalog";
import type { DispatchSummary } from "../types";
import { SpecPill } from "./activity";
import { modelLabel } from "./composites/dispatchSpecLabel";
import { Dialog, Field, Group, Notice, SingleChoice } from "./ui";

type Defaults = { model?: string | null; effort?: string | null };
// SingleChoice needs a nonempty value; it maps to null (inheritance) on save.
const INHERIT = "inherit";

/** Load and save one defaults record through a local management route. */
function useDefaults(read: string, write: string, key: Record<string, string>) {
  const [defaults, setDefaults] = useState<Defaults>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const id = JSON.stringify(key);
  useEffect(() => {
    let current = true;
    setDefaults(undefined); setError("");
    api<Defaults>(read, "POST", JSON.parse(id))
      .then(value => { if (current) setDefaults(value); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [read, id]);
  const save = async (next: Defaults, effort: boolean) => {
    setSaving(true); setError("");
    try {
      setDefaults(await api<Defaults>(write, "POST",
        { ...key, model: next.model || null, ...(effort ? { effort: next.effort || null } : {}) }));
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };
  return { defaults, saving, error, save };
}

/** Model and effort choices backed by the Agent's native catalog. */
function DefaultsFields({ agent, defaults, saving, effort: withEffort, inheritLabel, onSave }: {
  agent: string; defaults: Defaults; saving: boolean; effort: boolean; inheritLabel: string; onSave: (next: Defaults) => void;
}) {
  const catalog = useDispatchCatalog(agent)?.catalog;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const model = defaults.model ?? "", effort = defaults.effort ?? "";
  const choice = (value: string) => value === INHERIT ? "" : value;
  const modelEfforts = (id: string) => models.find(row => row.model === id)?.efforts ?? [];
  const efforts = [...new Set(model ? modelEfforts(model) : models.flatMap(row => row.efforts ?? []))];
  const inherit = { value: INHERIT, label: inheritLabel };
  // Retain a saved value even when the current catalog no longer lists it.
  const modelChoices = [inherit, ...[...new Set([...models.map(row => row.model), ...(model ? [model] : [])])]
    .map(id => ({ value: id, label: modelLabel(id, models) }))];
  const effortChoices = [inherit, ...[...new Set([...efforts, ...(effort ? [effort] : [])])]
    .map(value => ({ value, label: t(`dispatchSpec.effort.${value}`) === `dispatchSpec.effort.${value}` ? value : t(`dispatchSpec.effort.${value}`) }))];
  return <>
    <Field label={t("dispatchDefaults.model")}>
      <SingleChoice label={t("dispatchDefaults.model")} value={model || INHERIT} disabled={saving}
        options={modelChoices} onChange={selected => { const value = choice(selected); onSave({ model: value,
          // Keep effort only while the newly selected model still supports it.
          effort: effort && (!value || !modelEfforts(value).length || modelEfforts(value).includes(effort)) ? effort : "" }); }} />
    </Field>
    {withEffort && <Field label={t("dispatchDefaults.effort")}>
      <SingleChoice label={t("dispatchDefaults.effort")} value={effort || INHERIT} disabled={saving}
        options={effortChoices} onChange={value => onSave({ model, effort: choice(value) })} />
    </Field>}
  </>;
}

/** Edit the policy defaults used when a control source omits model or effort. */
export default function AgentDispatchDefaults({ agent }: { agent: string }) {
  const codex = agent === "codex";
  const { defaults, saving, error, save } = useDefaults("agents/dispatch-defaults/read", "agents/dispatch-defaults", { agent });
  if (!defaults) return error ? <Notice>{error}</Notice> : null;
  return <Group title={t("dispatchDefaults.title", { agent: name(orderedAgents().find(row => row.agent === agent) ?? { agent }) })}>
    {error && <Notice>{error}</Notice>}
    <DefaultsFields agent={agent} defaults={defaults} saving={saving} effort={codex} inheritLabel={t("dispatchDefaults.inherit")}
      onSave={next => void save(next, codex)} />
  </Group>;
}

/** The task's spec pill; editable tasks open a dialog choosing the model for later turns. */
export function TaskSpecChoice({ agent, threadId, taskId, summary, editable }: {
  agent: string; threadId: string; taskId?: string; summary?: DispatchSummary; editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pill = <SpecPill agent={agent} taskId={taskId} summary={summary} />;
  if (!editable) return pill;
  return <>
    <button type="button" className="task-spec-choice" aria-haspopup="dialog" aria-label={t("taskDispatch.title")} onClick={() => setOpen(true)}>
      {summary?.model ? pill : <span className="activity-spec">{t("taskDispatch.inherit")}</span>}
    </button>
    {open && <TaskDispatchDialog agent={agent} threadId={threadId} onClose={() => setOpen(false)} />}
  </>;
}

function TaskDispatchDialog({ agent, threadId, onClose }: { agent: string; threadId: string; onClose: () => void }) {
  const { defaults, saving, error, save } = useDefaults("tasks/dispatch-defaults/read", "tasks/dispatch-defaults", { threadId });
  return <Dialog title={t("taskDispatch.title")} onClose={onClose} busy={saving} width={400}>
    {error && <Notice>{error}</Notice>}
    {defaults && <>
      <p className="row-description">{t("taskDispatch.hint")}</p>
      <DefaultsFields agent={agent} defaults={defaults} saving={saving} effort inheritLabel={t("taskDispatch.inherit")}
        onSave={next => void save(next, true)} />
    </>}
  </Dialog>;
}
