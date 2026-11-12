import { Frame } from "adg";
import { AXBoard } from "../modules/ax";
import { axForms, axClosedEntries, axCopy } from "../fixtures/ax";

export default () => axForms.map(form => <Frame
  name={form} width={1280} height={1000}
  fixture={form === "open" ? "coordination-ax-light" : `board-ax-${form}`}
  capture={{
    region: axCopy.region,
    viewport: "1280x1000",
    clicks: form === "open" ? [axCopy.openBoard, "AX"] : form === "detail" ? [axClosedEntries[0].title] : [],
  }}
  note={form === "detail" ? axCopy.detailNote : form === "closed" ? "The closed filter retains the open list’s 602px content-fit shell height." : axCopy.note}
>
  <AXBoard form={form} />
</Frame>);
