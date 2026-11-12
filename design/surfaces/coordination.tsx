import { Frame } from "adg";
import { CoordinationBoard } from "../modules/board";
import { boardFrames, boardCopy } from "../fixtures/board";

export default () =>
  boardFrames.map(({ name, fixture, viewport, clicks }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{ selector: ".layer-panel", viewport, ...(clicks ? { clicks } : {}) }}
      note={name === "current" ? boardCopy.notes.current : name === "unavailable" ? boardCopy.notes.unavailable : undefined}
    >
      <CoordinationBoard form={name} />
    </Frame>
  ));
