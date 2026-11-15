import { Frame, Icon } from 'adg';
import { Button } from './button';
import { Card } from './card';
import { permissionExample, routingForms, routingActions } from '../fixtures/request';


export function PermissionActions({ sheet = false }: { sheet?: boolean } = {}) {
  return (
      <div class="flex justify-end gap-2">
        <Button>{permissionExample.deny}</Button>
        <Button disabled class="opacity-42">
          {permissionExample.bypass}
        </Button>
        <Button variant="primary" class={sheet ? "px-4" : "px-5"}>
          {permissionExample.approve}
        </Button>
      </div>
  );
}


export function PermissionCard({
  title = permissionExample.title,
  scope = permissionExample.scope,
  command = permissionExample.command,
  sheet = false,
}: { title?: string; scope?: string; command?: string; sheet?: boolean } = {}) {
  return (
    <Card padded class="gap-4">
      <div class="flex flex-col gap-1">
        <strong class={`text-body ${sheet ? "leading-[18px]" : "leading-4"} font-semibold`}>
          {title}
        </strong>
        <span class={`text-meta ${sheet ? "leading-4" : "leading-3"} text-text-secondary`}>
          {scope}
        </span>
      </div>
      <pre class="flex h-11 items-center rounded-field bg-surface-sunken px-[14px] text-meta font-mono">
        {command}
      </pre>
      {!sheet && <PermissionActions />}
    </Card>
  );
}


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

export default () => [
  ...routingForms.map(({ name, status }) => (
    <Frame name={`request-routing-${name}`} width={name === "actionable-inline" ? undefined : 520}>
      <RequestRouting
        status={status}
        inline={name === "actionable-inline"}
        resumeLabel={name === "passive" ? undefined : routingActions.resume}
        handoffLabel={routingActions.handoff}
      />
    </Frame>
  )),
  <Frame name="permission-card" width={312}>
    <div class="w-full bg-surface-raised"><PermissionCard /></div>
  </Frame>,
  <Frame name="routing-row" width={239}>
    <RoutingRow inline={false}><span class="leading-7">{routingForms[0].status}</span></RoutingRow>
  </Frame>,
];
