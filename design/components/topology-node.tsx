import { Frame } from "sdg";
import { AgentIcon, type AgentIconReading, type Brand } from "./agent-icon";
const example = {
  label: "Personal",
  brand: "claude-code" as const,
  readings: [
    {
      id: "display",
      label: "Week",
      value: 73,
      color: "var(--success)",
      elapsed: 4 / 7,
    },
  ],
};
export type TopologyNodeProps = {
  label: string;
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  width?: number;
  layout?: "vertical" | "source" | "agent";
  stacked?: boolean;
};
export function TopologyNode({
  label, brand, readings, used, width = 110, layout = "vertical", stacked = false,
}: TopologyNodeProps) {
  const horizontal = layout !== "vertical";
  const graphic = <span class={horizontal ? "grid size-12 shrink-0 place-items-center" : "flex"}>
    {horizontal && <span class={`col-start-1 row-start-1 rounded-full bg-canvas ${readings?.length ? "size-[46px]" : "size-[42px]"} ${stacked ? "border border-border" : ""}`} />}
    <span class="col-start-1 row-start-1 flex"><AgentIcon brand={brand} readings={readings} used={used} /></span>
  </span>;
  return (
    <div style={{ width }} class={`flex h-[76px] text-text ${horizontal ? "items-start pt-[2px] gap-[5px]" : "flex-col items-center gap-[2px] pt-[2px]"}`}>
      {layout === "source" ? <>
        <span class="flex w-[85px] shrink-0 justify-end items-center h-12 text-meta">{label}</span>
        {graphic}
      </> : <>
        {graphic}
        {label && <span class={`text-meta ${horizontal ? "flex items-center h-12 whitespace-nowrap" : "leading-5"}`}>{label}</span>}
      </>}
    </div>
  );
}
export default () => (
  <Frame name="default">
    <TopologyNode {...example} />
  </Frame>
);
