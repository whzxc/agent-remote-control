import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { t } from "../../i18n";
import {
  Setting as SettingRow,
  SettingsSection as SettingsSectionBlock,
} from "../settings/SettingsRows";
import Dialog from "./Dialog";
import { DialogClose, IconButton } from "./index";
import "./Settings.css";

export { SettingLine } from "../settings/SettingsRows";

/** Shared settings composition for the approved settings surface. */
export function SettingsSection(
  props: ComponentProps<typeof SettingsSectionBlock>,
) {
  return <SettingsSectionBlock {...props} />;
}

export function Setting(props: ComponentProps<typeof SettingRow>) {
  return <SettingRow {...props} />;
}

export function SettingsDialog(props: ComponentProps<typeof Dialog>) {
  return (
    <Dialog {...props} className="settings-dialog">
      {props.headerless && (
        <div className="settings-dialog-close">
          <DialogClose asChild>
            <IconButton icon={X} label={t("close")} />
          </DialogClose>
        </div>
      )}
      {props.children}
    </Dialog>
  );
}
