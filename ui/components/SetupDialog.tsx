import { useEffect, useState } from "react";
import { Check, Circle, ExternalLink } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { copyText, openUrl } from "../platform";
import { displayMessage } from "../messages";
import { notify, refreshConnector } from "../state/connector";
import type { Setup, SetupGoal } from "../state/setup";
import type { Login } from "../state/types";
import { Button, Dialog, Icon, Loading, Notice, SingleChoice } from "./ui";

export default function SetupDialog({ mode, setMode, snapshot, error: readError, refresh, onClose, onManual }: {
  mode: "entry" | "progress";
  setMode: (mode: "entry" | "progress") => void;
  snapshot?: Setup;
  error: string;
  refresh: () => Promise<Setup>;
  onClose: () => void;
  onManual: () => void;
}) {
  const [goal, setGoal] = useState<SetupGoal>("claude-loop");
  const [login, setLogin] = useState<string>("loading");
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "entry") return;
    let active = true, reading = false;
    const read = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try { const result = await api<Login>("codex/login"); if (active) setLogin(result.state); }
      catch { if (active) setLogin("unavailable"); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    window.addEventListener("focus", read);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", read); };
  }, [mode]);
  async function start(copy: boolean, other = false) {
    if (!snapshot || working) return;
    setWorking(true); setError("");
    try {
      if (copy) {
        await api("setup/apply", "POST", { stepId: "choose-goal", input: { option: goal } });
        const params = { goal, cli: snapshot.cliPath, stateDir: snapshot.stateDir };
        const prompt = t("setup.agentPrompt", params) + (other ? "\n" + t("setup.otherAgentPrompt", params) : "");
        await copyText(prompt);
        notify(t("setup.promptCopied"));
      } else await api("setup/dispatch", "POST", { goal });
      await refresh();
      setMode("progress");
    } catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }
  async function open(url: string) {
    try {
      if (url.startsWith("codex://threads/")) await api("tasks/open", "POST", { threadId: new URL(url).pathname.slice(1) });
      else await openUrl(url);
    } catch (e) { setError(String(e)); }
  }
  const ready = login === "authenticated", step = snapshot?.step;
  const complete = mode === "progress" && snapshot?.complete;
  return <Dialog title={t(mode === "entry" ? "setup.entryTitle" : complete ? "setup.completeTitle" : "setup.progressTitle")}
    width={640} onClose={onClose} busy={working}
    footer={mode === "entry" ? <>
      <Button variant="ghost" onClick={onManual} disabled={working}>{t("setup.manual")}</Button>
      <span className="spacer" />
      <Button disabled={working || !snapshot} onClick={() => void start(true, true)}>{t("setup.copyOther")}</Button>
      <Button variant="primary" busy={working} disabled={!snapshot || login === "loading"} onClick={() => void start(!ready)}>{t(ready ? "setup.sendCodex" : "setup.copyPrompt")}</Button>
    </> : <>
      {snapshot?.dispatch?.desktopUrl && <Button onClick={() => void open(snapshot.dispatch!.desktopUrl!)}><Icon icon={ExternalLink} />{t("setup.openTask")}</Button>}
      <span className="spacer" />
      <Button variant={complete ? "primary" : "secondary"} onClick={() => { if (complete) void refreshConnector(); onClose(); }}>{t(complete ? "backToHome" : "close")}</Button>
    </>}>
    {(error || readError) && <Notice tone="danger">{displayMessage(error || readError)}</Notice>}
    {mode === "entry" ? <div className="setup-entry">
      <SingleChoice value={goal} onChange={value => setGoal(value as SetupGoal)} label={t("setup.choose-goal.title")} disabled={working}
        options={[{ value: "claude-loop", label: t("setup.claudeRecommended") }, { value: "chatgpt-chat", label: "ChatGPT" }]} />
      <p className="muted">{t("setup.choose-goal.explain")}</p>
      {login !== "loading" && !ready && <Notice tone="warning">{t("setup.codexUnavailable")}</Notice>}
      <p className="muted small">{t("setup.userRole")}</p>
    </div> : !snapshot ? <Loading /> : <div className="setup-progress">
      <p className="muted small">{t("setup.progressCount", snapshot.progress)}</p>
      <div className="setup-progress-columns">
        <ol className="setup-steps" aria-label={t("setup.progressTitle")}>
          {snapshot.steps.map(item => <li key={item.id} data-done={item.done} aria-current={item.id === step?.id ? "step" : undefined}>
            <Icon icon={item.done ? Check : Circle} /><span>{item.title}</span>
          </li>)}
        </ol>
        <div className="setup-current" aria-live="polite">
          {complete ? <><h3>{t("setup.completeTitle")}</h3><p>{t("setup.completeExplain")}</p></> : step && <>
            <span className="muted small">{t(["authorize", "secret"].includes(step.kind) ? "setup.waitingForYou" : "setup.agentContinues")}</span>
            <h3>{step.title}</h3><p>{step.explain}</p>
            {["authorize", "secret"].includes(step.kind) && step.openUrl && <Button variant="primary" onClick={() => void open(step.openUrl!)}>{t(step.kind === "secret" ? "setup.enterCredential" : "setup.openAction")}</Button>}
            {["decide", "remote-ui"].includes(step.kind) && <p className="muted">{t(snapshot.dispatch?.desktopUrl ? "setup.continueCodex" : "setup.continueAgent")}</p>}
          </>}
          {snapshot.findings?.map(finding => <Notice key={finding.code} tone="warning">{finding.summary}</Notice>)}
        </div>
      </div>
    </div>}
  </Dialog>;
}
