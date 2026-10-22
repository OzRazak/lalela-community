/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — the <Welcome> orientation card.
//
// Answers the First-Mile trio on entry: WHERE am I (title) · WHAT can I do
// (body) · WHAT'S my one next step (nextStep). Dashboard-archetype surface.
// First-session only + dismissible + dismissal remembered:
//   • localStorage remembers "seen"/"dismissed" across sessions
//   • sessionStorage keeps it visible across in-session remounts (navigation)
//   • so it shows once, on the first session, and never nags again
// Optimistic first render (visible) keeps it SSR/demo-visible and avoids a
// hydration mismatch; an effect hides it for returning/dismissed users.
import { useEffect, useState, type ReactNode } from "react";
import { useDial, type Dial } from "@auxo/amp-react";
import { useSpark } from "./spark";

export interface WelcomeNextStep {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface WelcomeProps {
  /** Stable id — scopes the localStorage/sessionStorage keys. */
  id: string;
  /** WHERE am I. e.g. "Welcome to Memeza". */
  title: string;
  /** WHAT can I do here. */
  body?: ReactNode;
  /** The ONE next step. Rendered as the primary affordance. */
  nextStep?: WelcomeNextStep;
  /** Show only on the first session (default true). false = until dismissed. */
  firstSessionOnly?: boolean;
  /** Show the Spark (pointing) at dial ≥ 2. Default true. */
  showMark?: boolean;
  onDismiss?: () => void;
  dial?: Dial;
  className?: string;
  children?: ReactNode;
}

function readLS(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function writeLS(key: string, val: string) {
  try {
    window.localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}
function inThisSession(key: string): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function markThisSession(key: string) {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    /* ignore */
  }
}

export function Welcome({
  id,
  title,
  body,
  nextStep,
  firstSessionOnly = true,
  showMark = true,
  onDismiss,
  dial,
  className,
  children,
}: WelcomeProps) {
  const ambient = useDial();
  const effectiveDial = (dial ?? ambient) as Dial;
  const Spark = useSpark();

  const lsKey = `amp:welcome:${id}`;
  const sessKey = `amp:welcome:${id}:session`;
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const stored = readLS(lsKey);
    if (stored === "dismissed") {
      setVisible(false);
      return;
    }
    if (firstSessionOnly && stored === "seen" && !inThisSession(sessKey)) {
      // A past session already saw it, and this is a new session → don't nag.
      setVisible(false);
      return;
    }
    // Showing it now: remember it's been seen, and pin it for this session.
    if (stored == null) writeLS(lsKey, "seen");
    markThisSession(sessKey);
    setVisible(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsKey, sessKey, firstSessionOnly]);

  if (!visible) return null;

  const dismiss = () => {
    writeLS(lsKey, "dismissed");
    setVisible(false);
    onDismiss?.();
  };

  return (
    <section
      data-amp-welcome=""
      data-amp-dial={effectiveDial}
      className={["amp-welcome", className].filter(Boolean).join(" ")}
      aria-label={title}
    >
      <button type="button" className="amp-welcome-dismiss" onClick={dismiss} aria-label="Dismiss">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      </button>
      <div className="amp-welcome-head">
        {showMark && effectiveDial >= 2 && (
          <span className="amp-welcome-mark">
            <Spark state="point" dial={effectiveDial} size={36} />
          </span>
        )}
        <h2 className="amp-welcome-title">{title}</h2>
      </div>
      {body != null && <p className="amp-welcome-body">{body}</p>}
      {children}
      {nextStep &&
        (nextStep.href ? (
          <a className="amp-welcome-cta" href={nextStep.href} onClick={nextStep.onClick}>
            {nextStep.label}
          </a>
        ) : (
          <button type="button" className="amp-welcome-cta" onClick={nextStep.onClick}>
            {nextStep.label}
          </button>
        ))}
    </section>
  );
}
