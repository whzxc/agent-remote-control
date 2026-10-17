import { useState } from "react";
import { windowLabel } from "../subscriptions/labels";
import { t } from "../i18n";
import { subscriptions, saveSubscriptions } from "../state/subscriptions";
import {
  quotaDisplay,
  resetDisplay,
  maxVisibleAgents,
} from "../subscriptions/displayPreferences";
import {
  Checkbox,
  Dialog,
  Group,
  Row,
  Notice,
  SingleChoice,
  Switch,
} from "./ui";
export default function AgentDisplaySettings({
  onClose,
}: {
  onClose: () => void;
}) {
  const { snapshot } = subscriptions.use(),
    quota = quotaDisplay.use(),
    reset = resetDisplay.use(),
    max = maxVisibleAgents.use();
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
    <Dialog title={t("agentDisplaySettings")} onClose={onClose} busy={saving}>
      {error && <Notice>{error}</Notice>}
      <Group title={t("usageAppearance")}>
        <Row title={t("agentsMaxVisible")}>
          <SingleChoice
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
        <Row title={t("usageEnabled")}>
          <Switch label={t("usageEnabled")} checked={!!snapshot?.settings.enabled}
            disabled={saving || !snapshot}
            onChange={(enabled) => void save(() => saveSubscriptions({ enabled }))} />
        </Row>
        <Row title={t("agentQuotaDisplay")}>
          <SingleChoice
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
          <SingleChoice
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
          <SingleChoice
            value={String(snapshot?.settings.refreshMinutes ?? 3)}
            onChange={(value) =>
              void save(() =>
                saveSubscriptions({ refreshMinutes: Number(value) }),
              )
            }
            label={t("usageAutoRefresh")}
            disabled={saving || !snapshot}
            options={["1", "3", "5", "10"].map((value) => ({
              value,
              label: `${value} min`,
            }))}
          />
        </Row>
      </Group>
      <Group title={t("usageProviders")}>
        {snapshot?.providers.map((provider) => (
          <Row key={provider.providerId} title={provider.name}>
            <div className="quota-provider-controls">
            <Checkbox checked={provider.selected} disabled={saving}
              onChange={(selected) => void save(() => saveSubscriptions({
                providers: selected ? [...snapshot.settings.providers, provider.providerId]
                  : snapshot.settings.providers.filter(id => id !== provider.providerId),
              }))}>{t("usageProviderSelected")}</Checkbox>
            <SingleChoice label={t("usagePinnedWindow")} disabled={saving || !provider.selected}
              value={snapshot.settings.pinnedWindows[provider.providerId] ?? "auto"}
              options={[{ value: "auto", label: t("usageAutomaticWindow") }, ...provider.windows.map(w => ({
                value: w.id, label: `${w.scope ? w.scope + " · " : ""}${windowLabel(w.label)}`,
              })), ...(provider.pinUnavailable ? [{ value: snapshot.settings.pinnedWindows[provider.providerId]!, label: t("usagePinUnavailable") }] : [])]}
              onChange={(value) => void save(() => {
                const pinnedWindows = { ...snapshot.settings.pinnedWindows };
                if (value !== "auto") pinnedWindows[provider.providerId] = value;
                else delete pinnedWindows[provider.providerId];
                return saveSubscriptions({ pinnedWindows });
              })} />
            </div>
          </Row>
        ))}
      </Group>
    </Dialog>
  );
}
