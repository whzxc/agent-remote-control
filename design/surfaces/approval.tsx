import { Frame } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Card, PermissionCard } from "../components/card";
import { Button } from "../components/button";
import { Input } from "../components/field";
import { SingleChoice } from "../components/single-choice";
const options = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];
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
];
