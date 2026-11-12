import { readOnlyBrowser } from "../browserMode";
import { useState } from "react";
import { t } from "../i18n";
import { subscriptions, saveSubscriptions } from "../state/subscriptions";
import {
  quotaDisplay,
  resetDisplay,
  maxVisibleAgents,
} from "../subscriptions/displayPreferences";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import {
  Notice,
  SingleChoice,
  Switch,
} from "./ui";
import { SettingsDialog as Dialog, SettingsSection as Group, Setting as Row } from "./ui/Settings";
export default function AgentDisplaySettings({
  onClose,
  agent,
}: {
  onClose: () => void;
  /** The Agent whose panel opened these settings. */
  agent?: string;
}) {
  const { snapshot } = subscriptions.use(),
    quota = quotaDisplay.use(),
    reset = resetDisplay.use(),
    max = maxVisibleAgents.use();
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title={t("agentDisplaySettings")} onClose={onClose} busy={saving || defaultsBusy}>
      <div className="settings-stack display-settings">
      {error && <Notice>{error}</Notice>}
      {agent && <AgentDispatchDefaults agent={agent} onBusy={setDefaultsBusy} />}
      <Group title={t("usageAppearance")}>
        <Row title={t("agentsMaxVisible")} width={200}>
          <SingleChoice fill
            value={String(max)}
            onChange={(value) => maxVisibleAgents.set(Number(value))}
            label={t("agentsMaxVisible")}
            options={["4", "6", "8", "10"].map((value) => ({
              value,
              label: value,
            }))}
          />
        </Row>
      </Group>
      <Group title={t("agentQuotaGroup")}>
        <Row toggle title={t("usageEnabled")}>
          <Switch label={t("usageEnabled")} checked={!!snapshot?.settings.enabled}
            disabled={readOnlyBrowser || saving || !snapshot}
            onChange={(enabled) => void save(() => saveSubscriptions({ enabled }))} />
        </Row>
        <Row title={t("agentQuotaDisplay")} width={220}>
          <SingleChoice fill
            value={quota}
            onChange={(value) =>
              quotaDisplay.set(value as "remaining" | "used")
            }
            label={t("agentQuotaDisplay")}
            options={[
              { value: "remaining", label: t("usageRemaining") },
              { value: "used", label: t("usageUsed") },
            ]}
          />
        </Row>
        <Row title={t("agentResetDisplay")}>
          <SingleChoice fill
            value={reset}
            onChange={(value) =>
              resetDisplay.set(value as "countdown" | "time")
            }
            label={t("agentResetDisplay")}
            options={[
              { value: "countdown", label: t("usageCountdown") },
              { value: "time", label: t("usageResetTime") },
            ]}
          />
        </Row>

        <Row title={t("usageAutoRefresh")}>
          <SingleChoice fill
            value={String(snapshot?.settings.refreshMinutes ?? 3)}
            onChange={(value) =>
              void save(() =>
                saveSubscriptions({ refreshMinutes: Number(value) }),
              )
            }
            label={t("usageAutoRefresh")}
            disabled={readOnlyBrowser || saving || !snapshot}
            options={["1", "3", "5", "10"].map((value) => ({
              value,
              label: `${value} min`,
            }))}
          />
        </Row>
      </Group>
      </div>
    </Dialog>
  );
}
