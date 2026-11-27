export function PermissionRow({ row, divider = false }: { row: typeof permissionRows[number]; divider?: boolean }) {
  return <div className={`grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 py-3 border-border ${divider ? "border-t" : ""}`}>
    <Icon name={row.icon} size={20} className="text-text-secondary" />
    <div><h3 className="text-small font-semibold">{row.title}</h3>
      <p className="mt-1 text-meta leading-[18px] text-text-secondary">{row.description}</p></div>
    <div className="flex items-center gap-3">
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-subtle px-2 py-1 text-meta text-text-secondary">
        <Icon name="circle" size={6} className="fill-current" />{copy["permissionState.unknown"]}
      </span>
      <Button disabled={row.system}>{copy[row.id === "login-start" ? "permissionsEnable" : row.system ? "permissionsGrant" : "permissionsInstructions"]}</Button>
    </div>
  </div>;
}
import { Frame, Icon } from "adg";
import { Button } from "../components/button";
import { permissionCopy as copy, permissionRows } from "../fixtures/permissions";

export function PermissionsContent() {
  return <div className="flex flex-col gap-6">{[true, false].map(system => <section>
    <h2 className="mb-1 text-meta font-semibold text-text-secondary">{copy[system ? "permissionsSystem" : "permissionsEnvironment"]}</h2>
    {system && <p className="text-meta leading-[18px] text-text-tertiary">{copy.permissionsAppHint}</p>}
    {permissionRows.filter(row => row.system === system).map((row, index) => <PermissionRow row={row} divider={index > 0} />)}
  </section>)}</div>;
}
export default () => <Frame name="permission-row" width={672}><PermissionRow row={permissionRows[0]} /></Frame>;
