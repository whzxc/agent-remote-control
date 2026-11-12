import { Frame } from "adg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { PermissionsContent } from "../modules/permissions";
import { permissionCopy } from "../fixtures/permissions";

export default () => <Frame name="readiness" width={1280} height={800} fixture="permissions-light"
  capture={{ region: permissionCopy.permissionsTitle, viewport: "1280x800" }}>
  <Panel size="l" slot="center" title={permissionCopy.permissionsTitle} actions={<>
    <IconButton icon="refresh-cw" label={permissionCopy.permissionsRefresh} /><IconButton icon="maximize-2" label="Expand" />
  </>}><PermissionsContent /></Panel>
</Frame>;
