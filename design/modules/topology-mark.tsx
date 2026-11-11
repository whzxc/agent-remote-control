import { Frame } from "adg";
import ArcMarkArt from "../art/arc-mark.svg";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { Dialog } from "../components/panel";
import { markForms, recoveryForms, ringCopy } from "../fixtures/topology-mark";

type ArcHealth = "healthy" | "unhealthy";
type ArcSide = "remote" | "core";

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
  remote = "healthy",
  core = "healthy",
  revealed,
  sourceAction = true,
  agentAction = true,
}: {
  size?: number;
  remote?: ArcHealth;
  core?: ArcHealth;
  revealed?: ArcSide;
  sourceAction?: boolean;
  agentAction?: boolean;
}) {
  const g = geometry;
  const fault = {
    ...(remote === "unhealthy" ? { "--remote-arc-color": "var(--danger)", "--remote-arc-dash": "39 22 39" } : {}),
    ...(core === "unhealthy" ? { "--core-arc-color": "var(--danger)", "--core-arc-dash": "39 22 39" } : {}),
  };
  const mark = (
    <svg
      data-free width={size} height={size} viewBox="0 0 240 240" role="img"
      aria-label={`${ringCopy.remote.status[remote]}. ${ringCopy.core.status[core]}.`}
    >
      <ArcMarkArt data-brand width={240} height={240} style={fault} />
      {sourceAction && (
        <g fill="none" stroke="var(--canvas)" stroke-width={7.82} stroke-linecap="round">
          <path d={`M${g.sourceX - 9.333} ${g.centerY}h18.666M${g.sourceX} ${g.centerY - 9.333}v18.666`} />
        </g>
      )}
      {agentAction &&
        [-1, 0, 1].map((i) => (
          <circle cx={g.agentX + i * g.dotGap} cy={g.centerY} r={g.dotRadius} fill="var(--canvas)" />
        ))}
    </svg>
  );
  if (!revealed) return mark;
  const action = ringCopy[revealed][revealed === "remote" ? remote : core];
  const upper = revealed === "remote";
  return (
    <div class={`relative flex justify-center ${upper ? "pt-4" : "pb-4"}`} style={{ width: size }}>
      {mark}
      <div class={`absolute left-1/2 -translate-x-1/2 ${upper ? "top-0" : "bottom-0"}`}>
        <IconButton {...action} compact active />
      </div>
    </div>
  );
}

export function ArcRecovery({ form }: { form: typeof recoveryForms[number]["form"] }) {
  const { title, reason, impact, secondary, primary } = ringCopy.recovery[form];
  return (
    <Dialog title={title} width={380}>
      <div class="flex flex-col gap-2">
        <p class="text-small leading-5">{reason}</p>
        {impact && <p class="text-meta leading-5 text-text-secondary">{impact}</p>}
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        {secondary && <Button>{secondary}</Button>}
        <Button variant="primary">{primary}</Button>
      </div>
    </Dialog>
  );
}

export default () => [
  ...markForms.map(({ name, note, ...props }) => (
    <Frame name={name} note={note}>
      <TopologyMark {...props} />
    </Frame>
  )),
  ...recoveryForms.map(({ form, note }) => (
    <Frame name={`arc-recovery-${form}`} note={note}>
      <ArcRecovery form={form} />
    </Frame>
  )),
];
