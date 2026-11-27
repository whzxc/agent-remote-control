import { Frame } from "adg";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/kit/button";
import { UpdateAboutView } from "@/components/updates/UpdateAboutView";
import { LocaleProvider } from "@/i18n/react";
import { Dialog, PanelHeader, PanelShell } from "../components/panel";
import { copy, frames, releases, targetVersion } from "../fixtures/updates";
import { UpdateContent, UpdateHistoryContent } from "../modules/updates";

export default () => [
  ...frames.map(({ name, fixture }) => (
    <Frame
      key={name}
      name={name}
      fixture={fixture}
      capture={{ region: "应用更新", viewport: "1280x800" }}
    >
      <PanelShell className="gap-3 p-5">
        <PanelHeader title={copy.title} close={false} />
        <UpdateContent state={name} />
      </PanelShell>
    </Frame>
  )),
  <Frame
    key="history"
    width={592}
    name="history"
    fixture="updates-history"
    capture={{
      region: copy.history,
      viewport: "1280x800",
      clicks: [copy.history],
    }}
  >
    <Dialog title={copy.history}>
      <UpdateHistoryContent entries={releases} />
    </Dialog>
  </Frame>,
  <Frame
    key="settings"
    name="settings"
    fixture="updates-settings"
    capture={{ selector: ".settings-about", viewport: "1280x800" }}
  >
    <div className="w-[672px] bg-surface-raised">
      <LocaleProvider locale="zh-CN">
        <UpdateAboutView
          currentVersion={targetVersion}
          checkLabel={copy.check}
          repositoryLabel={copy.repository}
          trailingNavSlot={
            <Button size="sm" variant="ghost">
              {copy.experimental}
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                absoluteStrokeWidth
                aria-hidden="true"
              />
            </Button>
          }
        />
      </LocaleProvider>
    </div>
  </Frame>,
];
