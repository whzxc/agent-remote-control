import { Frame } from "adg";
import {
  PermissionRowView,
  PermissionsPageView,
} from "@/components/permissions/PermissionsPageView";
import { LocaleProvider } from "@/i18n/react";
import { permissionRows } from "../fixtures/permissions";

export function PermissionRow({
  row,
  divider = false,
}: {
  row: (typeof permissionRows)[number];
  divider?: boolean;
}) {
  return (
    <LocaleProvider locale="en">
      <PermissionRowView
        item={{ id: row.id, state: "unknown", system: row.system }}
        actionDisabled={row.system}
        className={divider ? "border-t border-border" : undefined}
      />
    </LocaleProvider>
  );
}

export function PermissionsContent() {
  return (
    <LocaleProvider locale="en">
      <PermissionsPageView
        showSystem
        appName="Agent Remote Control"
        desktopAvailable={false}
        items={permissionRows.map((row) => ({
          id: row.id,
          state: "unknown",
          system: row.system,
        }))}
      />
    </LocaleProvider>
  );
}

export default () => (
  <Frame name="permission-row" width={672}>
    <div className="w-full bg-surface-raised">
      <PermissionRow row={permissionRows[0]} />
    </div>
  </Frame>
);
