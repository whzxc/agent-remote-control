import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import logo from "../assets/arc-remote-head.png";
import happy from "../assets/mascot/happy.png";
import surprised from "../assets/mascot/surprised.png";
import pout from "../assets/mascot/pout.png";
import closed from "../assets/mascot/closed.png";
import cross from "../assets/mascot/cross.png";
import squeezed from "../assets/mascot/squeezed.png";
import dizzy from "../assets/mascot/dizzy.png";
export type MascotState =
  | "connected"
  | "offline"
  | "connecting"
  | "stopping"
  | "degraded"
  | "error"
  | "unavailable"
  | "working";
const stateExpressions = {
  connected: logo,
  offline: closed,
  connecting: surprised,
  stopping: squeezed,
  degraded: pout,
  error: cross,
  unavailable: dizzy,
  working: happy,
};
export default function PlayfulMascot({
  state,
  onDisplacement,
}: {
  state: MascotState;
  onDisplacement: (p: { x: number; y: number }) => void;
}) {
  const head = useRef<HTMLSpanElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 }),
    [dragging, setDragging] = useState(false),
    [expression, setExpression] = useState(logo);
  const current = useRef({ state, onDisplacement });
  current.current = { state, onDisplacement };
  const reset = useRef<() => void>(() => {});
  useEffect(() => reset.current(), [state]);
  useEffect(() => {
    let position = { x: 0, y: 0 },
      frame = 0,
      suppressClick = false,
      lastEffect = -1,
      disposed = false;
    let drag:
      | {
          pointerId: number;
          x: number;
          y: number;
          offsetX: number;
          offsetY: number;
          moved: boolean;
        }
      | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined,
      clickAnimation: Animation | undefined;
    let ready: string[] = [],
      shown = logo;
    const reach = 140;
    const display = (src: string) => {
      shown = src;
      setExpression(src);
    };
    const restore = () => {
      clearTimeout(timer);
      const src = stateExpressions[current.current.state];
      display(ready.includes(src) ? src : logo);
    };
    reset.current = restore;
    head.current?.querySelectorAll("img").forEach(
      (image) =>
        void image
          .decode()
          .then(() => {
            if (!disposed) {
              ready.push(image.getAttribute("src")!);
              restore();
            }
          })
          .catch(() => {}),
    );
    function move(p: { x: number; y: number }) {
      position = p;
      setPosition(p);
      current.current.onDisplacement(p);
    }
    function changeExpression() {
      clearTimeout(timer);
      const choices = ready.filter(
        (src) =>
          src !== stateExpressions[current.current.state] && src !== shown,
      );
      if (choices.length)
        display(choices[Math.floor(Math.random() * choices.length)]!);
    }
    function restoreExpressionLater() {
      clearTimeout(timer);
      timer = setTimeout(restore, 3000 + Math.random() * 5000);
    }
    function returnHome() {
      cancelAnimationFrame(frame);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        move({ x: 0, y: 0 });
        return;
      }
      const origin = { ...position };
      const started = performance.now();
      function step(now: number) {
        const seconds = (now - started) / 1000;
        // A taut rubber band: fast recoil and several progressively smaller swings.
        const decay = Math.exp(-4 * seconds);
        const spring =
          decay * (Math.cos(22 * seconds) + (4 / 22) * Math.sin(22 * seconds));
        move({ x: origin.x * spring, y: origin.y * spring });
        if (seconds < 1.8) frame = requestAnimationFrame(step);
        else {
          move({ x: 0, y: 0 });
          frame = 0;
        }
      }
      frame = requestAnimationFrame(step);
    }

    function startDrag(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      clickAnimation?.cancel();
      suppressClick = false;
      // Invert the resistance curve so catching the returning head never jumps.
      const scale =
        1 / (1 - Math.min(Math.hypot(position.x, position.y) / reach, 0.999));
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offsetX: position.x * scale,
        offsetY: position.y * scale,
        moved: false,
      };
      setDragging(true);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }

    function moveDrag(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) changeExpression();
      drag.moved = true;
      const x = drag.offsetX + dx,
        y = drag.offsetY + dy;
      // Equal mouse travel produces progressively less movement in every direction.
      const resistance = 1 + Math.hypot(x, y) / reach;
      move({ x: x / resistance, y: y / resistance });
    }

    function endDrag(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      suppressClick = drag.moved || event.type !== "pointerup";
      drag = undefined;
      setDragging(false);
      const button = event.currentTarget as HTMLElement;
      if (button.hasPointerCapture(event.pointerId))
        button.releasePointerCapture(event.pointerId);
      returnHome();
      restoreExpressionLater();
    }

    function reactToClick(event: MouseEvent) {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        return;
      }
      if (drag) return;
      changeExpression();
      clickAnimation?.cancel();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const direction = Math.random() < 0.5 ? -1 : 1;
        const x = direction * (8 + Math.random() * 8);
        const y = -(15 + Math.random() * 12);
        const tilt = direction * (10 + Math.random() * 9);
        const rest = "rotate(-7deg)";
        const effects = [
          {
            name: "bounce",
            duration: 650,
            frames: [
              { offset: 0, transform: rest },
              {
                offset: 0.14,
                transform: "translateY(5px) rotate(-10deg) scale(1.06, .92)",
              },
              {
                offset: 0.36,
                transform: `translate(${x}px, ${y}px) rotate(${tilt}deg) scale(.95, 1.06)`,
              },
              {
                offset: 0.58,
                transform: `translate(${-x * 0.35}px, 2px) rotate(-13deg) scale(1.04, .96)`,
              },
              {
                offset: 0.77,
                transform: `translate(${x * 0.2}px, -7px) rotate(-2deg)`,
              },
              { offset: 1, transform: rest },
            ],
          },
          {
            name: "spin",
            duration: 850,
            frames: [
              { offset: 0, transform: rest },
              {
                offset: 0.16,
                transform: `rotate(${-7 - direction * 18}deg) scale(.94)`,
              },
              {
                offset: 0.76,
                transform: `rotate(${-7 + direction * 375}deg) scale(1.05)`,
              },
              { offset: 1, transform: `rotate(${-7 + direction * 360}deg)` },
            ],
          },
          {
            name: "dodge",
            duration: 720,
            frames: [
              { offset: 0, transform: rest },
              {
                offset: 0.22,
                transform: `translate(${direction * 42}px, -12px) rotate(${direction * 20 - 7}deg) scale(.9)`,
              },
              {
                offset: 0.46,
                transform: `translate(${direction * 38}px, -9px) rotate(${direction * 16 - 7}deg) scale(.92)`,
              },
              {
                offset: 0.76,
                transform: `translate(${-direction * 9}px, 2px) rotate(${-direction * 8 - 7}deg)`,
              },
              { offset: 1, transform: rest },
            ],
          },
          {
            name: "flip",
            duration: 800,
            frames: [
              {
                offset: 0,
                transform: "perspective(500px) rotateY(0deg) rotate(-7deg)",
              },
              {
                offset: 0.16,
                transform: `perspective(500px) rotateY(${-direction * 20}deg) rotate(-7deg)`,
              },
              {
                offset: 0.8,
                transform: `perspective(500px) rotateY(${direction * 380}deg) rotate(-7deg)`,
              },
              {
                offset: 1,
                transform: `perspective(500px) rotateY(${direction * 360}deg) rotate(-7deg)`,
              },
            ],
          },
          {
            name: "shake",
            duration: 600,
            frames: [
              { offset: 0, transform: rest },
              {
                offset: 0.18,
                transform: `translateX(${-direction * 10}px) rotate(${-7 - direction * 18}deg)`,
              },
              {
                offset: 0.36,
                transform: `translateX(${direction * 9}px) rotate(${-7 + direction * 16}deg)`,
              },
              {
                offset: 0.54,
                transform: `translateX(${-direction * 6}px) rotate(${-7 - direction * 11}deg)`,
              },
              {
                offset: 0.73,
                transform: `translateX(${direction * 3}px) rotate(${-7 + direction * 6}deg)`,
              },
              { offset: 1, transform: rest },
            ],
          },
          {
            name: "jelly",
            duration: 750,
            frames: [
              { offset: 0, transform: rest },
              {
                offset: 0.2,
                transform: "translateY(7px) rotate(-7deg) scale(1.22, .78)",
              },
              {
                offset: 0.4,
                transform: "translateY(-7px) rotate(-7deg) scale(.84, 1.17)",
              },
              {
                offset: 0.6,
                transform: "translateY(3px) rotate(-7deg) scale(1.1, .91)",
              },
              { offset: 0.8, transform: "rotate(-7deg) scale(.96, 1.04)" },
              { offset: 1, transform: rest },
            ],
          },
        ];
        const choices = effects
          .map((_, index) => index)
          .filter((index) => index !== lastEffect);
        lastEffect = choices[Math.floor(Math.random() * choices.length)]!;
        const effect = effects[lastEffect]!;
        clickAnimation = head.current?.animate(effect.frames, {
          duration: effect.duration,
          easing: "ease-out",
        });
        if (clickAnimation) clickAnimation.id = `mascot-${effect.name}`;
      }
      restoreExpressionLater();
    }

    const node = button.current!;
    node.addEventListener("pointerdown", startDrag);
    node.addEventListener("pointermove", moveDrag);
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
    node.addEventListener("lostpointercapture", endDrag);
    node.addEventListener("click", reactToClick);
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      clickAnimation?.cancel();
      node.removeEventListener("pointerdown", startDrag);
      node.removeEventListener("pointermove", moveDrag);
      node.removeEventListener("pointerup", endDrag);
      node.removeEventListener("pointercancel", endDrag);
      node.removeEventListener("lostpointercapture", endDrag);
      node.removeEventListener("click", reactToClick);
    };
  }, []);
  return (
    <div className="mascot">
      <button
        ref={button}
        className={`mascot-button ${dragging ? "dragging" : ""}`}
        style={{
          transform: `translate(${position.x}px,${position.y}px) rotate(${position.x * 0.08}deg)`,
        }}
        type="button"
        aria-label={t("pokeTheMascot")}
      >
        <span ref={head} className="mascot-head" aria-hidden="true">
          <img src={expression} alt="" draggable={false} />
        </span>
      </button>
    </div>
  );
}
