import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { orderedAgents, name } from "../state/agents";
import { useDispatchCatalog } from "../state/dispatchCatalog";
import type { DispatchSummary } from "../types";
import { SpecPill } from "./activity";
import { modelLabel } from "./composites/dispatchSpecLabel";
import ModelEffortPicker from "./ModelEffortPicker";
import { Dialog, Field, Group, Notice, Row } from "./ui";

type Defaults = { model?: string | null; effort?: string | null };
// Ascending reasoning effort; catalogs may list efforts in any order.
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

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

/** The model and effort picker backed by the Agent's native catalog. */
function DefaultsFields({ agent, defaults, effort: withEffort, inheritLabel, rows, onSave }: {
  agent: string; defaults: Defaults; effort: boolean; inheritLabel: string; rows?: boolean; onSave: (next: Defaults) => void;
}) {
  const catalog = useDispatchCatalog(agent)?.catalog;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const model = defaults.model ?? "", effort = defaults.effort ?? "";
  const modelEfforts = (id: string) => models.find(row => row.model === id)?.efforts ?? [];
  const efforts = [...new Set(model ? modelEfforts(model) : models.flatMap(row => row.efforts ?? []))]
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  // Retain a saved value even when the current catalog no longer lists it.
  const modelChoices = [...new Set([...models.map(row => row.model), ...(model ? [model] : [])])]
    .map(id => ({ value: id, label: modelLabel(id, models) }));
  const label = withEffort ? t("dispatchDefaults.spec") : t("dispatchDefaults.model");
  const picker = <ModelEffortPicker label={label} models={modelChoices} efforts={efforts} model={model} effort={effort}
    inheritLabel={inheritLabel} withEffort={withEffort}
    onChange={next => onSave({ model: next.model,
      // Keep effort only while the newly selected model still supports it.
      effort: next.effort && (next.model === model || !next.model || !modelEfforts(next.model).length || modelEfforts(next.model).includes(next.effort)) ? next.effort : "" })} />;
  return rows ? <Row title={label}>{picker}</Row> : <Field label={label}>{picker}</Field>;
}

/** Edit the policy defaults used when a control source omits model or effort. */
export default function AgentDispatchDefaults({ agent, rows }: {
  agent: string;
  /** Label-left rows for wide settings dialogs; narrow panels stack labels above controls. */
  rows?: boolean;
}) {
  const codex = agent === "codex";
  const { defaults, error, save } = useDefaults("agents/dispatch-defaults/read", "agents/dispatch-defaults", { agent });
  if (!defaults) return error ? <Notice>{error}</Notice> : null;
  return <Group title={t("dispatchDefaults.title", { agent: name(orderedAgents().find(row => row.agent === agent) ?? { agent }) })}>
    {error && <Notice>{error}</Notice>}
    <DefaultsFields agent={agent} defaults={defaults} effort={codex} inheritLabel={t("dispatchDefaults.inherit")} rows={rows}
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
    {defaults && <div className="form">
      <p className="row-description">{t("taskDispatch.hint")}</p>
      <DefaultsFields agent={agent} defaults={defaults} effort inheritLabel={t("taskDispatch.inherit")}
        onSave={next => void save(next, true)} />
    </div>}
  </Dialog>;
}
