import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
export default () => (
  <Frame
    name="empty"
    fixture="relay-hosting-light"
    capture={{ region: "Relay hosting", viewport: "1280x800" }}
  >
    <Panel
      width={760}
      title="Relay hosting"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <div class="flex flex-col items-start gap-5 pt-[6px]">
        <div class="flex flex-col gap-3">
          <h3 class="text-body leading-4 font-[650]">Hosted relays</h3>
          <p class="text-body leading-4 text-text-secondary">
            You have not deployed a relay yet.
          </p>
        </div>
        <Button class="w-[186px]">Deploy new relay</Button>
      </div>
    </Panel>
  </Frame>
);
