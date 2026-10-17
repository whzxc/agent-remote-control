import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { locale } from "../i18n";
export type SetupGoal = "claude-loop" | "chatgpt-chat";
export type SetupStep = { id: string; title: string; kind: "auto" | "decide" | "authorize" | "secret" | "remote-ui"; done: boolean };
export type Setup = {
  goal: SetupGoal | null;
  complete: boolean;
  progress: { done: number; total: number };
  steps: SetupStep[];
  step: (SetupStep & { explain: string; openUrl?: string; credentialUrl?: string }) | null;
  dispatch?: { threadId?: string; desktopUrl?: string };
  cliPath: string;
  stateDir: string;
  onboarding?: { url?: string } | null;
  findings?: { code: string; summary: string }[];
};
export function useSetup(visible: boolean) {
  const language = locale.use();
  const [snapshot, setSnapshot] = useState<Setup>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const next = await api<Setup>("setup/next", "POST");
    setSnapshot(next);
    setError("");
    return next;
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, reading = false;
    const read = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try {
        const next = await api<Setup>("setup/next", "POST");
        if (!stopped) { setSnapshot(next); setError(""); }
      } catch (e) { if (!stopped) setError(String(e)); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", read); window.removeEventListener("focus", read); };
  }, [visible, language]);
  return { snapshot, error, refresh };
}
