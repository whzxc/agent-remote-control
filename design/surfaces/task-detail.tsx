import { Frame } from "adg";
import { RelayTimeline } from "../modules/timeline";
import { relayForms } from "../fixtures/timeline";

import { EmptyTaskBody } from "../modules/tasks";

const existing = () => relayForms.map(({ name, state }) => (
  <Frame name={name} fixture={name} capture={{ selector: ".dialog:has(.task-detail-layer)", viewport: "1280x1100" }}>
    <RelayTimeline state={state} />
  </Frame>
));

export default () => [
  ...existing(),
  <Frame name="task-detail-empty-body" width={512} locale="zh-CN" fixture="task-detail-empty-body" capture={{ selector: '.timeline-entries > .task-empty-body', viewport: '1040x720' }}>
    <div className="flex h-[256px] w-full bg-surface-raised"><EmptyTaskBody state="empty" detail /></div>
  </Frame>,
];
