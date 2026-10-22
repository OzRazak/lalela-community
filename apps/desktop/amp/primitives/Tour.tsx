/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — <Tour>, the generalized Lalela tour engine.
//
// Ported from lalela apps/desktop/src/components/TourOverlay.tsx — the estate's
// working precedent — and made estate-neutral: no lucide, no app Button, no
// Tailwind class dependency (inline styles + Amp tokens). STRICTLY OPT-IN: the
// overlay renders only while `open` is true; nothing here auto-starts a tour.
// It spotlights a real element (found by its `data-tour-id`) with a dimmed
// backdrop + brand ring, anchors a card beside it, and — for click-advance
// steps — completes when the user clicks the real control. Fully keyboard
// navigable, and Next always works so a click step can never trap the user.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Tour } from "./tour-types";

export interface TourProps {
  tour: Tour;
  /** Opt-in gate — the overlay shows only when true. Default false. */
  open?: boolean;
  onClose: () => void;
  /** Called when the user reaches and advances past the final step. */
  onComplete?: (tourId: string) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_W = 340;
const PAD = 8; // spotlight breathing room
const GAP = 14; // target → card distance

/** Place the card beside the target (right, else below, else above); clamp to
 *  the viewport. */
function cardPosition(spot: Rect, cardH: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (spot.left + spot.width + GAP + CARD_W <= vw) {
    left = spot.left + spot.width + GAP;
    top = spot.top;
  } else if (spot.top + spot.height + GAP + cardH <= vh) {
    left = spot.left;
    top = spot.top + spot.height + GAP;
  } else {
    left = spot.left;
    top = spot.top - cardH - GAP;
  }
  left = Math.max(GAP, Math.min(left, vw - CARD_W - GAP));
  top = Math.max(GAP, Math.min(top, vh - cardH - GAP));
  return { top, left };
}

export function Tour({ tour, open = false, onClose, onComplete }: TourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Reset to step 0 each time the tour is (re)opened.
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open, tour.id]);

  const step = tour.steps[stepIndex];
  const total = tour.steps.length;
  const isLast = stepIndex === total - 1;
  const isFirst = stepIndex === 0;

  const finish = () => {
    onComplete?.(tour.id);
    onClose();
  };
  const goNext = () => (isLast ? finish() : setStepIndex((i) => i + 1));
  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));

  // Locate + track the target (it may mount after navigation); for click-advance
  // steps, complete when the user clicks the real control.
  useEffect(() => {
    if (!open || !step?.target) {
      setSpot(null);
      return;
    }
    let raf = 0;
    let listening: Element | null = null;
    let lastKey = "";
    const onTargetClick = () => {
      window.setTimeout(() => setStepIndex((i) => Math.min(i + 1, total - 1)), 0);
    };
    const tick = () => {
      const el = document.querySelector(`[data-tour-id="${step.target}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const next: Rect = {
          top: r.top - PAD,
          left: r.left - PAD,
          width: r.width + PAD * 2,
          height: r.height + PAD * 2,
        };
        const key = `${Math.round(next.top)}:${Math.round(next.left)}:${Math.round(next.width)}:${Math.round(next.height)}`;
        if (key !== lastKey) {
          lastKey = key;
          setSpot(next);
        }
        if (step.advance === "click" && listening !== el) {
          if (listening) listening.removeEventListener("click", onTargetClick);
          el.addEventListener("click", onTargetClick);
          listening = el;
        }
      } else if (lastKey !== "") {
        lastKey = "";
        setSpot(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (listening) listening.removeEventListener("click", onTargetClick);
    };
  }, [open, stepIndex, step?.target, step?.advance, total]);

  // Position the card once we know the spotlight + card height.
  useLayoutEffect(() => {
    if (!open) return;
    const cardH = cardRef.current?.offsetHeight ?? 200;
    if (spot) {
      setPos(cardPosition(spot, cardH));
    } else if (typeof window !== "undefined") {
      setPos({
        top: Math.max(GAP, (window.innerHeight - cardH) / 2),
        left: Math.max(GAP, (window.innerWidth - CARD_W) / 2),
      });
    }
  }, [open, spot, stepIndex]);

  // Keyboard: Esc skips, arrows/Enter navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open || !step) return null;
  const isClickStep = step.advance === "click" && !!step.target;

  return (
    // pointerEvents none on the root is load-bearing: the overlay must never
    // intercept clicks meant for the real UI — click-advance steps complete via
    // a listener ON the target element, so the click has to reach it. Only the
    // card re-enables pointer events. (The root previously swallowed all clicks,
    // dead-ending every click-advance step; never "fix" a tour problem by
    // intercepting clicks at the overlay.)
    <div data-amp-tour="" className="amp-tour" style={{ position: "fixed", inset: 0, zIndex: 80, pointerEvents: "none" }}>
      {spot ? (
        <div
          className="amp-tour-spotlight"
          style={{
            position: "fixed",
            pointerEvents: "none",
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            borderRadius: "var(--radius, 0.5rem)",
            border: "2px solid var(--color-primary, #ffd200)",
            boxShadow: "0 0 0 9999px rgba(20,19,17,0.55), 0 0 0 4px rgba(47,111,230,0.35)",
            transition:
              "top var(--amp-spatial-fast-duration, 150ms) var(--amp-spatial-fast-easing, ease), left var(--amp-spatial-fast-duration, 150ms) var(--amp-spatial-fast-easing, ease), width var(--amp-spatial-fast-duration, 150ms) var(--amp-spatial-fast-easing, ease), height var(--amp-spatial-fast-duration, 150ms) var(--amp-spatial-fast-easing, ease)",
          }}
        />
      ) : (
        <div
          style={{ position: "fixed", inset: 0, pointerEvents: "none", background: "rgba(20,19,17,0.55)" }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-label={tour.title}
        className="amp-tour-card"
        style={{
          position: "fixed",
          pointerEvents: "auto",
          width: CARD_W,
          maxWidth: "calc(100vw - 1.75rem)",
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          visibility: pos ? "visible" : "hidden",
          borderRadius: "var(--radius, 0.5rem)",
          border: "1px solid var(--color-border, #e2e8f0)",
          background: "var(--color-card, #fff)",
          color: "var(--color-foreground, #0f172a)",
          padding: "1rem",
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--color-muted-foreground, #64748b)",
            }}
          >
            {tour.title} · {stepIndex + 1}/{total}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Skip tour"
            style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--color-muted-foreground, #64748b)", padding: 4 }}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{step.title}</p>
        <p style={{ fontSize: 14, marginTop: 4, color: "var(--color-muted-foreground, #64748b)" }}>{step.body}</p>

        {isClickStep && (
          <p
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderRadius: "var(--radius, 0.5rem)",
              background: "color-mix(in srgb, var(--color-primary, #ffd200) 15%, transparent)",
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Click the highlighted control to continue.
          </p>
        )}

        {/* Progress dots — restored from lalela's source engine (the pilot found
            them missing): the "n/total" text alone doesn't show the shape of the
            walk; the dots do. The active dot widens, so it's not a colour-only
            signal (a11y). */}
        {total > 1 && (
          <div
            aria-hidden="true"
            style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6 }}
          >
            {tour.steps.map((_, i) => (
              <span
                key={i}
                style={{
                  height: 6,
                  width: i === stepIndex ? 16 : 6,
                  borderRadius: 9999,
                  background:
                    i === stepIndex
                      ? "var(--color-primary, #ffd200)"
                      : "var(--color-border, #e2e8f0)",
                  transition:
                    "width var(--amp-effect-fast-duration, 120ms) var(--amp-effect-fast-easing, ease)",
                }}
              />
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            type="button"
            onClick={goBack}
            disabled={isFirst}
            style={{
              border: 0,
              background: "transparent",
              cursor: isFirst ? "default" : "pointer",
              opacity: isFirst ? 0.4 : 1,
              color: "var(--color-muted-foreground, #64748b)",
              fontSize: 13,
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={goNext}
            style={{
              border: 0,
              borderRadius: "var(--radius, 0.5rem)",
              background: "var(--color-primary, #ffd200)",
              color: "var(--color-primary-foreground, #1a1a1a)",
              cursor: "pointer",
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {/* click-advance steps: "Skip step" makes clear that pressing this
                bypasses the highlighted control (lalela source-engine parity),
                so a click step can never trap or mislead the user. */}
            {isLast ? "Done" : isClickStep ? "Skip step" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
