import { markLabels, recovery } from "../fixtures/topology-mark";
import { Frame, Icon } from "sdg";
import ArcMarkArt from "../art/arc-mark.svg";
import { Button } from "../components/button";
import { Dialog } from "../components/panel";

const geometry = {
  size: 240,
  sourceX: 36.52,
  agentX: 203.48,
  centerY: 120,
  dotRadius: 3.91,
  dotGap: 15.65,
};
export function TopologyMark({
  size = geometry.size,
  health = "healthy",
  sourceAction = true,
  agentAction = true,
}: {
  size?: number;
  health?: "healthy" | "unhealthy";
  sourceAction?: boolean;
  agentAction?: boolean;
}) {
  const g = geometry;
  const unhealthy = health === "unhealthy";
  return (
    <svg data-free width={size} height={size} viewBox="0 0 240 240" role="img" aria-label={markLabels[health]}>
      <ArcMarkArt
        data-brand
        width={240}
        height={240}
        style={unhealthy ? { "--arc-fault-color": "var(--danger)" } : undefined}
      />
      {sourceAction && (
        <g fill="none" stroke="var(--canvas)" stroke-width={7.82} stroke-linecap="round">
          <path d={`M${g.sourceX - 9.333} ${g.centerY}h18.666M${g.sourceX} ${g.centerY - 9.333}v18.666`} />
        </g>
      )}
      {agentAction &&
        [-1, 0, 1].map((i) => (
          <circle cx={g.agentX + i * g.dotGap} cy={g.centerY} r={g.dotRadius} fill="var(--canvas)" />
        ))}
      {unhealthy && (
        <g aria-hidden="true">
          <circle cx={120} cy={g.centerY} r={23} fill="var(--surface-raised)" stroke="var(--danger)" stroke-width={2} />
          <g transform="translate(107 107)" class="text-danger">
            <Icon name="rotate-cw" size={26} />
          </g>
        </g>
      )}
    </svg>
  );
}

export function ArcRecovery() {
  return (
    <Dialog title={recovery.title} width={380}>
      <div class="flex flex-col gap-2">
        <p class="text-small leading-5">{recovery.reason}</p>
        <p class="text-meta leading-5 text-text-secondary">{recovery.impact}</p>
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        <Button>{recovery.restart}</Button>
        <Button variant="primary">{recovery.retry}</Button>
      </div>
    </Dialog>
  );
}

export default () => [
  <Frame name="topology-mark">
    <TopologyMark />
  </Frame>,
  <Frame
    name="topology-mark-unhealthy"
    note="Both arcs report ARC runtime health. The center action opens recovery. Source and Agent nodes keep their own states."
  >
    <TopologyMark health="unhealthy" />
  </Frame>,
  <Frame
    name="arc-recovery"
    note="Retry rechecks ARC. Restart uses Desktop recovery when Core cannot respond. Runtime capture awaits implementation."
  >
    <ArcRecovery />
  </Frame>,
];
