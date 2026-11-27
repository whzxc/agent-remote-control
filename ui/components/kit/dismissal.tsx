import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useI18n } from "../../i18n/react";
import { Button } from "./button";
import { cn } from "./utils";

export type DismissalStatus = "none" | "discard" | "running";

/** A submitted draft becomes the baseline; edits after that attempt are dirty again. */
export function useSubmittedDirty<T>(
  draft: T,
  edited: boolean,
): { dirty: boolean; submit: (value?: T) => void } {
  const snapshot = JSON.stringify(draft);
  const [submitted, setSubmitted] = useState<string>();
  return {
    dirty: submitted === undefined ? edited : snapshot !== submitted,
    submit: (value: T = draft) => setSubmitted(JSON.stringify(value)),
  };
}

export interface DismissalGuardOptions {
  dirty?: boolean;
  busy?: boolean;
  onClose: () => void | Promise<void>;
  onCancel?: () => void | boolean | Promise<void | boolean>;
  onLateComplete?: (outcome: { closed: boolean }) => void;
}

export interface DismissalGuard {
  status: DismissalStatus;
  cancellable: boolean;
  keepAfterWork: boolean;
  requestClose: (options?: { explicit?: boolean }) => boolean;
  confirmDiscard: () => void;
  keepOpen: () => void;
  stopAndClose: () => Promise<void>;
}

/**
 * Intercepts closing when a dialog or workspace has unsaved edits or running work.
 * Explicit Close/Cancel buttons close dirty layers immediately but still guard busy work.
 */
export function useDismissalGuard({
  dirty = false,
  busy = false,
  onClose,
  onCancel,
  onLateComplete,
}: DismissalGuardOptions): DismissalGuard {
  const [status, setStatus] = useState<DismissalStatus>("none");
  const [keepAfterWork, setKeepAfterWork] = useState(false);

  const prevBusy = useRef(busy);
  const statusRef = useRef(status);
  statusRef.current = status;
  const keepAfterWorkRef = useRef(keepAfterWork);
  keepAfterWorkRef.current = keepAfterWork;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onLateCompleteRef = useRef(onLateComplete);
  onLateCompleteRef.current = onLateComplete;

  useEffect(() => {
    if (!dirty && status === "discard") {
      setStatus("none");
    }
  }, [dirty, status]);

  useEffect(() => {
    const wasBusy = prevBusy.current;
    prevBusy.current = busy;

    if (!wasBusy && busy) {
      setKeepAfterWork(false);
      return;
    }

    if (wasBusy && !busy) {
      if (statusRef.current === "running") {
        setStatus("none");
        setKeepAfterWork(false);
        void onCloseRef.current();
        onLateCompleteRef.current?.({ closed: true });
      } else if (keepAfterWorkRef.current) {
        setKeepAfterWork(false);
        onLateCompleteRef.current?.({ closed: false });
      }
    }
  }, [busy]);

  const requestClose = useCallback(
    ({ explicit = false }: { explicit?: boolean } = {}) => {
      if (busy) {
        setStatus("running");
        return false;
      }
      if (dirty && !explicit) {
        setStatus("discard");
        return false;
      }
      setStatus("none");
      void onCloseRef.current();
      return true;
    },
    [busy, dirty],
  );

  const confirmDiscard = useCallback(() => {
    setStatus("none");
    void onCloseRef.current();
  }, []);

  const keepOpen = useCallback(() => {
    if (statusRef.current === "running") {
      setKeepAfterWork(true);
    }
    setStatus("none");
  }, []);

  const stopAndClose = useCallback(async () => {
    const cancel = onCancelRef.current;
    if (!cancel) return;
    setStatus("none");
    setKeepAfterWork(false);
    const result = await cancel();
    if (result === false) return;
    await onCloseRef.current();
  }, []);

  return {
    status,
    cancellable: Boolean(onCancel),
    keepAfterWork,
    requestClose,
    confirmDiscard,
    keepOpen,
    stopAndClose,
  };
}

export function DismissalFooter({
  status,
  cancellable = false,
  onDiscard,
  onStopAndClose,
  onKeepOpen,
  className,
}: {
  status: DismissalStatus;
  cancellable?: boolean;
  onDiscard: () => void;
  onStopAndClose?: () => void | Promise<void>;
  onKeepOpen: () => void;
  className?: string;
}): ReactElement | null {
  const { t } = useI18n();
  const safeAction = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (status !== "none") {
      safeAction.current?.focus({ preventScroll: true });
    }
  }, [status]);

  if (status === "none") return null;

  return (
    <footer
      data-slot="dismissal-footer"
      role="status"
      className={cn(
        "flex shrink-0 flex-col gap-2.5 border-t border-warning/35 bg-warning/10 px-4 py-3",
        className,
      )}
    >
      <p className="text-small leading-5 text-text-secondary">
        {t(status === "discard" ? "layers.discard" : "layers.runningClose")}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "discard" && (
          <Button variant="danger" onClick={onDiscard}>
            {t("layers.discardAction")}
          </Button>
        )}
        {status === "running" && cancellable && onStopAndClose && (
          <Button variant="danger" onClick={() => void onStopAndClose()}>
            {t("layers.stopClose")}
          </Button>
        )}
        <Button
          ref={safeAction}
          variant="primary"
          className="focus-visible:ring-2 focus-visible:ring-accent"
          onClick={onKeepOpen}
        >
          {t(status === "discard" ? "layers.keepEditing" : "layers.keepOpen")}
        </Button>
      </div>
    </footer>
  );
}
