import { Frame } from "sdg";
import { Button } from "./button";
const example = {
  text: "把我现有的 Codex MCP 服务导入 ARC 的 MCP 中枢，然后列出它们的工具，并告诉我哪些服务连接失败。",
  label: "复制提示词",
};
export function Prompt({
  text,
  label,
  context,
  actionBelow = false,
}: {
  text: string;
  label: string;
  context?: string;
  actionBelow?: boolean;
}) {
  return (
    <div
      class={`flex w-full gap-3 rounded-card bg-surface-subtle px-4 py-[14px] ${actionBelow ? "flex-col items-start" : "items-center"}`}
    >
      <p class="min-w-0 flex-1 text-small leading-5 text-text">{text}</p>
      <Button icon="copy">{label}</Button>
    </div>
  );
}
export default () => (
  <Frame name="default" width={520}>
    <Prompt {...example} />
  </Frame>
);
