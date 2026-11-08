import { Frame } from "sdg";
import { Button } from "./button";
import { promptExample } from "../fixtures/feedback";

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
    <Prompt {...promptExample} />
  </Frame>
);
