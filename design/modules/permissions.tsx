import {PermissionRow} from '../components/permission-row';
import { Frame, Icon } from "adg";
import { Button } from "../components/button";
import { permissionCopy as copy, permissionRows } from "../fixtures/permissions";

export function PermissionsContent() {
  return <div class="flex flex-col gap-6">{[true, false].map(system => <section>
    <h2 class="mb-1 text-meta font-semibold text-text-secondary">{copy[system ? "permissionsSystem" : "permissionsEnvironment"]}</h2>
    {system && <p class="text-meta leading-[18px] text-text-tertiary">{copy.permissionsAppHint}</p>}
    {permissionRows.filter(row => row.system === system).map((row, index) => <PermissionRow row={row} divider={index > 0} />)}
  </section>)}</div>;
}
export default () => <Frame name="permission-row" width={672}><PermissionRow row={permissionRows[0]} /></Frame>;
