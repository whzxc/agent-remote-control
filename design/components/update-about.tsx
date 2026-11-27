import { Frame, Icon } from 'adg';
import { Button } from './button';
import { IconButton } from './icon-button';
import { SettingLine, SettingsGroup } from './settings-row';
import { copy } from '../fixtures/updates';


type AboutLabels = Pick<typeof copy, "about" | "appVersion" | "check" | "history" | "repository" | "experimental">;


export function UpdateAboutContent({ labels = copy, checkDisabled = false }: {
  labels?: AboutLabels;
  checkDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup title={labels.about}>
        <SettingLine title={labels.appVersion}>
          <Button disabled={checkDisabled} className={checkDisabled ? "opacity-45" : ""}>{labels.check}</Button>
        </SettingLine>
        <SettingLine title={labels.history} className="border-t border-border">
          <IconButton icon="chevron-right" label={labels.history} />
        </SettingLine>
      </SettingsGroup>
      <nav className="flex flex-wrap items-center gap-2 px-4" aria-label={labels.about}>
        <span className="text-meta text-text-secondary">{labels.repository}</span>
        <Button variant="ghost">GitHub<Icon name="external-link" size={14} /></Button>
        <div className="ml-auto">
          <Button variant="ghost">{labels.experimental}<Icon name="chevron-right" size={14} /></Button>
        </div>
      </nav>
    </div>
  );
}
export default () => <Frame name="update-about-content" width={672}><div className="w-full bg-surface-raised"><UpdateAboutContent /></div></Frame>;
