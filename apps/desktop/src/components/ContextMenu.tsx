import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** One row in a right-click menu. A `submenu` turns the row into a hover-to-open
 * parent (its own `onClick` is ignored); otherwise clicking fires `onClick` and
 * closes the menu. */
export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  submenu?: ContextMenuItem[];
  danger?: boolean;
  disabled?: boolean;
  /** Draw a hairline divider above this row. */
  separatorBefore?: boolean;
  /** Show a check/dot — used for the current value inside a submenu. */
  active?: boolean;
}

interface ContextMenuProps {
  /** Viewport coordinates of the click (from `onContextMenu`'s clientX/Y). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_MIN_WIDTH = 208; // px, matches w-52

/** A floating right-click menu. Dismisses on Escape, outside click, scroll or
 * resize. There is no menu primitive in the app or the Amp kit, so this is the
 * shared one for A6 (meeting rows + folder rows). */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);

  // Clamp into the viewport once measured (so a menu opened near the right/
  // bottom edge stays fully visible).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const nx = Math.min(x, window.innerWidth - width - pad);
    const ny = Math.min(y, window.innerHeight - height - pad);
    setPos({ x: Math.max(pad, nx), y: Math.max(pad, ny) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // `true` (capture) so scroll on any ancestor closes the menu.
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Submenus flip to the left when the menu is near the right edge.
  const flipLeft = x > window.innerWidth * 0.6;

  const renderItems = (list: ContextMenuItem[], depth: number) => (
    <div
      className={cn(
        "min-w-52 rounded-[var(--radius)] border border-border bg-card p-1 shadow-lg",
        depth === 0 ? "" : "shadow-xl",
      )}
      style={{ minWidth: MENU_MIN_WIDTH }}
      role="menu"
    >
      {list.map((item, i) => {
        const hasSub = !!item.submenu?.length;
        const row = (
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled || hasSub) return;
              onClose();
              item.onClick?.();
            }}
            onMouseEnter={() => depth === 0 && setOpenSub(hasSub ? i : null)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[calc(var(--radius)-2px)] px-2.5 py-1.5 text-left text-sm",
              item.disabled
                ? "cursor-not-allowed opacity-40"
                : item.danger
                  ? "text-danger hover:bg-danger/10"
                  : "text-foreground hover:bg-muted",
            )}
          >
            {item.icon && <span className="flex h-4 w-4 shrink-0 items-center">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            {hasSub && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
          </button>
        );
        return (
          <div key={`${depth}-${i}-${item.label}`}>
            {item.separatorBefore && <div className="my-1 h-px bg-border" />}
            {/* No onMouseLeave here: the submenu is a DOM descendant, so it
                stays open while hovered; hovering any other row switches/closes
                it via onMouseEnter. This avoids a flicker across the parent→
                submenu transit gap. */}
            <div className="relative">
              {row}
              {hasSub && openSub === i && (
                <div
                  className={cn(
                    "absolute top-0 z-10",
                    flipLeft ? "right-full mr-0.5" : "left-full ml-0.5",
                  )}
                >
                  {/* Submenu can be tall (folder tree) — cap it and scroll. */}
                  <div className="max-h-72 overflow-y-auto">
                    {renderItems(item.submenu!, depth + 1)}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Click-away catcher. */}
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        ref={ref}
        className="fixed z-[61]"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {renderItems(items, 0)}
      </div>
    </>
  );
}
