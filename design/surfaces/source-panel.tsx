import { Frame, Icon } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import SourceArt from "../art/source.svg";
import { Tile, type TileTone } from "../components/tile";
const dispatches = [
  {
    title: "需要你处理",
    rows: [
      [
        "Review the example change",
        "codex · 等待输入",
        "warning",
        "shield-alert",
      ],
    ],
  },
  {
    title: "运行中",
    rows: [
      ["Update example documentation", "codex · 运行中", "thinking", "brain"],
      ["Review example tests", "claude · 运行中", "thinking", "brain"],
    ],
  },
];
const history = [
  {
    title: "Needs your attention",
    rows: [
      [
        "Submission awaiting-approval",
        "codex · Awaiting dispatch approval",
        "warning",
        "shield-alert",
      ],
    ],
  },
  {
    title: "Running",
    rows: [["Current running dispatch", "codex · Running", "file", "pencil"]],
  },
  {
    title: "Unread",
    rows: [
      ["Completed dispatch", "codex · Done", "success", "check"],
      ["Failed execution", "codex · Failed", "danger", "circle-alert"],
      [
        "Interrupted execution",
        "codex · Interrupted",
        "neutral",
        "circle-pause",
      ],
    ],
  },
  {
    title: "Today",
    rows: [
      ["Submission reserved", "codex · Submitting", "neutral", "circle"],
      ["Submission not-executed", "codex · Not executed", "neutral", "circle"],
      [
        "Submission unconfirmed",
        "codex · Submission unconfirmed",
        "warning",
        "circle",
      ],
      [
        "Submission failed",
        "codex · Submission failed",
        "danger",
        "circle-alert",
      ],
    ],
  },
  {
    title: "Yesterday",
    rows: [["Earlier completed dispatch", "codex · Done", "success", "check"]],
  },
];
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
        <div class="mt-7 flex flex-col gap-4">
          {(form === "history" ? history : dispatches).map(
            (group, groupIndex) => (
              <section class="flex flex-col gap-2">
                <h3
                  class={`flex gap-[10px] text-meta leading-4 font-semibold ${group.title === "需要你处理" || group.title === "Needs your attention" ? "text-warning" : "text-text-secondary"}`}
                >
                  {group.title}
                  <span class="text-text-tertiary">{group.rows.length}</span>
                </h3>
                {group.rows.map(([title, meta, tone, icon]) => (
                  <article
                    class={`flex h-16 items-start gap-3 rounded-card p-3 ${groupIndex === 0 ? "bg-warning/10" : "bg-surface-subtle"}`}
                  >
                    <Tile form="phase" tone={tone as TileTone} icon={icon} />
                    <div class="flex flex-1 flex-col gap-[3px]">
                      <strong class="text-small leading-4 font-[650]">
                        {title}
                      </strong>
                      <span
                        class={`text-meta leading-4 font-medium ${{ warning: "text-warning", thinking: "text-phase-thinking", file: "text-phase-file", success: "text-success", danger: "text-danger", neutral: "text-text-tertiary" }[tone]}`}
                      >
                        {meta}
                      </span>
                    </div>
                    {(form === "dispatches" ||
                      !title.startsWith("Submission")) && (
                      <Icon
                        name="chevron-right"
                        size={16}
                        class="self-center text-text-tertiary"
                      />
                    )}
                  </article>
                ))}
              </section>
            ),
          )}
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
