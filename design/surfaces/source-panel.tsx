import { Frame } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import SourceArt from "../art/source.svg";
import { SourceTaskGroups } from "../modules/source-activity";
const facts = [
  [
    { label: "产品", value: "Ranoat" },
    { label: "连接", value: "Ranoat" },
    { label: "添加时间", value: "nrresnor nrrnrrnr" },
  ],
  [
    { label: "授权时间", value: "htaathro ooshsoor" },
    { label: "最近活动", value: "htaathro ooshsoor" },
  ],
];
function SourcePanel({
  form,
}: {
  form: "dispatches" | "history" | "platform";
}) {
  const platform = form === "platform";
  return (
    <PanelShell width={480} height={form === "history" ? 968 : 560} class="p-5">
      <header class="flex h-9 items-center gap-4">
        <BrandMark brand="anthropic" size={36} />
        <h2 class="flex-1 text-title font-[650]">
          {platform ? "Anthropic" : "Claude"}
        </h2>
        <div class="flex gap-[6px]">
          <IconButton icon="maximize-2" label="Expand" />
          <IconButton icon="x" label="Close" />
        </div>
      </header>
      {platform ? (
        <article class="mt-7 flex flex-col gap-3 rounded-card bg-surface-subtle p-4">
          <header class="flex items-center gap-4">
            <SourceArt
              data-brand
              width={24}
              height={24}
              class="text-role-source"
            />
            <strong class="text-body leading-5 font-[650]">Claude</strong>
            <span class="-ml-2 text-meta text-success">· 已连接</span>
            <span class="ml-auto flex gap-3">
              <IconButton compact icon="pencil" label="Edit Claude" />
              <IconButton compact icon="trash-2" label="Delete Claude" />
            </span>
          </header>
          {facts.map((row) => (
            <div class="flex items-center gap-2 text-meta leading-4 text-text-secondary">
              {row.map((fact, i) => (
                <>
                  <span>
                    {i > 0 ? "· " : ""}
                    {fact.label}
                  </span>
                  <span class="blur-[3px]">{fact.value}</span>
                </>
              ))}
            </div>
          ))}
        </article>
      ) : (
        <div class="mt-7">
          <SourceTaskGroups history={form === "history"} />
        </div>
      )}
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="dispatches"
    fixture="source-panel"
    capture={{ region: "Claude", viewport: "1280x800" }}
  >
    <SourcePanel form="dispatches" />
  </Frame>,
  <Frame
    name="history"
    fixture="dispatch-states"
    capture={{ region: "Claude", viewport: "1280x1200" }}
    note="Full-content drawing exceeds the scroll viewport; inspect remaining scroll content during browser acceptance."
  >
    <SourcePanel form="history" />
  </Frame>,
  <Frame
    name="platform"
    fixture="source-panel"
    capture={{
      region: "Anthropic",
      viewport: "1280x800",
      clicks: ["Anthropic"],
    }}
  >
    <SourcePanel form="platform" />
  </Frame>,
];
