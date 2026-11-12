
import { PetsLibrary } from '../modules/pets';
import { Frame } from "adg";
import { Panel } from "../components/panel";

import { IconButton } from "../components/icon-button";









export default () => (
  <Frame

    name="library"
    fixture="pets-settings"
    capture={{ selector: ".layer-panel", viewport: "1280x800" }}
    note="Pet atlas labels are decorative image content inside aria-hidden previews."
  >
    <Panel viewportHeight={800}
      title="Pets"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <PetsLibrary  />
    </Panel>
  </Frame>
);
