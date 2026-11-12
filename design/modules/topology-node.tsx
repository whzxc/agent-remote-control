import { example } from "../fixtures/topology-node";
import { Frame } from "adg";
import { NodeTaskBadge, type NodeTaskState } from "./topology-task-state";
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
  const graphic = taskState ? <span class="relative inline-flex shrink-0">
    {baseGraphic}
    <span class="absolute -top-2 right-1"><NodeTaskBadge state={taskState} label={label} /></span>
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
