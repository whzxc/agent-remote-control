import { Frame } from "sdg";
import { Button } from "./button";
const forms = [
  { name: "passive", status: "Will be handled at the source’s next check" },
  { name: "actionable", status: "Paused" },
  { name: "actionable-inline", status: "Paused" },
] as const;
const actions = { resume: "Resume", handoff: "Hand to Claude now" };
export type Routing = {
  state: "deferred" | "paused" | "routed" | "not-routable";
  deferUntil?: number | null;
  pausedBy?: string | null;
  reason?: string;
};
export function RoutingRow({
  children,
  inline = true,
}: {
  children?: unknown;
  inline?: boolean;
}) {
  return (
    <div
      class={`flex gap-2 text-meta text-text-secondary ${inline ? "items-center" : "flex-col items-start"}`}
    >
      {children}
    </div>
  );
}
export function RequestRouting({
  routing,
  source = "Claude",
  busy = false,
  mode = "all",
  now = 0,
  status,
  resumeLabel,
  handoffLabel,
  inline = false,
}: {
  routing?: Routing;
  source?: string;
  busy?: boolean;
  mode?: "all" | "passive" | "actionable";
  now?: number;
  status?: string;
  resumeLabel?: string;
  handoffLabel?: string;
  inline?: boolean;
}) {
  const actionable =
    routing?.state === "paused" || routing?.state === "deferred";
  if (
    routing &&
    ((mode === "passive" && actionable) ||
      (mode === "actionable" && !actionable))
  )
    return null;
  if (routing) {
    status ??=
      routing.state === "paused"
        ? "Paused"
        : routing.state === "deferred"
          ? `Hand to ${source} in ${Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000))}s`
          : routing.state === "not-routable"
            ? "Will be handled at the source’s next check"
            : `Handed to ${source}`;
    if (actionable) {
      resumeLabel ??= routing.state === "paused" ? "Resume" : "Pause";
      handoffLabel ??= `Hand to ${source} now`;
    }
  }
  if (!status) return null;
  return (
    <div class={!inline && resumeLabel ? "pb-[6px]" : ""}>
      <RoutingRow inline={inline}>
        <span
          class={
            resumeLabel && !inline
              ? "leading-6"
              : resumeLabel
                ? "leading-[34px] mr-[1px]"
                : "leading-7"
          }
        >
          {status}
        </span>
        {resumeLabel && (
          <div class="flex items-center gap-2">
            <Button disabled={busy} variant="ghost" class="px-5">
              {resumeLabel}
            </Button>
            {handoffLabel && (
              <Button disabled={busy} class="px-[18px]">
                {handoffLabel}
              </Button>
            )}
          </div>
        )}
      </RoutingRow>
    </div>
  );
}
export default () =>
  forms.map(({ name, status }) => (
    <Frame name={name} width={name === "actionable-inline" ? undefined : 520}>
      <RequestRouting
        status={status}
        inline={name === "actionable-inline"}
        resumeLabel={name === "passive" ? undefined : actions.resume}
        handoffLabel={actions.handoff}
      />
    </Frame>
  ));
