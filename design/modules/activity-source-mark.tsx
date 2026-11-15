import { Frame, Icon } from "adg";
export function SourceMark({ inline = false, children }: { inline?: boolean; children?: unknown }) {
  return <span class={inline ? "inline-flex size-[14px] items-center justify-center" : "grid size-[13px] place-items-center rounded-full bg-surface text-text-secondary"}>
    {children ?? <Icon name="terminal" size={inline ? 14 : 9} />}
  </span>;
}
export default () => [
  <Frame name="badge"><SourceMark /></Frame>,
  <Frame name="inline"><SourceMark inline /></Frame>,
];
