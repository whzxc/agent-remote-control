import { t } from "../i18n";
import { maxVisibleAgents } from "../state/quota";
import { Dialog, Row, SingleChoice } from "./ui";
export default function AgentDisplaySettings({ onClose }: { onClose: () => void }) {
  const max = maxVisibleAgents.use();
  return <Dialog title={t("agentDisplaySettings")} onClose={onClose}>
    <Row title={t("agentsMaxVisible")}><SingleChoice value={String(max)} onChange={value => maxVisibleAgents.set(Number(value))} label={t("agentsMaxVisible")} options={["4", "6", "8", "10"].map(value => ({ value, label: value }))} /></Row>
  </Dialog>;
}
