import { Frame, Icon } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { Button } from "../components/button";
const changes = ["Improve connection stability.", "Fix task history loading."];
const frames = [
  { name: "available", fixture: "updates-available-panel" },
  { name: "installing", fixture: "updates-installing" },
] as const;
export default () => [
  ...frames.map(({ name, fixture }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{ region: "App updates", viewport: "1280x800" }}
    >
      <Panel width={520} title="New version 1.2.3">
        <div class="flex flex-col gap-6">
          <Card padded class="gap-2!">
            {changes.map((text) => (
              <p class="text-body leading-4">{text}</p>
            ))}
          </Card>
          <div class="flex items-center justify-between">
            <Button
              variant="ghost"
              disabled={name === "installing"}
              class={name === "installing" ? "opacity-45" : ""}
            >
              Skip this version
            </Button>
            <Button
              variant="primary"
              busy={name === "installing"}
              class="w-[220px]"
            >
              {name === "installing"
                ? "Installing and restarting…"
                : "Update and restart"}
            </Button>
          </div>
        </div>
      </Panel>
    </Frame>
  )),
  <Frame
    name="settings"
    note="Unavailable: no standalone About shell. updates-settings embeds AppUpdate in SettingsPage; neither .settings-about nor its .page-sheet ancestor matches this standalone 720×258 panel."
  >
    <Panel width={720} headerless>
      <div class="flex flex-col gap-3 pt-[9px]">
        <h2 class="text-small leading-4 font-[650] text-text-secondary">
          About
        </h2>
        <Card padded class="gap-4!">
          <div class="flex flex-col gap-[6px]">
            <p class="text-body leading-4 font-medium">
              Agent Remote Control vfixture
            </p>
            <p class="text-meta leading-4 text-text-secondary">
              New version 1.2.3
            </p>
          </div>
          <div class="flex gap-4">
            <Button disabled class="opacity-45">
              Check for updates
            </Button>
            <Button>View update</Button>
          </div>
        </Card>
        <div class="flex items-center gap-3 px-4 pt-[18px]">
          <span class="text-meta text-text-secondary">
            whzxc/agent-remote-control
          </span>
          <Button variant="ghost">
            GitHub <Icon name="external-link" />
          </Button>
          <Button variant="ghost">
            Experimental <Icon name="chevron-right" />
          </Button>
        </div>
      </div>
    </Panel>
  </Frame>,
];
