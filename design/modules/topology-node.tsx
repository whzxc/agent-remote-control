import { example } from "../fixtures/topology-node";
import { Frame } from "adg";
import { NodeTaskPill, type NodeTaskState } from "./topology-task-state";
import { AgentIcon, type AgentIconReading, type Brand } from "../components/agent-icon";

export type TopologyNodeProps = {
  label: string;
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  width?: number;
  layout?: "vertical" | "source" | "agent";
  hideLabel?: boolean;
  graphic?: unknown;
  taskState?: NodeTaskState;
  taskPillAnchor?: "above-end" | "above-center" | "below-label" | "rail-left" | "below-icon" | "device-corner";
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
  taskState,
  taskPillAnchor = hideLabel ? "below-icon" : "above-end",
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
  const anchors = {
    "above-end": "-top-7 right-0 w-[140px]",
    "above-center": "-top-7 left-1/2 -translate-x-1/2 w-[140px]",
    "below-label": "top-[78px] left-1/2 -translate-x-1/2 w-[140px]",
    "rail-left": "top-3 right-14 w-[104px]",
    "below-icon": "top-[52px] right-0 w-[104px]",
    "device-corner": "top-[52px] -left-30 w-[104px]",
  };
  const alignment = taskPillAnchor === "above-center" || taskPillAnchor === "below-label" ? "justify-center" : "justify-end";
  const graphic = taskState ? <span class="relative inline-flex shrink-0">
    {baseGraphic}
    <span class={`absolute flex ${alignment} ${anchors[taskPillAnchor]}`}>
      <NodeTaskPill state={taskState} label={label} compact={hideLabel} />
    </span>
  </span> : baseGraphic;
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
