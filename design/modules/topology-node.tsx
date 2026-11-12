import { example } from "../fixtures/topology-node";
import { Frame } from "adg";
import { NodeCapsule, type NodeTaskState } from "./node-capsule";
import { AgentIcon, BrandMark, type AgentIconReading, type Brand } from "../components/agent-icon";

export type TopologyNodeProps = {
  label: string;
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  width?: number;
  layout?: "vertical" | "source" | "agent";
  hideLabel?: boolean;
  graphic?: unknown;
  /** The logo drawn inside a working capsule, whose outline replaces the quota ring. */
  capsuleMark?: unknown;
  capsuleReadings?: readonly AgentIconReading[];
  taskState?: NodeTaskState;
  capsuleNeutralRing?: boolean;
  capsuleCompact?: boolean;
  capsuleWing?: "left" | "right";
  panelExpanded?: boolean;
};
export function TopologyNode({
  label,
  brand,
  readings,
  used,
  width = 110,
  layout = "vertical",
  hideLabel = false,
  graphic: customGraphic,
  capsuleMark,
  capsuleReadings,
  taskState,
  capsuleNeutralRing = false,
  capsuleCompact = false,
  capsuleWing = "right",
  panelExpanded,
}: TopologyNodeProps) {
  const horizontal = layout !== "vertical";
  const baseGraphic = customGraphic ?? (
    <span class={horizontal ? "grid size-12 shrink-0 place-items-center" : "flex"}>
      {horizontal && (
        <span
          class={
            "col-start-1 row-start-1 rounded-full bg-canvas " +
            String(readings?.length ? "size-[46px]" : "size-[42px]")
          }
        />
      )}
      <span class="col-start-1 row-start-1 flex">
        <AgentIcon brand={brand} readings={readings} used={used} />
      </span>
    </span>
  );
  const mark = capsuleMark ?? (customGraphic ? undefined : <BrandMark brand={brand} size={readings?.length ? 28 : 32} />);
  const graphic = taskState ? <NodeCapsule state={taskState} label={label} graphic={baseGraphic} mark={mark}
    readings={capsuleReadings ?? readings} used={used} neutralRing={capsuleNeutralRing}
    compact={capsuleCompact} wing={capsuleWing} expanded={panelExpanded} /> : baseGraphic;
  return (
    <div
      aria-label={hideLabel ? label : undefined}
      style={{ width: hideLabel ? 48 : width }}
      class={
        "flex text-text " +
        String(
          hideLabel
            ? "h-12 items-center justify-center"
            : horizontal
              ? "h-[76px] items-start pt-[2px] gap-[5px]"
              : "h-[76px] flex-col items-center gap-[2px] pt-[2px]",
        )
      }
    >
      {hideLabel ? (
        graphic
      ) : layout === "source" ? (
        <>
          <span class="flex w-[85px] shrink-0 justify-end items-center h-12 text-meta">{label}</span>
          {graphic}
        </>
      ) : (
        <>
          {graphic}
          {label && (
            <span class={`text-meta ${horizontal ? "flex items-center h-12 whitespace-nowrap" : "leading-5"}`}>
              {label}
            </span>
          )}
        </>
      )}
    </div>
  );
}
export default () => (
  <Frame name="default">
    <TopologyNode {...example} />
  </Frame>
);
