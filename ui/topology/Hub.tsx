import { useId } from "react";
import { t } from "../i18n";
import { hubMarkGeometry } from "./geometry";
import { Network, Plus, Power, RotateCw } from "lucide-react";
import { Icon, IconButton, Tooltip } from "../components/ui";

type Arc = {
  unhealthy: boolean;
  label: string;
  action?: () => void;
  recovery?: boolean;
  busy?: boolean;
};

export default function Hub({ sourceEmpty, agentEmpty, remote, core, onAddSource, onManageAgents }: {
  remote: Arc;
  core: Arc;
  sourceEmpty: boolean;
  agentEmpty: boolean;
  onAddSource: () => void;
  onManageAgents: () => void;
}) {
  const id = useId(), mark = hubMarkGeometry();
  return <>
    <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control" />
    {([["top", remote], ["bottom", core]] as const).map(([side, arc]) => {
      const upper = side === "top";
      const label = t(arc.recovery
        ? upper ? "hub.remoteRecovery" : "hub.coreRecovery"
        : upper ? "hub.viewConnections" : "hub.stopCore");
      return <div key={side} className="hub-arc-orbit">
        <div className={`hub-arc hub-arc-${side}`} data-unhealthy={arc.unhealthy || undefined}>
          <svg viewBox="4 4 92 92" role="img" aria-label={arc.label}>
            <path className="hub-arc-hit" data-hub-arc={side} d={mark[side]} fill="none" stroke="transparent" strokeWidth="18" />
            <path className="hub-arc-stroke" data-hub-arc={side} data-panel-visual d={mark[side]} fill="none"
              stroke={upper ? "var(--topology-source)" : "var(--topology-agent)"} strokeWidth="9" strokeLinecap="round" pathLength="100" />
          </svg>
          {arc.action && <>
            <span className="hub-arc-bridge" aria-hidden="true" />
            <span className="hub-arc-action">
              <Tooltip text={label} side="right">
                <IconButton compact filled className={upper ? "hub-connections" : "hub-core-action"}
                  icon={arc.recovery ? RotateCw : upper ? Network : Power} label={label}
                  aria-haspopup={arc.recovery || upper ? "dialog" : undefined}
                  aria-description={arc.label} aria-disabled={arc.busy || undefined} aria-busy={arc.busy || undefined}
                  data-panel-anchor onClick={() => { if (!arc.busy) arc.action?.(); }} />
              </Tooltip>
            </span>
          </>}
        </div>
      </div>;
    })}
    {(["source", "agent"] as const).map(side => {
      const source = side === "source", empty = source ? sourceEmpty : agentEmpty;
      const label = t(source ? "addControlSource" : empty ? "addAgent" : "manageAgents");
      return <button key={side} type="button" className={`hub-entry hub-${side}`} data-empty={empty || undefined}
        data-panel-anchor aria-label={label} onClick={source ? onAddSource : onManageAgents}>
        <span className="hub-dot" data-panel-visual>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <defs>
              <mask id={`${id}-${side}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20" style={{ maskType: "luminance" }}>
                <rect width="20" height="20" fill="white" />
                <g className="hub-symbol" fill="black" stroke="black" strokeWidth=".67" strokeLinecap="round">
                  <g>
                    {source || empty ? <g transform="translate(3.866667 3.866667) scale(.68148148)" color="black"><Icon className="hub-plus" icon={Plus} size={18} /></g>
                      : <g stroke="none"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></g>}
                  </g>
                </g>
              </mask>
            </defs>
            <circle cx="10" cy="10" r="10" fill={source ? "var(--topology-source)" : "var(--topology-agent)"} mask={`url(#${id}-${side}-mask)`} />
          </svg>
        </span>
      </button>;
    })}
  </>;
}
