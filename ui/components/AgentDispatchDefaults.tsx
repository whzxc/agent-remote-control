import { readOnlyBrowser } from "../browserMode";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { orderedAgents, name } from "../state/agents";
import { useDispatchCatalog } from "../state/dispatchCatalog";
import { createStore } from "../state/store";
import type { DispatchSummary } from "../types";
import RecordedDispatchSpec from "./composites/RecordedDispatchSpec";
import { modelLabel, orderedReasoningLevels, reasoningLevels } from "./composites/dispatchSpecLabel";
import ModelEffortPicker from "./ModelEffortPicker";
import { Dialog, Field, Notice } from "./ui";

import { SettingsSection, Setting } from "./ui/Settings";

type Defaults = { model?: string | null; effort?: string | null };
type DefaultsState = { defaults?: Defaults; saving: boolean; error: string };
function newDefaultsRecord() {
  return { state: createStore<DefaultsState>({ saving: false, error: "" }), confirmed: undefined as Defaults | undefined,
    revision: 0, pending: Promise.resolve(), users: 0, reading: false };
}
// Pending edits belong to the record, including while its settings are closed.
const defaultsRecords = new Map<string, ReturnType<typeof newDefaultsRecord>>();
function releaseDefaultsRecord(id: string, record: ReturnType<typeof newDefaultsRecord>) {
  if (!record.users && !record.reading && !record.state.get().saving && defaultsRecords.get(id) === record) defaultsRecords.delete(id);
}

/** Load and save one defaults record through a local management route. */
function useDefaults(read: string, write: string, key: Record<string, string>) {
  const id = JSON.stringify(key);
  const identity = JSON.stringify([read, write, id]);
  const record = useMemo(() => {
    let value = defaultsRecords.get(identity);
    if (!value) { value = newDefaultsRecord(); defaultsRecords.set(identity, value); }
    return value;
  }, [identity]);
  const snapshot = record.state.use();
  useEffect(() => {
    record.users++;
    // A reopened editor shares pending choices; reading here would restore stale server values.
    if (!record.reading && !record.state.get().saving) {
      record.reading = true;
      const revision = record.revision;
      void api<Defaults>(read, "POST", JSON.parse(id))
        .then(value => {
          if (revision !== record.revision) return;
          record.confirmed = value; record.state.set({ defaults: value, saving: false, error: "" });
        })
        .catch(e => { if (revision === record.revision) record.state.set(old => ({ ...old, error: String(e) })); })
        .finally(() => { record.reading = false; releaseDefaultsRecord(identity, record); });
    }
    return () => { record.users--; releaseDefaultsRecord(identity, record); };
  }, [read, id, identity, record]);
  const save = (next: Defaults, effort: boolean) => {
    const revision = ++record.revision;
    // Render the latest pair immediately so the next edit retains both fields.
    record.state.set({ defaults: next, saving: true, error: "" });
    // The management route replaces the pair. Preserve edit order at the server
    // and keep older acknowledgements from replacing newer local choices.
    record.pending = record.pending.then(async () => {
      try {
        const value = await api<Defaults>(write, "POST",
          { ...key, model: next.model || null, ...(effort ? { effort: next.effort || null } : {}) });
        record.confirmed = value;
        if (revision === record.revision) record.state.set({ defaults: value, saving: false, error: "" });
      } catch (e) {
        if (revision === record.revision) {
          record.state.set({ defaults: record.confirmed, saving: false, error: String(e) });
        }
      } finally {
        releaseDefaultsRecord(identity, record);
      }
    });
  };
  return { ...snapshot, save };
}

