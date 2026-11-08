
import { PetsLibrary } from '../modules/pets';
import { Frame } from "sdg";
import { Panel } from "../components/panel";

import { IconButton } from "../components/icon-button";









export default () => (
  <Frame
    name="library"
    fixture="pets-settings"
    capture={{ region: "Pets", viewport: "1280x800" }}
    note="Pet atlas labels are decorative image content inside aria-hidden previews."
  >
    <Panel
      width={960}
      title="Pets"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <PetsLibrary  />
    </Panel>
  </Frame>
);
