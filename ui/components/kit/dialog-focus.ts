import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";

const FocusContext = createContext<{ current: HTMLElement[] } | null>(null);
const actionSelector =
  'button, a[href], input, select, textarea, [tabindex], [role="button"], [role="menuitem"]';

function actionTarget(target: EventTarget | null): HTMLElement | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) return null;
  const action = target.closest<HTMLElement>(actionSelector);
  if (!action || action === document.body || action === document.documentElement) {
    return null;
  }
  const menu = action.closest('[role="menu"]');
  const menuTrigger =
    menu?.id && typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? document.querySelector<HTMLElement>(
          `[aria-controls="${CSS.escape(menu.id)}"]`,
        )
      : null;
  return menuTrigger ?? action;
}

export function DialogFocusProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const lastAction = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const remember = (event: Event) => {
      const target = actionTarget(event.target);
      if (target) {
        lastAction.current = [
          target,
          ...lastAction.current.filter(
            (value) => value !== target && value.isConnected,
          ),
        ].slice(0, 12);
      }
    };
    document.addEventListener("focusin", remember, true);
    document.addEventListener("pointerdown", remember, true);
    return () => {
      document.removeEventListener("focusin", remember, true);
      document.removeEventListener("pointerdown", remember, true);
    };
  }, []);

  return createElement(FocusContext.Provider, { value: lastAction }, children);
}

export function useDialogFinalFocus(): () => HTMLElement | boolean {
  const lastAction = useContext(FocusContext);
  const opener = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const current = actionTarget(document.activeElement);
    opener.current = [
      ...(current ? [current] : []),
      ...(lastAction?.current ?? []),
    ];
  }, [lastAction]);

  return useCallback(() => {
    for (const target of opener.current) {
      if (target.isConnected) return target;
    }
    return true;
  }, []);
}
