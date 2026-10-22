/* Amp kit · marks · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-marks — shared Spark geometry, types and helpers.
// Deliberately framework-agnostic and self-contained (no import from the Amp
// React runtime) so the shadcn-style source copy drops in cleanly on both
// estate eras. The visual behaviour lives in ../spark.css; the declarative
// contract lives in ../spark.tokens.json (lint-enforced).

/** The 7 Spark expression states. Order is canonical (matches spark.tokens.json). */
export const SPARK_STATES = [
  "idle-breathe",
  "blink",
  "dart",
  "celebrate-burst",
  "think",
  "shy",
  "point",
] as const;

export type SparkState = (typeof SPARK_STATES)[number];

/** Playfulness dial 0–3 (mirrors the Amp schema/runtime Dial type). */
export type Dial = 0 | 1 | 2 | 3;

export const DIALS: readonly Dial[] = [0, 1, 2, 3];

/**
 * The Spark glyph — a 4-point sparkle, abstract light, NO face. viewBox
 * `0 0 64 64`, centred at 32,32. One path serves every state and dial; only
 * the CSS treatment differs.
 */
export const SPARK_GLYPH_PATH =
  "M32 5 Q37 27 59 32 Q37 37 32 59 Q27 37 5 32 Q27 27 32 5 Z";

/** Default Spark colours (overridable via the --amp-spark-* CSS vars / tokens). */
export const SPARK_COLORS = { spark: "#ffd200", ink: "#1a1a1a" } as const;

/** Human-readable aria labels per state (used by <Spark> when decorative=false). */
export const SPARK_LABELS: Record<SparkState, string> = {
  "idle-breathe": "Spark",
  blink: "Spark",
  dart: "Spark pointing you somewhere",
  "celebrate-burst": "Success",
  think: "Working",
  shy: "Spark",
  point: "Spark pointing the way",
};

/** BEM-style class list for a Spark at a given state + dial (used by <Spark> and the demo). */
export function sparkClassName(state: SparkState, dial: Dial): string {
  return `amp-spark amp-spark--${state} amp-spark--dial-${dial}`;
}
