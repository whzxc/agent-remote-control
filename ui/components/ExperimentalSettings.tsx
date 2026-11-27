import { Card } from './ui/card';
import { deviceLinkEnabled } from '../devices/state';
import { mcpHubEnabled } from '../mcp/state';
import { t } from "../i18n";
import { topologyTuningEnabled } from "../state/topology";
import { Switch } from "./ui";
import { SettingsSection as Group, Setting as Row, SettingLine } from "./ui/Settings";
import { api } from "../api";
import { connector, run } from "../state/connector";
import { acceptPreferences, maintainerMode } from "../state/store";
import { relayHostingEnabled } from "../state/relay";

export default function ExperimentalSettings() {
  const mcp = mcpHubEnabled.use(), devices = deviceLinkEnabled.use();
  const tuning = topologyTuningEnabled.use(), hosting = relayHostingEnabled.use();
  const maintainer = maintainerMode.use(), { busy, status } = connector.use();
  async function saveMaintainer(enabled: boolean) {
    await run("maintainer-mode", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", {
        values: { "maintainer-mode": enabled ? "on" : "off" },
      }));
    });
  }
  async function saveDevices(enabled: boolean) {
    await run("device-link", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", { values: { "device-link": enabled ? "on" : "off" } }));
    });
  }
  async function saveMcp(enabled: boolean) {
    await run("mcp-services", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", { values: { "mcp-services": enabled ? "on" : "off" } }));
    });
  }
  return <div className="settings-stack experimental-settings"><Card className="device-experiment">
    <SettingLine title={t("device.deviceLink")}>
      <Switch label={t("device.deviceLink")} checked={devices} disabled={!!busy || !status} onChange={saveDevices} />
    </SettingLine>
  </Card><Group>
    <Row toggle title={t("mcp.title")} description={t("mcp.experimentalEffect")}>
      <Switch label={t("mcp.title")} checked={mcp} disabled={!!busy || !status} onChange={saveMcp} />
    </Row>
    <Row toggle title={t("hosting.feature")} description={t("hosting.featureDescription")}>
      <Switch label={t("hosting.feature")} checked={hosting} onChange={relayHostingEnabled.set} />
    </Row>
    <Row toggle title={t("extras.maintainerMode")} description={t("extras.maintainerModeDescription")}>
      <Switch label={t("extras.maintainerMode")} checked={maintainer} disabled={!!busy || !status} onChange={saveMaintainer} />
    </Row>
  </Group><Group>
    <Row toggle title={t("topology.tuning")} description={t("topology.settingDescription")}>
      <Switch label={t("topology.tuning")} checked={tuning} onChange={topologyTuningEnabled.set} />
    </Row>
  </Group></div>;
}
