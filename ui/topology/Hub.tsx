import { useId } from "react";
import { t } from "../i18n";
import { hubMarkGeometry } from "./geometry";
import { Laptop, Network, Plus, Power, RotateCw, type LucideIcon } from "lucide-react";
import { Icon, IconButton, Tooltip } from "../components/ui";

type Arc = {
  unhealthy: boolean;
  label: string;
};

type ArcAction = {
  className: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  opensDialog?: boolean;
  busy?: boolean;
};

export default function Hub({ sourceEmpty, agentEmpty, remote, core, onAddSource, onManageAgents, onDeviceLink }: {
  remote: Arc & { open: () => void; recover?: () => void };
  core: Arc & { action?: () => void; recovery?: boolean; busy?: boolean };
  sourceEmpty: boolean;
  agentEmpty: boolean;
  onAddSource: () => void;
  onManageAgents: () => void;
  onDeviceLink?: () => void;
}) {
  const id = useId(), mark = hubMarkGeometry();
  return <>
    <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control" />
    {([["top", remote], ["bottom", core]] as const).map(([side, arc]) => {
      const upper = side === "top";
      const actions: ArcAction[] = [];
      if (upper) {
        actions.push({ className: "hub-connections", label: t("hub.viewConnections"), icon: Network, run: remote.open, opensDialog: true });
        if (remote.recover) {
          actions.push({ className: "hub-remote-recovery", label: t("hub.remoteRecovery"), icon: RotateCw, run: remote.recover, opensDialog: true });
        }
      } else {
        if (onDeviceLink) actions.push({ className: "hub-device-link", label: t("device.deviceLink"), icon: Laptop, run: onDeviceLink, opensDialog: true });
        if (core.action) {
          actions.push({ className: "hub-core-action", label: t(core.recovery ? "hub.coreRecovery" : "hub.stopCore"),
            icon: core.recovery ? RotateCw : Power, run: core.action, opensDialog: core.recovery, busy: core.busy });
        }
      }
      return <div key={side} className="hub-arc-orbit">
        <div className={`hub-arc hub-arc-${side}`} data-unhealthy={arc.unhealthy || undefined} data-paired={actions.length > 1 || undefined}>
          <svg viewBox="4 4 92 92" role="img" aria-label={arc.label}>
            <path className="hub-arc-hit" data-hub-arc={side} d={mark[side]} fill="none" stroke="transparent" strokeWidth="18" />
            <path className="hub-arc-stroke" data-hub-arc={side} data-panel-visual d={mark[side]} fill="none"
              stroke={upper ? "var(--topology-source)" : "var(--topology-agent)"} strokeWidth="9" strokeLinecap="round" />
          </svg>
          {actions.length > 0 && <>
            <span className="hub-arc-bridge" aria-hidden="true" />
            <span className="hub-arc-action">
              {actions.map(({ className, icon, label, opensDialog, busy, run }) =>
                <Tooltip key={className} text={label} side="right">
                  <IconButton compact filled className={className} icon={icon} label={label}
                    aria-haspopup={opensDialog ? "dialog" : undefined}
                    aria-description={arc.label} aria-disabled={busy || undefined} aria-busy={busy || undefined}
                    data-panel-anchor onClick={() => { if (!busy) run(); }} />
                </Tooltip>)}
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
