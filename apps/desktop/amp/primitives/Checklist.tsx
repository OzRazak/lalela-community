/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — the just-in-time <Checklist>.
//
// 3–5 real "aha" steps, completion driven by the app (each step's `done` is
// controlled). Exactly ONE completion celebration hook: when every step is
// done it fires `onComplete` once and renders an inline <Milestone> (dial-gated,
// so at dial 0 it's a quiet typed check). Not a nag — it's the earned reward at
// the end of the first mile.
import { useEffect, useRef, type ReactNode } from "react";
import { useDial, type Dial } from "@auxo/amp-react";
import { Milestone } from "./Milestone";
import type { MomentKind } from "./moments";

export interface ChecklistStep {
  id: string;
  label: ReactNode;
  /** Controlled completion — the app flips this as the user does real work. */
  done?: boolean;
  hint?: ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
}

export interface ChecklistProps {
  /** Stable id — scopes the once-per-browser completion celebration. */
  id: string;
  title?: ReactNode;
  /** 3–5 steps (a dev warning fires outside that range; it still renders). */
  steps: ChecklistStep[];
  /** Fired once, when the final step completes. Wire your own celebration here. */
  onComplete?: () => void;
  /** The MOMENT_KIND for the built-in completion Milestone. Default capability-unlocked. */
  completeMoment?: MomentKind;
  /** Warm one-liner for the completion Milestone. */
  completeMessage?: ReactNode;
  /** Render the built-in completion Milestone (default true). */
  celebrateOnComplete?: boolean;
  dial?: Dial;
  className?: string;
}

export function Checklist({
  id,
  title,
  steps,
  onComplete,
  completeMoment = "capability-unlocked",
  completeMessage,
  celebrateOnComplete = true,
  dial,
  className,
}: ChecklistProps) {
  const ambient = useDial();
  const effectiveDial = (dial ?? ambient) as Dial;

  const doneCount = steps.filter((s) => s.done).length;
  const complete = steps.length > 0 && doneCount === steps.length;
  const firedRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && (steps.length < 3 || steps.length > 5)) {
      // Not fatal — the spec is 3–5 just-in-time steps; flag drift in dev only.
      console.warn(`[amp] <Checklist id="${id}"> has ${steps.length} steps; the spec is 3–5.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, id]);

  useEffect(() => {
    if (complete && !firedRef.current) {
      firedRef.current = true;
      onComplete?.();
    }
    if (!complete) firedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete]);

  return (
    <section
      data-amp-checklist=""
      data-amp-complete={complete ? "" : undefined}
      className={["amp-checklist", className].filter(Boolean).join(" ")}
      aria-label={typeof title === "string" ? title : "Getting started"}
    >
      {title != null && (
        <header className="amp-checklist-head">
          <span className="amp-checklist-title">{title}</span>
          <span className="amp-checklist-count" aria-hidden="true">
            {doneCount}/{steps.length}
          </span>
        </header>
      )}
      <ol className="amp-checklist-steps">
        {steps.map((s) => (
          <li
            key={s.id}
            data-amp-step=""
            data-amp-done={s.done ? "" : undefined}
            className="amp-checklist-step"
          >
            <span className="amp-checklist-bullet" aria-hidden="true">
              {s.done ? (
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 10.5l4 4 8-9" />
                </svg>
              ) : null}
            </span>
            <span className="amp-checklist-text">
              <span className="amp-checklist-label">{s.label}</span>
              {s.hint != null && <span className="amp-checklist-hint">{s.hint}</span>}
            </span>
            {!s.done && s.action && (
              s.action.href ? (
                <a className="amp-checklist-action" href={s.action.href} onClick={s.action.onClick}>
                  {s.action.label}
                </a>
              ) : (
                <button type="button" className="amp-checklist-action" onClick={s.action.onClick}>
                  {s.action.label}
                </button>
              )
            )}
          </li>
        ))}
      </ol>
      {complete && celebrateOnComplete && (
        <div className="amp-checklist-done">
          <Milestone
            kind={completeMoment}
            id={`checklist:${id}`}
            message={completeMessage}
            dial={effectiveDial}
          />
        </div>
      )}
    </section>
  );
}
