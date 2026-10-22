import { useCallback, useRef } from "react";
import type React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

/**
 * A bottom-right resize grip for our frameless overlay windows.
 *
 * Why not `startResizeDragging("SouthEast")`: on macOS, tao (0.35.x) doesn't
 * implement `drag_resize_window` (it always returns `NotSupported`), so that
 * call silently does nothing. Instead we track the pointer ourselves: record
 * the start point + the window's logical size on pointerdown, capture the
 * pointer so tracking continues outside the grip, and `setSize` (rAF-throttled,
 * clamped to `min`/`max`) on every move until pointerup.
 *
 * Needs the `core:window:allow-set-size`, `allow-inner-size` and
 * `allow-scale-factor` permissions for the window. Spread the returned handlers
 * onto the grip element.
 */
export function useGripResize(opts: {
  min: { w: number; h: number };
  max?: { w: number; h: number };
}) {
  const { min, max } = opts;
  const active = useRef(false);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const pending = useRef<{ w: number; h: number } | null>(null);
  const frame = useRef<number | null>(null);

  const onPointerDown = useCallback(async (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    e.stopPropagation(); // never start a window drag on the grip
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    const x = e.screenX;
    const y = e.screenY;
    try {
      const win = getCurrentWindow();
      const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
      const logical = size.toLogical(scale);
      // The button may already be up (a quick click) — don't arm a stale drag.
      if (active.current) drag.current = { x, y, w: logical.width, h: logical.height };
    } catch {
      drag.current = null;
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      // Screen coordinates are in CSS (= logical) pixels and don't move with
      // the window, so the delta stays stable while the window grows.
      let w = Math.max(min.w, d.w + (e.screenX - d.x));
      let h = Math.max(min.h, d.h + (e.screenY - d.y));
      if (max) {
        w = Math.min(max.w, w);
        h = Math.min(max.h, h);
      }
      pending.current = { w: Math.round(w), h: Math.round(h) };
      if (frame.current != null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const next = pending.current;
        if (!next) return;
        getCurrentWindow()
          .setSize(new LogicalSize(next.w, next.h))
          .catch(() => {});
      });
    },
    [min.w, min.h, max?.w, max?.h],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    active.current = false;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    // A drag handler listening for mousedown higher up must not see the grip.
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  };
}
