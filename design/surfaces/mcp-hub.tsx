import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { SearchInput } from "../components/search";
import { Tile } from "../components/tile";
import { Switch } from "../components/switch";
import { SingleChoice } from "../components/single-choice";
import { Tag, Disclosure } from "../components/tag";
const services = {
  docs: {
    title: "docs",
    transport: "Streamable HTTP",
    address: "https://tools.example/mcp",
    status: "已连接",
    count: 3,
    meta: "请求头：Authorization · 由 Claude 添加 · 刚刚检查",
    icon: "globe",
    error: {
      title: "需要凭据",
      detail: "服务拒绝了 ARC 的请求。Agent 可以补充所需的请求头。",
      code: "MCP_HTTP_401: Set the required Authorization or custom headers with mcp_configure update",
    },
  },
  notes: {
    title: "notes",
    transport: "本地命令",
    address: "notes-mcp",
    status: "可用",
    count: 2,
    meta: "环境变量：NOTES_TOKEN · 从 Codex 导入 · 18分钟前检查",
    icon: "terminal",
  },
  index: {
    title: "local-index",
    transport: "本地命令",
    address: "index-mcp",
    status: "",
    meta: "本机添加 · 刚刚检查",
    count: 0,
    icon: "terminal",
    error: {
      title: "命令未能启动",
      detail: "确认命令已安装，并且位于 ARC 的搜索路径中。",
      code: "MCP_COMMAND_NOT_FOUND: index-mcp was not found on ARC's Agent search path",
    },
  },
  archive: {
    title: "archive",
    transport: "本地命令",
    address: "/opt/example/bin/archive-mcp",
    status: "已关闭",
    count: 0,
    meta: "",
    icon: "terminal",
  },
};
const tools = [
  {
    name: "search_docs",
    kind: "只读",
    description: "Search the sample documentation index",
  },
  {
    name: "read_page",
    kind: "只读",
    description: "Read one documentation page by path",
  },
  {
    name: "publish_page",
    kind: "破坏性",
    description: "Publish a reviewed draft to the sample documentation site",
  },
];
const agents = ["Codex", "Claude Code", "Cursor", "Gemini CLI"].map(
  (label) => ({ value: label, label }),
);
function Service({
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
    <article class="flex flex-col rounded-card bg-surface-subtle p-4">
      <div class="flex items-center gap-3">
        <span class={off ? "opacity-45" : ""}>
          <Tile
            icon={service.icon}
            tone={service.icon === "terminal" ? "file" : "command"}
          />
        </span>
        <div
          class={`flex min-w-0 flex-1 flex-col gap-[3px] ${off ? "opacity-45" : ""}`}
        >
          <strong class="text-body leading-[18px] font-[650]">
            {service.title}
          </strong>
          <div class="flex gap-1 text-meta leading-4 text-text-secondary">
            <span>{service.transport} · </span>
            <code class="font-mono">{service.address}</code>
          </div>
        </div>
        {!error && (
          <span
            class={`flex items-center gap-1 rounded-field px-[9px] py-1 text-meta leading-4 font-semibold ${off ? "bg-text-tertiary/10 text-text-tertiary opacity-55" : "bg-success/15 text-success"}`}
          >
            <span class="size-[6px] rounded-full bg-current" />
            {service.status}
          </span>
        )}
        <div class="flex items-center gap-0">
          <IconButton
            icon="rotate-cw"
            label={`Refresh ${service.title}`}
            disabled={off}
          />
          <IconButton icon="trash" label={`Delete ${service.title}`} />
          <span class="ml-3">
            <Switch checked={!off} label={`${service.title} enabled`} />
          </span>
        </div>
      </div>
      {service.meta && (
        <div
          class={`ml-[52px] ${error ? "mt-4" : "mt-3"} flex items-center gap-3 text-meta leading-4 text-text-secondary`}
        >
          {!error && (
            <Disclosure expanded={expanded}>{service.count} 个工具</Disclosure>
          )}
          <span>{service.meta}</span>
        </div>
      )}
      {expanded && (
        <div class="ml-[52px] mt-[10px] rounded-field bg-surface">
          {tools.map((tool) => (
            <div class="flex flex-col gap-1 mx-[14px] py-[9px] border-b border-border last:border-0 last:pb-[7px]">
              <div class="flex items-center gap-2">
                <code class="text-small leading-4 font-mono font-medium">
                  {tool.name}
                </code>
                <Tag form={tool.kind === "破坏性" ? "danger" : "meta"}>
                  {tool.kind}
                </Tag>
              </div>
              <p class="text-meta leading-[14px] text-text-secondary">
                {tool.description}
              </p>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div class="ml-[52px] mt-5 flex flex-col gap-1 rounded-[14px] bg-danger/10 p-4">
          <strong class="text-small leading-4 text-danger">
            {error.title}
          </strong>
          <p class="text-small leading-4">{error.detail}</p>
          <code class="mt-[2px] text-caption leading-4 font-mono text-text-secondary">
            {error.code}
          </code>
          <div class="mt-2">
            <Button icon="copy">复制修复提示词</Button>
          </div>
        </div>
      )}
    </article>
  );
}
function McpHub({ form }: { form: string }) {
  const empty = form === "empty",
    failed = form === "failed";
  return (
    <PanelShell width={960} class="p-6">
      <PanelHeader
        title="MCP 中枢"
        actions={
          empty ? (
            <IconButton icon="maximize-2" label="Expand" />
          ) : (
            <>
              <Button variant="primary" icon="plus">
                添加服务
              </Button>
              <IconButton icon="rotate-cw" label="Refresh" />
              <IconButton icon="maximize-2" label="Expand" />
            </>
          )
        }
      >
        {!empty && (
          <span class="ml-[22px] text-meta text-text-secondary">
            {failed ? (
              <>
                4 个服务 · 1 个可用 · <span class="text-danger">2 个异常</span>{" "}
                · 2 个工具
              </>
            ) : (
              "3 个服务 · 2 个可用 · 5 个工具"
            )}
          </span>
        )}
      </PanelHeader>
      {empty ? (
        <div class="flex flex-col items-center pt-10">
          <Tile icon="plug" tone="neutral" />
          <h3 class="mt-4 text-title leading-6 font-[650]">
            一次连接 MCP 服务
          </h3>
          <p class="mt-3 text-small leading-4 text-text-secondary">
            连接到 ARC 的所有控制源都能使用它们的工具。
          </p>
          <div class="mt-7">
            <SingleChoice
              value="Codex"
              options={agents}
              label="Import from Agent"
              class="gap-1"
            />
          </div>
          <div class="mt-5 flex w-[520px] flex-col gap-4 rounded-card bg-surface-subtle p-4">
            <p class="text-small leading-5">
              把我现有的 Codex MCP 服务导入 ARC 的 MCP 中枢，然后
              <br />
              列出它们的工具，并告诉我哪些服务连接失败。
            </p>
            <div>
              <Button icon="copy">复制提示词</Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div class="mt-6">
            <SearchInput placeholder="搜索服务和工具" />
          </div>
          <div class="mt-6 flex flex-col gap-4">
            {(failed
              ? [
                  services.docs,
                  services.notes,
                  services.index,
                  services.archive,
                ]
              : [services.docs, services.notes, services.archive]
            ).map((service) => (
              <Service
                service={service}
                failed={failed}
                expanded={!failed && service.title === "docs"}
              />
            ))}
          </div>
        </>
      )}
    </PanelShell>
  );
}
export default () =>
  ["ready", "failed", "empty"].map((name) => (
    <Frame
      name={name}
      fixture={`mcp-hub-${name}-dark`}
      capture={{ region: "MCP 中枢", viewport: "1280x1200" }}
      note="The implementation uses full workspace height. Its shell follows the viewport; the older content-fit heights (662, 912 and 432px) are not capture-size requirements."
    >
      <McpHub form={name} />
    </Frame>
  ));
