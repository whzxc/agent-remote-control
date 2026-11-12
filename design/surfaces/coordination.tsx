import { Frame } from "adg";
import { CoordinationBoard } from "../modules/board";
import { boardFrames, boardCopy } from "../fixtures/board";

export default () =>
  boardFrames.map(({ name, fixture, viewport, clicks }) => (
    <Frame
      name={name} width={1280} height={Number(viewport.split("x")[1])}
      fixture={fixture}
      capture={{ region: boardCopy.title, viewport, ...(clicks ? { clicks } : {}) }}
      note={name === "current" ? boardCopy.notes.current : name === "unavailable" ? boardCopy.notes.unavailable : undefined}
    >
      <CoordinationBoard form={name} />
    </Frame>
  ));
