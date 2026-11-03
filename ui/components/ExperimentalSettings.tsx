import { mcpServicesEnabled } from '../mcp/state';
import { t } from "../i18n";
import { topologyTuningEnabled } from "../state/topology";
import { Group, Row, Switch } from "./ui";
import { api } from "../api";
import { connector, run } from "../state/connector";
import { acceptPreferences, maintainerMode } from "../state/store";
import { showPets } from "../pets/state";
import { studioEnabled } from "../display/state";
import { relayHostingEnabled } from "../state/relay";

export default function ExperimentalSettings() {
  const mcp = mcpServicesEnabled.use();
  const tuning = topologyTuningEnabled.use(), hosting = relayHostingEnabled.use();
  const pets = showPets.use(), studio = studioEnabled.use();
  const maintainer = maintainerMode.use(), { busy, status } = connector.use();
  async function saveMaintainer(enabled: boolean) {
    await run("maintainer-mode", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", {
        values: { "maintainer-mode": enabled ? "on" : "off" },
      }));
    });
  }
  async function saveMcp(enabled: boolean) {
    await run("mcp-services", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", { values: { "mcp-services": enabled ? "on" : "off" } }));
    });
  }
  return <Group>
    <Row title={t("mcp.title")} description={t("mcp.experimentalEffect")}>
      <Switch label={t("mcp.title")} checked={mcp} disabled={!!busy || !status} onChange={saveMcp} />
    </Row>
    <Row title={t("hosting.feature")} description={t("hosting.featureDescription")}>
      <Switch label={t("hosting.feature")} checked={hosting} onChange={relayHostingEnabled.set} />
    </Row>
    <Row title={t("extras.maintainerMode")} description={t("extras.maintainerModeDescription")}>
      <Switch label={t("extras.maintainerMode")} checked={maintainer} disabled={!!busy || !status} onChange={saveMaintainer} />
    </Row>
    <Row title={t("topology.tuning")} description={t("topology.settingDescription")}>
      <Switch label={t("topology.tuning")} checked={tuning} onChange={topologyTuningEnabled.set} />
    </Row>
    <Row title={t("pets.title")} description={t("pets.showDescription")}>
      <Switch label={t("pets.show")} checked={pets} onChange={showPets.set} />
    </Row>
    <Row title={t("studio.enabled")} description={t("studio.enabledDescription")}>
      <Switch label={t("studio.enabled")} checked={studio} onChange={studioEnabled.set} />
    </Row>
  </Group>;
}
