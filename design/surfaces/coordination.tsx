import { Frame } from "adg";
import { CoordinationBoard } from "../modules/board";
import { boardFrames, boardCopy } from "../fixtures/board";

export default () =>
  boardFrames.map(({ name, fixture, viewportHeight, clicks }) => (
    <Frame
      name={name}
      width={name === "current" ? 1280 : 992}
      fixture={fixture}
      capture={{ selector: ".layer-panel", viewport: `1280x${viewportHeight}`, ...(clicks ? { clicks } : {}) }}
      note={name === "current" ? boardCopy.notes.current : name === "unavailable" ? boardCopy.notes.unavailable : undefined}
    >
      <CoordinationBoard form={name} viewportHeight={viewportHeight} />
    </Frame>
  ));
