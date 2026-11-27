import { MotionConfig } from "motion/react";
import { useEffect, useMemo, type ReactNode } from "react";
import { locale } from "../i18n";
import { LocaleProvider } from "../i18n/react";
import { accounts } from "../state/accounts";
import { observeAppEnvironment, useReducedMotion } from "../state/appEnvironment";
import { connector } from "../state/connector";
import { usePrivacy } from "../state/privacy";
import { observeNativeTheme } from "../theme";
import { DialogFocusProvider } from "./kit/dialog-focus";
import { PrivacyProvider } from "./kit/privacy";
import { TooltipProvider } from "./ui";

function RuntimePrivacyProvider({ children }: { children: ReactNode }) {
  const hidden = usePrivacy();
  const { items } = accounts.use();
  const { status } = connector.use();
  const values = useMemo(
    () =>
      items
        .flatMap((account) => [
          account.email,
          account.orgName,
          account.identityKey,
          ...account.notifications.sessions.map((session) => session.target),
        ])
        .concat(
          status?.ingresses.flatMap((ingress) => [
            ingress.url,
            ingress.config.tunnelId,
            ingress.config.httpsUrl,
          ]) ?? [],
        )
        .filter((value): value is string => Boolean(value)),
    [items, status?.ingresses],
  );
  return (
    <PrivacyProvider hidden={hidden} values={values}>
      {children}
    </PrivacyProvider>
  );
}

export default function UiProvider({ children }: { children: ReactNode }) {
  const language = locale.use();
  const reduced = useReducedMotion();
  useEffect(observeAppEnvironment, []);
  useEffect(observeNativeTheme, []);
  return (
    <LocaleProvider locale={language}>
      <RuntimePrivacyProvider>
        <DialogFocusProvider>
          <MotionConfig reducedMotion={reduced ? "always" : "never"}>
            <TooltipProvider delayDuration={350}>
              <div
                className="ui-root"
                lang={language}
                onClickCapture={(event) => {
                  // WebKit does not focus buttons on pointer or accessibility activation. Keep dialog
                  // return focus consistent with keyboard activation on every host.
                  if (event.button !== 0 || !(event.target instanceof Element)) return;
                  const control = event.target.closest<HTMLElement>(
                    'button, a[href], [role="button"], [role="radio"]',
                  );
                  if (control && !control.matches('[disabled], [aria-disabled="true"]'))
                    control.focus({ preventScroll: true });
                }}
              >
                {children}
              </div>
            </TooltipProvider>
          </MotionConfig>
        </DialogFocusProvider>
      </RuntimePrivacyProvider>
    </LocaleProvider>
  );
}
