import { Tooltip as HoverHelp } from "./index";
import { Zap } from "lucide-react";
import EffortGauge, { type EffortPosition } from "./EffortGauge";
import { Icon } from "./index";
import "./DispatchSpec.css";

export default function DispatchSpec({ id, model, effort, position, tier, fast }: {
  id?: string;
  model?: string;
  effort?: string;
  position?: EffortPosition;
  tier?: string;
  fast?: boolean;
}) {
  const label = [model, effort, tier].filter(Boolean).join(" · ");
  if (!label) return null;
  return <HoverHelp text={label}><span id={id} className="dispatch-spec" role="img" aria-label={label}>
    {model && <span className="dispatch-spec-model">{model}</span>}
    {effort && (position ? <EffortGauge {...position} />
      : <span className="dispatch-spec-value">{effort}</span>)}
    {tier && (fast ? <span className="dispatch-spec-fast"><Icon icon={Zap} size={12} /></span>
      : <span className="dispatch-spec-value">{tier}</span>)}
  </span></HoverHelp>;
}
