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
export function TopologyNode({
  label,
  brand,
  readings,
  used,
  width = 110,
}: {
  label: string;
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  width?: number;
}) {
  return (
    <div
      data-free
      style={{ width }}
      class="flex h-[76px] flex-col items-center gap-[2px] pt-[2px] text-text"
    >
      <AgentIcon brand={brand} readings={readings} used={used} />
      <span class="text-meta leading-5">{label}</span>
    </div>
  );
}
export default () => (
  <Frame name="default">
    <TopologyNode {...example} />
  </Frame>
);
