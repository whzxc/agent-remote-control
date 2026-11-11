import { Frame } from "adg";
import { AXBoard } from "../modules/ax";
import { axForms, axClosedEntries, axCopy } from "../fixtures/ax";

export default () => axForms.map(form => <Frame
  name={form}
  fixture="coordination-ax-light"
  capture={{
    region: axCopy.region,
    viewport: "1280x1000",
    clicks: [axCopy.openBoard, "AX", ...(form === "open" ? [] : [axCopy.closedFilter]),
      ...(form === "detail" ? [axClosedEntries[0].title] : [])],
  }}
  note={form === "detail" ? axCopy.detailNote : axCopy.note}
>
  <AXBoard form={form} />
</Frame>);
