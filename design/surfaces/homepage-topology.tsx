import { Frame } from "adg";
import { TopologyScreen } from "../components/topology-scene";
import { scenes } from "../fixtures/topology";
export default () => (
  <Frame name="empty" width={1280} height={800} fixture="connections-empty@light"
    capture={{ page: true, origin: "0 0", viewport: "1280x800" }}>
    <TopologyScreen width={1280} height={800} scene={scenes["empty-empty"]} />
  </Frame>
);
