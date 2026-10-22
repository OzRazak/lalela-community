/* Amp kit · marks · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { type CSSProperties } from "react";
import {
  SPARK_GLYPH_PATH,
  SPARK_LABELS,
  sparkClassName,
  type Dial,
  type SparkState,
} from "./marks";

export interface SparkProps {
  /** Expression state. Default: "idle-breathe". */
  state?: SparkState;
  /**
   * Playfulness dial 0–3. Drives the resolution:
   *   3 darting · 2 lively · 1 calm glow · 0 static ink-on-yellow.
   * Pass `useDial()` from the Amp runtime to bind it to the app dial.
   */
  dial?: Dial;
  /** Pixel size of the mark (square). Default: 64. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Decorative (default true) → aria-hidden, no role. Set false to expose it
   * as an image with a label (e.g. a standalone success mark).
   */
  decorative?: boolean;
  /** Overrides the default per-state aria-label when decorative={false}. */
  label?: string;
}

// 8 celebration rays at 45° increments, radius 30 → 42 from the 32,32 centre.
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return {
    x1: 32 + 30 * Math.cos(a),
    y1: 32 + 30 * Math.sin(a),
    x2: 32 + 42 * Math.cos(a),
    y2: 32 + 42 * Math.sin(a),
  };
});

/**
 * The Spark — Amp's estate mascot as pure CSS/SVG (no Rive/Lottie). Renders one
 * abstract-light sparkle; the state + dial CSS classes select the motion, and
 * dial 0 / prefers-reduced-motion collapse it to a static ink-on-yellow mark.
 * Requires ../spark.css (or the copied amp/marks/spark.css) to be loaded.
 */
export function Spark({
  state = "idle-breathe",
  dial = 3,
  size = 64,
  className,
  style,
  decorative = true,
  label,
}: SparkProps) {
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": label ?? SPARK_LABELS[state] } as const);

  return (
    <span
      {...a11y}
      className={[sparkClassName(state, dial), className].filter(Boolean).join(" ")}
      style={{ "--amp-spark-size": `${size}px`, ...style } as CSSProperties}
      data-amp-spark={state}
    >
      <span className="amp-spark__glow" aria-hidden="true" />
      <svg
        className="amp-spark__glyph"
        viewBox="0 0 64 64"
        aria-hidden="true"
        focusable="false"
      >
        <rect className="amp-spark__tile" x="3" y="3" width="58" height="58" rx="16" />
        <g className="amp-spark__rays">
          {RAYS.map((r, i) => (
            <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
          ))}
        </g>
        <path className="amp-spark__body" d={SPARK_GLYPH_PATH} />
        <circle className="amp-spark__satellite" cx="32" cy="7" r="3.5" />
        <path className="amp-spark__pointer" d="M50 49 l12 4 l-4 -12 z" />
      </svg>
    </span>
  );
}
