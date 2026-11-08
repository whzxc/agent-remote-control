import { Frame } from "sdg";
import { CoordinationBoard } from "../modules/board";
import { boardFrames, boardCopy } from "../fixtures/board";

export default () =>
  boardFrames.map(({ name, fixture, viewport, clicks, height }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{ region: boardCopy.title, viewport, ...(clicks ? { clicks } : {}) }}
      note={name === "current" ? boardCopy.notes.current : name === "unavailable" ? boardCopy.notes.unavailable : undefined}
    >
      <CoordinationBoard form={name} height={height} />
    </Frame>
  ));
