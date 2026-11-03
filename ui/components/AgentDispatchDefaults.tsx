import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { useDispatchCatalog } from "../state/dispatchCatalog";
import { modelLabel } from "./composites/dispatchSpecLabel";
import { Field, Group, Notice, SingleChoice } from "./ui";

type Defaults = { agent: string; model?: string | null; effort?: string | null };
// SingleChoice needs a nonempty value; it maps to null (native inheritance) on save.
const INHERIT = "inherit";

/** Edit the policy defaults used when a control source omits model or effort. */
export default function AgentDispatchDefaults({ agent }: { agent: string }) {
  const catalog = useDispatchCatalog(agent)?.catalog;
  const [defaults, setDefaults] = useState<Defaults>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setDefaults(undefined); setError("");
    api<Defaults>("agents/dispatch-defaults/read", "POST", { agent })
      .then(value => { if (current) setDefaults(value); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [agent]);
  if (!defaults) return error ? <Notice>{error}</Notice> : null;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const codex = agent === "codex";
  const model = defaults.model ?? "", effort = defaults.effort ?? "";
  const choice = (value: string) => value === INHERIT ? "" : value;
  const modelEfforts = (id: string) => models.find(row => row.model === id)?.efforts ?? [];
  const efforts = [...new Set(model ? modelEfforts(model) : models.flatMap(row => row.efforts ?? []))];
  const inherit = { value: INHERIT, label: t("dispatchDefaults.inherit") };
  // Retain a saved value even when the current catalog no longer lists it.
  const modelChoices = [inherit, ...[...new Set([...models.map(row => row.model), ...(model ? [model] : [])])]
    .map(id => ({ value: id, label: modelLabel(id, models) }))];
  const effortChoices = [inherit, ...[...new Set([...efforts, ...(effort ? [effort] : [])])]
    .map(value => ({ value, label: t(`dispatchSpec.effort.${value}`) === `dispatchSpec.effort.${value}` ? value : t(`dispatchSpec.effort.${value}`) }))];
  const save = async (next: Defaults) => {
    setSaving(true); setError("");
    try {
      setDefaults(await api<Defaults>("agents/dispatch-defaults", "POST",
        codex ? { agent, model: next.model || null, effort: next.effort || null } : { agent, model: next.model || null }));
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };
  return <Group title={t("dispatchDefaults.title")}>
    {error && <Notice>{error}</Notice>}
    <Field label={t("dispatchDefaults.model")}>
      <SingleChoice label={t("dispatchDefaults.model")} value={model || INHERIT} disabled={saving}
        options={modelChoices} onChange={selected => { const value = choice(selected); void save({ ...defaults, model: value,
          // Keep effort only while the newly selected model still supports it.
          effort: effort && (!value || !modelEfforts(value).length || modelEfforts(value).includes(effort)) ? effort : "" }); }} />
    </Field>
    {codex && <Field label={t("dispatchDefaults.effort")}>
      <SingleChoice label={t("dispatchDefaults.effort")} value={effort || INHERIT} disabled={saving}
        options={effortChoices} onChange={value => void save({ ...defaults, effort: choice(value) })} />
    </Field>}
  </Group>;
}
