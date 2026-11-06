import { Frame } from "sdg";
const forms = [{ name: "prompt" }, { name: "queued", status: "Queued" }];
const example = "Apply the changes and run the project checks.";
export function TaskMessage({
  text,
  children,
  queued = false,
  status,
}: {
  text?: string;
  children?: unknown;
  queued?: boolean;
  status?: string;
}) {
  return (
    <div class="flex w-full flex-col gap-[18px] rounded-card bg-surface-sunken px-4 py-[15px] text-text">
      <p class="text-small leading-4">{text ?? children}</p>
      {(status || queued) && (
        <span class="self-end text-meta leading-[14px] text-text-secondary">
          {status || "Queued"}
        </span>
      )}
    </div>
  );
}
export default () =>
  forms.map(({ name, status }) => (
    <Frame name={name} width={520}>
      <TaskMessage text={example} status={status} />
    </Frame>
  ));
