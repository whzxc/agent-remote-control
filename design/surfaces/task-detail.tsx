import { Frame } from "sdg";
import { TaskTimeline } from "../modules/timeline";
import { timelineForms } from "../fixtures/timeline";

export default () =>
  timelineForms.map(({ name, fixture }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{
        selector: ".dialog:has(.task-detail-layer)",
        viewport: "1280x1100",
      }}
      note={
        "The implementation shell follows topology panel geometry; its width is not fixed to the " +
        "drawing's 640px. failed-turn uses task preparation in the adapter."
      }
    >
      <TaskTimeline form={name} />
    </Frame>
  ));
