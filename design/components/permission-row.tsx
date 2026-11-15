import {Frame} from 'adg';
import {permissionCopy as copy,permissionRows} from '../fixtures/permissions';
import {Button} from './button';
import {Icon} from 'adg';
export function PermissionRow({ row, divider = false }: { row: typeof permissionRows[number]; divider?: boolean }) {
  return <div class={`grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 py-3 border-border ${divider ? "border-t" : ""}`}>
    <Icon name={row.icon} size={20} class="text-text-secondary" />
    <div><h3 class="text-small font-semibold">{row.title}</h3>
      <p class="mt-1 text-meta leading-[18px] text-text-secondary">{row.description}</p></div>
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center gap-1 rounded-full bg-surface-subtle px-2 py-1 text-meta text-text-secondary">
        <Icon name="circle" size={6} class="fill-current" />{copy["permissionState.unknown"]}
      </span>
      <Button disabled={row.system}>{copy[row.id === "login-start" ? "permissionsEnable" : row.system ? "permissionsGrant" : "permissionsInstructions"]}</Button>
    </div>
  </div>;
}

export default ()=><Frame name="row" width={672}><PermissionRow row={permissionRows[0]}/></Frame>;
