import { t } from "../i18n";
import { topologyTuningEnabled } from "../state/topology";
import { Group, HoverScope, Row, SingleChoice, Switch } from "./ui";
import { api } from "../api";
import { connector, run } from "../state/connector";
import { acceptPreferences, maintainerMode } from "../state/store";
import PetsPage from "../pets/PetsPage";
import { showPets } from "../pets/state";
import { StudioLighting } from "../display/Studio";
import { studioEnabled } from "../display/state";
import RelayHosting from "./RelayHosting";
import { navigation } from "../state/navigation";

export default function SettingsExtras() {
  const { settingsExtrasPane = "experimental" } = navigation.use(), tuning = topologyTuningEnabled.use();
  const pets = showPets.use(), studio = studioEnabled.use();
  const maintainer = maintainerMode.use(), { busy, status } = connector.use();
  async function saveMaintainer(enabled: boolean) {
    await run("maintainer-mode", async () => {
      acceptPreferences(await api<Record<string, string>>("preferences", "PUT", {
        values: { "maintainer-mode": enabled ? "on" : "off" },
      }));
    });
  }
  return <div className="settings-extras">
    <div className="extras-layout">
      <aside className="extras-nav">
        <HoverScope><SingleChoice navigation label={t("extras.title")} value={settingsExtrasPane} onChange={value => navigation.set(old => ({ ...old, settingsExtrasPane: value === "hosting" ? "hosting" : "experimental" }))} options={[
          { value: "experimental", label: t("topology.experimental") },
          { value: "hosting", label: t("extras.hosting") },
        ]} /></HoverScope>
      </aside>
      <div className="extras-content">
        {settingsExtrasPane === "hosting" ? <RelayHosting /> : <Group title={t("topology.experimental")}>
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
          {studio && <Row title={t("studio.light")} description={t("studio.lightDescription")}><StudioLighting /></Row>}
          {pets && <PetsPage />}
        </Group>}
      </div>
    </div>
  </div>;
}
