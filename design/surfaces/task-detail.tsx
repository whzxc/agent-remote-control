import { Frame } from "adg";
import { RelayTimeline } from "../modules/timeline";
import { relayForms } from "../fixtures/timeline";

export default () => relayForms.map(({ name, state }) => (
  <Frame name={name} fixture={name} capture={{ selector: ".dialog:has(.task-detail-layer)", viewport: "1280x1100" }}>
    <RelayTimeline state={state} />
  </Frame>
));
