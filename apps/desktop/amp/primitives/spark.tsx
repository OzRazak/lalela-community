/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — the Spark, behind an interface.
//
// The animated Spark lives in `@auxo/amp-marks` (built in parallel). Primitives
// must NOT hard-import it: (1) marks may not be merged yet, and (2) marks is a
// personality source the Amp lint forbids inside sober paths — a static import
// would drag personality into every EmptyState, including dial-0 ones. So the
// primitives depend only on this SparkComponent contract, defaulting to a
// dependency-free sober stub. When marks ships, an app injects the real Spark
// via <SparkProvider component={Spark}> (or marks re-exports one) — zero churn
// to the primitives.
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { Dial } from "@auxo/amp-react";

/** The 7 Spark expression states (mirrors the marks package / Spark Bible). */
export type SparkState =
  | "idle-breathe"
  | "blink"
  | "dart"
  | "celebrate-burst"
  | "think"
  | "shy"
  | "point";

export interface SparkProps {
  /** Expression to render. Default: "idle-breathe". */
  state?: SparkState;
  /** Playfulness dial — picks the resolution (0 = static ink-on-yellow). */
  dial?: Dial;
  /** Pixel size of the mark. Default 40. */
  size?: number;
  className?: string;
  title?: string;
}

/** The contract any Spark renderer satisfies — the real one from @auxo/amp-marks
 *  or the sober stub below. */
export type SparkComponent = (props: SparkProps) => ReactElement | null;

/**
 * The sober fallback: the dial-0 static mark — an ink dot centred on the brand
 * yellow, no motion, no @auxo/amp-marks dependency. Every dial renders this
 * same calm mark until a real Spark is injected, so a primitive is never
 * personality-coupled by default and is safe to render in a <SoberZone>.
 */
export const StubSpark: SparkComponent = ({ size = 40, className, dial = 0, title }) => {
  const dot = Math.max(4, Math.round(size * 0.22));
  return (
    <span
      role="img"
      aria-hidden={title ? undefined : "true"}
      aria-label={title}
      data-amp-spark="stub"
      data-amp-spark-dial={dial}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "9999px",
        background: "var(--color-primary, #ffd200)",
        flex: "0 0 auto",
      }}
    >
      <span
        style={{
          width: dot,
          height: dot,
          borderRadius: "9999px",
          background: "var(--color-primary-foreground, #1a1a1a)",
        }}
      />
    </span>
  );
};

const SparkContext = createContext<SparkComponent>(StubSpark);

/** Inject a real Spark renderer for a subtree. `@auxo/amp-marks` supplies the
 *  animated component; wrap your app root once and every primitive upgrades. */
export function SparkProvider({
  component,
  children,
}: {
  component: SparkComponent;
  children: ReactNode;
}) {
  return <SparkContext.Provider value={component}>{children}</SparkContext.Provider>;
}

/** The active Spark renderer for the current subtree — injected, or the stub. */
export function useSpark(): SparkComponent {
  return useContext(SparkContext);
}
