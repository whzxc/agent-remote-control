import { Frame } from "adg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { PermissionsContent } from "../modules/permissions";
import { permissionCopy } from "../fixtures/permissions";

export default () => <Frame name="readiness"  fixture="permissions@light"
  capture={{ selector: ".layer-panel", viewport: "1280x800" }}>
  <Panel viewportHeight={800} title={permissionCopy.permissionsTitle} actions={<>
    <IconButton icon="refresh-cw" label={permissionCopy.permissionsRefresh} /><IconButton icon="maximize-2" label="Expand" />
  </>}><PermissionsContent /></Panel>
</Frame>;
