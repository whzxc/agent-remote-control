import { useState } from "react";
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

export default function SettingsExtras() {
  const [pane, setPane] = useState("hosting"), tuning = topologyTuningEnabled.use();
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
        <HoverScope><SingleChoice navigation label={t("extras.title")} value={pane} onChange={setPane} options={[
          { value: "hosting", label: t("extras.hosting"), description: t("extras.hostingDescription") },
          { value: "experimental", label: t("topology.experimental"), description: t("extras.experimentalDescription") },
        ]} /></HoverScope>
      </aside>
      <div className="extras-content">
        {pane === "hosting" ? <RelayHosting /> : <Group title={t("topology.experimental")}>
          <Row title={t("extras.maintainerMode")}>
            <Switch label={t("extras.maintainerMode")} checked={maintainer} disabled={!!busy || !status} onChange={saveMaintainer} />
          </Row>
          <Row title={t("topology.tuning")} description={t("topology.settingDescription")}>
            <Switch label={t("topology.tuning")} checked={tuning} onChange={topologyTuningEnabled.set} />
          </Row>
          <Row title={t("pets.title")}>
            <Switch label={t("pets.show")} checked={pets} onChange={showPets.set} />
          </Row>
          <Row title={t("studio.enabled")}>
            <Switch label={t("studio.enabled")} checked={studio} onChange={studioEnabled.set} />
          </Row>
          {studio && <Row title={t("studio.light")}><StudioLighting /></Row>}
          {pets && <PetsPage />}
        </Group>}
      </div>
    </div>
  </div>;
}
