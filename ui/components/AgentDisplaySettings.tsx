import { useState } from "react";
import { readOnlyBrowser } from "../browserMode";
import { t } from "../i18n";
import { saveSubscriptions, subscriptions } from "../state/subscriptions";
import {
  maxVisibleAgents,
  quotaDisplay,
  resetDisplay,
  topologyLayout,
  type LayoutPreference,
} from "../subscriptions/displayPreferences";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import { DisplaySettingsView } from "./settings/DisplaySettingsView";
import { SettingsDialog as Dialog } from "./ui/Settings";

export default function AgentDisplaySettings({
  onClose,
  agent,
}: {
  onClose: () => void;
  /** The Agent whose panel opened these settings. */
  agent?: string;
}) {
  const { snapshot } = subscriptions.use();
  const layout = topologyLayout.use();
  const quota = quotaDisplay.use();
  const reset = resetDisplay.use();
  const max = maxVisibleAgents.use();
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={t("agentDisplaySettings")}
      onClose={onClose}
      busy={saving || defaultsBusy}
    >
      <DisplaySettingsView
        error={error || undefined}
        dispatchDefaultsSlot={
          agent ? (
            <AgentDispatchDefaults agent={agent} onBusy={setDefaultsBusy} />
          ) : undefined
        }
        layout={layout}
        onLayoutChange={(value) => topologyLayout.set(value as LayoutPreference)}
        maxVisibleAgents={max}
        onMaxVisibleAgentsChange={(value) => maxVisibleAgents.set(value)}
        quotaEnabled={!!snapshot?.settings.enabled}
        quotaDisabled={readOnlyBrowser || saving || !snapshot}
        onQuotaEnabledChange={(enabled) =>
          void save(() => saveSubscriptions({ enabled }))
        }
        quotaDisplay={quota}
        onQuotaDisplayChange={(value) => quotaDisplay.set(value)}
        resetDisplay={reset}
        onResetDisplayChange={(value) => resetDisplay.set(value)}
        refreshMinutes={snapshot?.settings.refreshMinutes ?? 3}
        refreshDisabled={readOnlyBrowser || saving || !snapshot}
        onRefreshMinutesChange={(refreshMinutes) =>
          void save(() => saveSubscriptions({ refreshMinutes }))
        }
      />
    </Dialog>
  );
}
