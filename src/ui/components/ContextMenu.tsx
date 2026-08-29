// Generic context menu: opens at pointer position, closes on Escape /
// outside press / selection, keyboard navigable. A full-viewport backdrop
// consumes the outside press so the UI underneath never reacts to it (no room
// selection, no view toggle) — and the button that opened the menu becomes a
// toggle for free, because its second press lands on the backdrop and only
// closes.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// The press that dismisses the menu still produces a trailing click after the
// backdrop unmounts, retargeted at whatever sits under the pointer (the old
// close-on-mousedown/reopen-on-click race). Swallow exactly that one click at
// the capture phase; the timeout covers presses that never produce a click
// (e.g. a touch drag).
function swallowNextClick() {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", cleanup, true);
    window.clearTimeout(timer);
  };
  window.addEventListener("click", swallow, true);
  // A NEW press is a new gesture — its click must go through. (The capture
  // listener can't fire for the press currently dispatching.)
  window.addEventListener("pointerdown", cleanup, true);
  const timer = window.setTimeout(cleanup, 600);
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** Open upward: `y` is treated as the anchor's bottom edge and the menu grows up. */
  up?: boolean;
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // When `up`, treat menu.y as the anchor's bottom edge and grow upward.
    const desiredTop = menu.up ? menu.y - r.height : menu.y;
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(desiredTop, window.innerHeight - r.height - 8)),
    });
  }, [menu]);

  useEffect(() => {
    const el = ref.current;
    el?.querySelector("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(el?.querySelectorAll("button") ?? [])];
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
        items[(next + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="ctx-backdrop"
        onPointerDown={(e) => {
          // Consume the outside press entirely (mouse AND touch — pointerdown
          // covers both): close the menu, keep the view exactly as-is.
          e.preventDefault();
          e.stopPropagation();
          swallowNextClick();
          onClose();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
        {menu.items.map((item, i) => (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