/** The model and effort picker backed by the Agent's native catalog. */
function DefaultsFields({ agent, defaults, effort: withEffort, inheritLabel, rows, inline, onSave }: {
  agent: string; defaults: Defaults; effort: boolean; inheritLabel: string; rows?: boolean; inline?: boolean; onSave: (next: Defaults) => void;
}) {
  const catalog = useDispatchCatalog(agent)?.catalog;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const model = defaults.model ?? "", effort = defaults.effort ?? "";
  const modelEfforts = (id: string) => reasoningLevels(id, catalog);
  const efforts = model ? modelEfforts(model) : orderedReasoningLevels(models.flatMap(row => row.efforts ?? []));
  // Retain a saved value even when the current catalog no longer lists it.
  const modelChoices = [...new Set([...models.map(row => row.model), ...(model ? [model] : [])])]
    .map(id => ({ value: id, label: modelLabel(id, models) }));
  const label = withEffort ? t("dispatchDefaults.spec") : t("dispatchDefaults.model");
  const picker = <ModelEffortPicker disabled={readOnlyBrowser} label={label} models={modelChoices} efforts={efforts} model={model} effort={effort}
    inheritLabel={inheritLabel} withEffort={withEffort}
    onChange={next => onSave({ model: next.model,
      // Keep effort only while the newly selected model still supports it.
      effort: next.effort && (next.model === model || !next.model || !modelEfforts(next.model).length || modelEfforts(next.model).includes(next.effort)) ? next.effort : "" })} />;
  if (inline) return <div className="task-dispatch-fields"><span>{label}</span>{picker}</div>;
  return rows ? <Setting title={label} width={360}>{picker}</Setting> : <Field label={label}>{picker}</Field>;
}

/** Edit the policy defaults used when a control source omits model or effort. */
export default function AgentDispatchDefaults({ agent, onBusy }: { agent: string; onBusy?: (busy: boolean) => void }) {
  const codex = agent === "codex";
  const { defaults, error, saving, save } = useDefaults("agents/dispatch-defaults/read", "agents/dispatch-defaults", { agent });
  useEffect(() => { onBusy?.(saving); return () => onBusy?.(false); }, [saving, onBusy]);
  if (!defaults) return error ? <Notice>{error}</Notice> : null;
  return <SettingsSection title={t("dispatchDefaults.title", { agent: name(orderedAgents().find(row => row.agent === agent) ?? { agent }) })}>
    {error && <Notice>{error}</Notice>}
    <DefaultsFields agent={agent} defaults={defaults} effort={codex} inheritLabel={t("dispatchDefaults.inherit")} rows
      onSave={next => void save(next, codex)} />
  </SettingsSection>;
}

/** The task's spec pill; editable tasks open a dialog choosing the model for later turns. */
export function TaskSpecChoice({ agent, threadId, taskId, summary, editable }: {
  agent: string; threadId: string; taskId?: string; summary?: DispatchSummary; editable: boolean;
}) {
  const [open, setOpen] = useState(false), specId = useId();
  if (!editable || readOnlyBrowser) return <RecordedDispatchSpec agent={agent} taskId={taskId} summary={summary} />;
  return <>
    <button type="button" className="task-spec-choice" aria-haspopup="dialog" aria-label={t("taskDispatch.title")} aria-describedby={specId} onClick={() => setOpen(true)}>
      <RecordedDispatchSpec id={specId} agent={agent} taskId={taskId} summary={summary} fallback={t("taskDispatch.inherit")} />
    </button>
    {open && <TaskDispatchDialog agent={agent} threadId={threadId} onClose={() => setOpen(false)} />}
  </>;
}

function TaskDispatchDialog({ agent, threadId, onClose }: { agent: string; threadId: string; onClose: () => void }) {
  const { defaults, error, saving, save } = useDefaults("tasks/dispatch-defaults/read", "tasks/dispatch-defaults", { threadId });
  return <Dialog size="s" busy={saving} title={t("taskDispatch.title")} onClose={onClose} description={t("taskDispatch.hint")}>
    {error && <Notice>{error}</Notice>}
    {defaults && <div className="form">
      <DefaultsFields agent={agent} defaults={defaults} effort inline inheritLabel={t("taskDispatch.inherit")}
        onSave={next => void save(next, true)} />
    </div>}
  </Dialog>;
}
