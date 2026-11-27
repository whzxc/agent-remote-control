import { api } from "../api";
import { deviceLinkEnabled } from "../devices/state";
import { mcpHubEnabled } from "../mcp/state";
import { connector, run } from "../state/connector";
import { relayHostingEnabled } from "../state/relay";
import { acceptPreferences, maintainerMode } from "../state/store";
import { topologyTuningEnabled } from "../state/topology";
import { ExperimentalSettingsView } from "./settings/ExperimentalSettingsView";

export default function ExperimentalSettings() {
  const mcp = mcpHubEnabled.use();
  const devices = deviceLinkEnabled.use();
  const tuning = topologyTuningEnabled.use();
  const hosting = relayHostingEnabled.use();
  const maintainer = maintainerMode.use();
  const { busy, status } = connector.use();

  async function savePreference(label: string, key: string, enabled: boolean) {
    await run(label, async () => {
      acceptPreferences(
        await api<Record<string, string>>("preferences", "PUT", {
          values: { [key]: enabled ? "on" : "off" },
        }),
      );
    });
  }

  return (
    <ExperimentalSettingsView
      devicesEnabled={devices}
      mcpEnabled={mcp}
      hostingEnabled={hosting}
      maintainerEnabled={maintainer}
      tuningEnabled={tuning}
      remoteDisabled={!!busy || !status}
      onDevicesChange={(enabled) =>
        void savePreference("device-link", "device-link", enabled)
      }
      onMcpChange={(enabled) =>
        void savePreference("mcp-services", "mcp-services", enabled)
      }
      onHostingChange={relayHostingEnabled.set}
      onMaintainerChange={(enabled) =>
        void savePreference("maintainer-mode", "maintainer-mode", enabled)
      }
      onTuningChange={topologyTuningEnabled.set}
    />
  );
}
