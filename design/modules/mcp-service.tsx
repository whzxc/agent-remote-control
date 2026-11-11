import { copy } from '../fixtures/mcp-service';
import { Frame, Icon } from "adg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { SearchInput } from "../components/search";
import { Tile } from "../components/tile";
import { Switch } from "../components/switch";
import { SingleChoice } from "../components/single-choice";
import { Tag, Disclosure } from "../components/tag";
import { services, tools, agents } from "../fixtures/mcp-service";
import { Notice } from "../components/notice";
import { Prompt } from "../components/prompt";
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
            <span>{service.transport}{copy.text1}</span>
            <code class="font-mono">{service.address}</code>
          </div>
        </div>
        {!error && (
          <span
            class={`flex items-center gap-1 rounded-field px-[9px] py-1 text-meta leading-4 font-semibold
              ${off ? "bg-text-tertiary/10 text-text-tertiary opacity-55" : "bg-success/15 text-success"}`}
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
            <Disclosure expanded={expanded}>{service.count}{copy.text2}</Disclosure>
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
        <McpFailure error={error} />
      )}
    </article>
  );
}
export function McpHub({ form }: { form: string }) {
  const empty = form === "empty",
    failed = form === "failed";
  return (
    <PanelShell width={960} class="p-6">
      <PanelHeader
        title={copy.text3}
        actions={
          empty ? (
            <IconButton icon="maximize-2" label={copy.text4} />
          ) : (
            <>
              <Button variant="primary" icon="plus">{copy.text5}</Button>
              <IconButton icon="rotate-cw" label={copy.text6} />
              <IconButton icon="maximize-2" label={copy.text7} />
            </>
          )
        }
      >
        {!empty && (
          <span class="ml-[22px] text-meta text-text-secondary">
            {failed ? (
              <>{copy.text8}<span class="text-danger">{copy.text9}</span>{" "}{copy.text10}</>
            ) : (
              "3 个服务 · 2 个可用 · 5 个工具"
            )}
          </span>
        )}
      </PanelHeader>
      {empty ? (
        <div class="flex flex-col items-center pt-10">
          <Tile icon="plug" tone="neutral" />
          <h3 class="mt-4 text-title leading-6 font-[650]">{copy.text11}</h3>
          <p class="mt-3 text-small leading-4 text-text-secondary">{copy.text12}</p>
          <div class="mt-7">
            <SingleChoice
              value={copy.text13}
              options={agents}
              label={copy.text14}
              class="gap-1"
            />
          </div>
          <McpImportPrompt class="mt-5 w-[520px]" />
        </div>
      ) : (
        <>
          <div class="mt-6">
            <SearchInput placeholder={copy.text15} />
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
              <McpService
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

export function McpFailure({ error }: { error: { title: string; detail: string; code: string } }) {
  return <Notice layout="stacked" class="ml-[52px] mt-5" title={error.title}
    action={<Button icon="copy">{copy.text16}</Button>}>
    <p class="text-small leading-4">{error.detail}</p>
    <code class="mt-[2px] text-caption leading-4 font-mono text-text-secondary">{error.code}</code>
  </Notice>;
}

export function McpImportPrompt({ class: extra = "" }: { class?: string }) {
  return <Prompt layout="stacked" class={extra} label={copy.text17} text={<>{copy.text18}<br />{copy.text19}</>} />;
}
export default () => [
  <Frame name="mcp-service-expanded" width={912}>
    <div class="w-full bg-surface-raised"><McpService service={services.docs} failed={false} expanded /></div>
  </Frame>,
  <Frame name="mcp-service-http-failed" width={912}>
    <div class="w-full bg-surface-raised"><McpService service={services.docs} failed expanded={false} /></div>
  </Frame>,
  <Frame name="mcp-service-command-failed" width={912}>
    <div class="w-full bg-surface-raised"><McpService service={services.index} failed expanded={false} /></div>
  </Frame>,
  <Frame name="mcp-service-off" width={912}>
    <div class="w-full bg-surface-raised"><McpService service={services.archive} failed={false} expanded={false} /></div>
  </Frame>,
  <Frame name="mcp-import-prompt" width={520}>
    <div class="w-full bg-surface-raised"><McpImportPrompt /></div>
  </Frame>,
];
