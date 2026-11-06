import type { DispatchSummary } from "../../types";
import { locale, t } from "../../i18n";
import { useDispatchCatalog } from "../../state/dispatchCatalog";
import DispatchSpec from "../ui/DispatchSpec";
import { dispatchSpecParts, effortPosition, reasoningLevels } from "./dispatchSpecLabel";

export default function RecordedDispatchSpec({ id, summary, agent = "", taskId, fallback }: {
  id?: string;
  summary?: DispatchSummary;
  agent?: string;
  taskId?: string;
  fallback?: string;
}) {
  locale.use();
  const catalog = useDispatchCatalog(agent, taskId, !!agent && !!summary?.model)?.catalog;
  const parts = dispatchSpecParts(summary, catalog, t);
  const position = effortPosition(reasoningLevels(summary?.model, catalog), summary?.effort?.trim());
  const tier = summary?.serviceTier?.trim();
  return <DispatchSpec id={id} {...parts} model={parts.model ?? (parts.effort || parts.tier ? undefined : fallback)}
    position={position} fast={tier === "priority" || tier === "fast"} />;
}
