import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Card, PermissionCard } from "../components/card";
import { Button } from "../components/button";
import { Input } from "../components/field";
import { SingleChoice } from "../components/single-choice";
import { IconButton } from "../components/icon-button";
import { EffortSlider } from "../components/effort-slider";
const options = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];
const models = ["跟随任务", "GPT-6.1 Sol", "GPT-5.6 Sol"];
function RequestSheet({ question = false }: { question?: boolean }) {
  return (
    <PanelShell width={360} class="px-6 pt-4 pb-6">
      <PanelHeader title="待处理请求" />
      <p class="mt-[3px] text-meta leading-4 text-text-tertiary">
        将在控制源下次检查时处理
      </p>
      <div class="mt-[19px]">
        {question ? (
          <Card padded class="gap-4">
            <strong class="text-body leading-[14px] font-semibold">
              Choose an option
            </strong>
            <SingleChoice
              value=""
              options={options}
              label="Answer"
              optionCards
              class="[&_button]:text-text"
            />
            <div class="flex flex-col gap-2">
              <label class="text-small leading-4 text-text font-semibold">
                其他
              </label>
              <Input />
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost">跳过</Button>
              <Button variant="primary" disabled class="opacity-42 px-[30px]">
                发送回答
              </Button>
            </div>
          </Card>
        ) : (
          <PermissionCard />
        )}
      </div>
    </PanelShell>
  );
}
function ModelEffort() {
  return (
    <div class="w-[564px] pb-0">
      <PanelShell width={440} class="px-6 pt-4 pb-6">
        <PanelHeader title="本任务模型" />
        <p class="mt-[3px] text-small leading-5 text-text-secondary">
          派发方后续发送且未指定模型时生效，
          <br />
          不影响正在运行的这一轮。
        </p>
        <div class="mt-[18px] flex items-center gap-6">
          <span class="text-small leading-4 font-semibold">模型与推理强度</span>
          <SingleChoice
            value="follow"
            options={[{ value: "follow", label: "跟随任务" }]}
            label="Model and effort"
            dropdown
            class="gap-[18px]"
          />
        </div>
      </PanelShell>
      <div class="-mt-4 ml-6 flex items-start gap-2">
        <PanelShell width={312} class="p-4">
          <div class="flex items-center gap-[18px]">
            <div class="flex-1">
              <SingleChoice
                value="follow"
                options={[{ value: "follow", label: "跟随任务" }]}
                label="Default model"
                dropdown
                fill
                dropdownIcon="chevron-right"
              />
            </div>
            <IconButton icon="rotate-ccw" compact label="Reset model" />
          </div>
          <div class="mt-5 text-meta leading-4 font-semibold">跟随任务</div>
          <div class="mt-[10px]">
            <EffortSlider
              steps={["inherit", "low", "medium", "high", "max"]}
              value={0}
              label="Reasoning effort"
              valueText=""
              disabled
            />
          </div>
        </PanelShell>
        <PanelShell width={220} class="mt-4 pt-4 pb-[6px] px-4 gap-[9px]">
          <h3 class="text-meta leading-4 text-text-secondary">选择模型</h3>
          <div class="flex flex-col">
            {models.map((model, i) => (
              <div class="flex h-[39px] items-center justify-between text-small">
                <span>{model}</span>
                {i === 0 && <Icon name="check" size={14} />}
              </div>
            ))}
          </div>
        </PanelShell>
      </div>
    </div>
  );
}
export default () => [
  <Frame
    name="permission"
    fixture="approval-permission"
    capture={{
      selector: '.dialog[data-sheet="true"]',
      viewport: "510x844",
      clicks: ["打开"],
    }}
    note="Prepared task in the adapter. Width drift: asset 360px, implementation 332px. A wider host switches to the inline request; permission has no Open control at 525x844."
  >
    <RequestSheet />
  </Frame>,
  <Frame
    name="question"
    fixture="approval-question"
    capture={{
      selector: '.dialog[data-sheet="true"]',
      viewport: "525x844",
      clicks: ["打开"],
    }}
    note="Prepared task in the adapter. Width drift: asset 360px, implementation 330px. A wider host switches to the inline request."
  >
    <RequestSheet question />
  </Frame>,
  <Frame
    name="model-effort"
    fixture="timeline-multi-turn"
    capture={{
      selector: ".dialog:has(.task-dispatch-fields)",
      viewport: "1280x800",
      clicks: ["本任务模型", "模型与推理强度", "默认模型: 跟随任务"],
    }}
    note="Explicit hidden target: the portaled picker makes the underlying dialog aria-hidden. The portal menu lies outside the dialog capture; review it on the overlay."
  >
    <ModelEffort />
  </Frame>,
];
