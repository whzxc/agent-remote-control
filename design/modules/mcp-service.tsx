import type { ReactNode } from "react";
import { Frame } from "adg";
import { LocaleProvider } from "@/i18n/react";
import { McpPromptView as UiPrompt } from "@/mcp/McpControlsView";
import {
  McpHubActionsView,
  McpHubStatsView,
  McpHubView,
} from "@/mcp/McpHubView";
import {
  McpServiceCardView,
  McpServiceFailureView,
} from "@/mcp/McpServiceCardView";
import { IconButton } from "../components/icon-button";
import { Panel } from "../components/panel";
import { promptExample } from "../fixtures/feedback";
import { copy, services, tools } from "../fixtures/mcp-service";

export function ServiceInventory({
  children,
  variant = "server",
  className: extra,
}: {
  children: ReactNode;
  variant?: "server" | "tool" | "import";
  className?: string;
}) {
  const defaults = {
    server: "rounded-kit-card border border-border bg-surface-subtle/60 p-4 text-text",
    tool: "text-meta leading-[14px] text-text-secondary",
    import: "text-small text-text-secondary",
  };
  return <div className={extra ?? defaults[variant]}>{children}</div>;
}

const sampleTools = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  readOnly: tool.kind === "只读",
  destructive: tool.kind === "破坏性",
}));

export function McpService({
  service,
  failed,
  expanded,
}: {
  service: (typeof services)[keyof typeof services];
  failed: boolean;
  expanded: boolean;
}) {
  const error = failed && "error" in service ? service.error : undefined;
  const off = service.title === "archive";
  return (
    <LocaleProvider locale="zh-CN">
      <McpServiceCardView
        name={service.title}
        transport={service.icon === "globe" ? "http" : "stdio"}
        transportLabel={service.transport}
        target={service.address}
        state={off ? "disabled" : error ? "failed" : "ready"}
        statusLabel={service.status || undefined}
        enabled={!off}
        toolCount={service.count}
        tools={expanded ? sampleTools : []}
        expanded={expanded}
        facts={service.meta ? [service.meta] : []}
        checkedLabel={service.checked || undefined}
        failure={
          error
            ? {
                title: error.title,
                detail: error.detail,
                code: error.code,
              }
            : undefined
        }
      />
    </LocaleProvider>
  );
}

export function McpHub({
  form,
  workspace = false,
}: {
  form: string;
  workspace?: boolean;
}) {
  const empty = form === "empty";
  const failed = form === "failed";
  const list = failed
    ? [services.docs, services.notes, services.index, services.archive]
    : [services.docs, services.notes, services.archive];

  return (
    <LocaleProvider locale="zh-CN">
      <Panel
        viewportHeight={workspace ? 1200 : undefined}
        title={copy.text3}
        actions={
          empty ? (
            <IconButton icon="maximize-2" label={copy.text4} />
          ) : (
            <>
              <McpHubActionsView />
              <IconButton icon="maximize-2" label={copy.text7} />
            </>
          )
        }
        headerNavigation={
          !empty && (
            <McpHubStatsView
              summary={
                failed
                  ? { total: 4, available: 1, failed: 2, tools: 2 }
                  : { total: 3, available: 2, failed: 0, tools: 5 }
              }
            />
          )
        }
      >
        <McpHubView
          loaded
          hasServers={!empty}
          visibleCount={empty ? 0 : list.length}
          query=""
        >
          {list.map((service) => (
            <McpService
              key={service.title}
              service={service}
              failed={failed}
              expanded={!failed && service.title === "docs"}
            />
          ))}
        </McpHubView>
      </Panel>
    </LocaleProvider>
  );
}

export function McpFailure({
  error,
}: {
  error: { title: string; detail: string; code: string };
}) {
  return (
    <LocaleProvider locale="zh-CN">
      <McpServiceFailureView
        title={error.title}
        detail={error.detail}
        errorCode={error.code}
      />
    </LocaleProvider>
  );
}

export function McpImportPrompt({
  className: extra = "",
}: {
  className?: string;
}) {
  return (
    <LocaleProvider locale="zh-CN">
      <UiPrompt
        layout="stacked"
        className={extra}
        label={copy.text17}
        text={`${copy.text18}${copy.text19}`}
      />
    </LocaleProvider>
  );
}

export function Prompt({
  text,
  label,
  context,
  actionBelow = false,
  layout = "inline",
  className: extra = "",
}: {
  text: ReactNode;
  label: string;
  context?: string;
  actionBelow?: boolean;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  return (
    <LocaleProvider locale="zh-CN">
      <UiPrompt
        text={text}
        label={label}
        context={context}
        actionBelow={actionBelow}
        layout={layout}
        className={extra}
      />
    </LocaleProvider>
  );
}

const mcp_serviceFrames = () => [
  <Frame key="mcp-service-expanded" name="mcp-service-expanded" width={912}>
    <div className="w-full bg-surface-raised">
      <McpService service={services.docs} failed={false} expanded />
    </div>
  </Frame>,
  <Frame key="mcp-service-http-failed" name="mcp-service-http-failed" width={912}>
    <div className="w-full bg-surface-raised">
      <McpService service={services.docs} failed expanded={false} />
    </div>
  </Frame>,
  <Frame key="mcp-service-command-failed" name="mcp-service-command-failed" width={912}>
    <div className="w-full bg-surface-raised">
      <McpService service={services.index} failed expanded={false} />
    </div>
  </Frame>,
  <Frame key="mcp-service-off" name="mcp-service-off" width={912}>
    <div className="w-full bg-surface-raised">
      <McpService service={services.archive} failed={false} expanded={false} />
    </div>
  </Frame>,
  <Frame key="mcp-import-prompt" name="mcp-import-prompt" width={520}>
    <div className="w-full bg-surface-raised">
      <McpImportPrompt />
    </div>
  </Frame>,
];

const promptFrames = () => (
  <Frame key="prompt-default" name="prompt-default" width={520}>
    <Prompt {...promptExample} />
  </Frame>
);

export default () => [...mcp_serviceFrames(), promptFrames()];
