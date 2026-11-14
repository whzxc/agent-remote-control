import { Frame } from "adg";
import { TaskTimeline, RelayTimeline } from "../modules/timeline";
import { timelineForms, relayForms } from "../fixtures/timeline";

export default () => [
  ...timelineForms.map(({ name, fixture }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{
        selector: ".dialog:has(.task-detail-layer)",
        viewport: "1280x1100",
      }}
      note={
        "The task uses the fixed M right slot with a scrolling body at the viewport cap. failed-turn uses task preparation in the adapter."
      }
    >
      <TaskTimeline form={name} />
    </Frame>
  )),
  ...relayForms.map(({ name, state }) => (
    <Frame
      name={name}
      note={"Proposed. Relay grammar: controller messages carry a source edge and route, executor work is a flat rail, " +
        "the reply is addressed back to the controller and the live plan is pinned to the footer."}
    >
      <RelayTimeline state={state} />
    </Frame>
  )),
];
