import { useState } from "react";
import { t } from "../i18n";
import { subscriptions, saveSubscriptions } from "../state/subscriptions";
import {
  quotaDisplay, topologyLayout, type LayoutPreference,
  resetDisplay,
  maxVisibleAgents,
  bubbleDensity, bubbleWidth, bubbleAutoCompact,
} from "../subscriptions/displayPreferences";
import { bubbleWidths, bubbleHeights, type BubbleDensity, type BubbleWidth } from "../state/activityModel";
import { ActivityBubbleContent } from "./ActivityBubbles";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import type { CSSProperties } from "react";
import {
  Dialog,
  Group,
  Row,
  Notice,
  SingleChoice,
  Switch,
} from "./ui";
export default function AgentDisplaySettings({
  onClose,
  agent,
}: {
  onClose: () => void;
  /** The Agent whose panel opened these settings. */
  agent?: string;
}) {
  const { snapshot } = subscriptions.use(),
    layout = topologyLayout.use(), quota = quotaDisplay.use(),
    reset = resetDisplay.use(),
    max = maxVisibleAgents.use(), density = bubbleDensity.use(), width = bubbleWidth.use(), autoCompact = bubbleAutoCompact.use();
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
      {agent && <AgentDispatchDefaults agent={agent} />}
      <Group title={t("activity.bubbleSettings")}>
        <div className="activity-preview" aria-label={t("activity.preview")}>
          <div className="activity-bubble" data-density={density} style={{ "--bubble-width": `${bubbleWidths[width]}px`, "--bubble-height": `${bubbleHeights[density]}px` } as CSSProperties}>
            <ActivityBubbleContent density={density} now={83000} session={{ id: "preview", source: "arc-task", title: t("activity.previewTitle"), phase: "command", headline: "npm run check", phaseSince: null,
              turnStartedAt: "1970-01-01T00:00:00Z", timeline: false, orderAt: 0, project: "/workspace/arc", recentContent: [t("activity.previewPrevious"), "npm run check"], recentSteps: ["thinking", "file", "command"],
              dispatchSummary: { model: "gpt-6.1-sol", effort: "high", serviceTier: "priority", controlSource: { kind: "claude", label: "Claude" } },
            }} />
          </div>
        </div>
        <Row title={t("activity.density")}><SingleChoice label={t("activity.density")} value={density} onChange={value => bubbleDensity.set(value as BubbleDensity)}
          options={Object.keys(bubbleHeights).map(value => ({ value, label: t(`activity.density.${value}`) }))} /></Row>
        <Row title={t("activity.width")}><SingleChoice label={t("activity.width")} value={width} onChange={value => bubbleWidth.set(value as BubbleWidth)}
          options={Object.keys(bubbleWidths).map(value => ({ value, label: t(`activity.width.${value}`) }))} /></Row>
        <Row title={t("activity.autoCompact")} description={t("activity.autoCompactHint")}><Switch label={t("activity.autoCompact")} checked={autoCompact} onChange={bubbleAutoCompact.set} /></Row>
      </Group>
      <Group title={t("usageAppearance")}>
        <Row title={t("topology.layout")}><SingleChoice label={t("topology.layout")} value={layout}
          onChange={value => topologyLayout.set(value as LayoutPreference)}
          options={['auto', 'landscape', 'portrait'].map(value => ({ value, label: t(`topology.layout.${value}`) }))} /></Row>
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
    </Dialog>
  );
}
