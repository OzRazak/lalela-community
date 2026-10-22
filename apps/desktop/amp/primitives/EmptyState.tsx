/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — the teaching <EmptyState>.
//
// Signature-compatible with the estate's byte-identical Convex EmptyState
// ({title, body, action}) so the Wave-7.0c codemod is a ZERO call-site change.
// Adds three OPTIONAL affordances: `mark` (the Spark, sober static by default),
// `tone`, and an opt-in generic `ghost` skeleton preview of the filled state.
// It is sober-safe by design (the lint does NOT flag EmptyState) — at dial 0
// the only visible delta from the old bare component is a subtle static mark.
import type { ReactNode } from "react";
import { useDial, type Dial } from "@auxo/amp-react";
import { useSpark, type SparkState } from "./spark";

export type EmptyStateTone = "neutral" | "positive" | "sober";

export interface EmptyStateProps {
  /** Headline — what belongs here. */
  title: string;
  /** Why it's empty / what to do. Optional (kept as `body` for signature parity). */
  body?: ReactNode;
  /** One primary CTA. */
  action?: ReactNode;
  /**
   * The Spark mark. `true` (default) = the idle mark at the current dial;
   * `false` = no mark; a SparkState string = a specific expression. At dial 0
   * (or with the stub renderer) this is a static ink-on-yellow mark.
   */
  mark?: boolean | SparkState;
  /** Visual register. Default "neutral". "sober" forces the calm treatment. */
  tone?: EmptyStateTone;
  /** Opt-in: render ONE generic skeleton preview of the filled state behind the
   *  copy (the single reusable ghost treatment — never per-screen art). */
  ghost?: boolean;
  /** Override the ambient dial (else read from <AmpProvider>/<SoberZone>). */
  dial?: Dial;
  className?: string;
}

/** The one generic ghost: three faint skeleton rows. Purely decorative. */
function Ghost() {
  return (
    <div data-amp-ghost="" aria-hidden="true" className="amp-empty-ghost">
      <span className="amp-skel" style={{ width: "70%" }} />
      <span className="amp-skel" style={{ width: "90%" }} />
      <span className="amp-skel" style={{ width: "55%" }} />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  mark = true,
  tone = "neutral",
  ghost = false,
  dial,
  className,
}: EmptyStateProps) {
  const ambient = useDial();
  const effectiveDial = (dial ?? ambient) as Dial;
  const Spark = useSpark();

  const showMark = mark !== false;
  const state: SparkState =
    typeof mark === "string" ? mark : effectiveDial >= 2 ? "idle-breathe" : "idle-breathe";

  return (
    <div
      data-amp-empty=""
      data-amp-tone={tone}
      className={["amp-empty", className].filter(Boolean).join(" ")}
    >
      {ghost && <Ghost />}
      {showMark && (
        <span className="amp-empty-mark">
          <Spark state={state} dial={effectiveDial} size={44} />
        </span>
      )}
      <p className="amp-empty-title">{title}</p>
      {body != null && <p className="amp-empty-body">{body}</p>}
      {action != null && <div className="amp-empty-action">{action}</div>}
    </div>
  );
}
