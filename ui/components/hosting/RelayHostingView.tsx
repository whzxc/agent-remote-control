import type { ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Button } from "../kit/button";
import { Spinner } from "../kit/spinner";

export interface RelayHostingViewProps {
  loaded: boolean;
  hasOwners: boolean;
  deployDisabled?: boolean;
  readError?: boolean;
  actionError?: string;
  deployAnchor?: string;
  onDeploy?: () => void;
  onRetryRead?: () => void;
  children?: ReactNode;
}

export function RelayHostingView({
  loaded,
  hasOwners,
  deployDisabled = false,
  readError = false,
  actionError,
  deployAnchor,
  onDeploy,
  onRetryRead,
  children,
}: RelayHostingViewProps) {
  const { t } = useI18n();

  return (
    <div className="relay-hosting grid gap-5 pt-1">
      <div className="hosting-empty-group grid justify-items-start gap-4">
        <div className="hosting-empty-copy grid gap-1.5">
          <h2 className="m-0 text-body font-semibold leading-5 text-foreground">
            {t("hosting.title")}
          </h2>
          {!loaded ? (
            <div className="flex items-center gap-2 text-small text-text-secondary">
              <Spinner size={15} />
              <span>{t("loading")}</span>
            </div>
          ) : (
            !hasOwners &&
            !readError && (
              <p className="m-0 text-small leading-5 text-text-secondary">
                {t("hosting.empty")}
              </p>
            )
          )}
        </div>
        <Button
          variant="outline"
          data-adg-id={deployAnchor}
          disabled={deployDisabled}
          onClick={onDeploy}
        >
          {t("hosting.deploy")}
        </Button>
      </div>

      {readError && (
        <Notice
          tone="danger"
          action={
            onRetryRead && (
              <Button variant="outline" size="sm" onClick={onRetryRead}>
                {t("retry")}
              </Button>
            )
          }
        >
          {t("connect.readFailed")}
        </Notice>
      )}

      {actionError && <Notice tone="danger">{actionError}</Notice>}

      {children}
    </div>
  );
}
