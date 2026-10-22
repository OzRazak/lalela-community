/* Amp kit · marks · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { type CSSProperties } from "react";
import { SPARK_GLYPH_PATH, type Dial, type SparkState } from "./marks";

export interface StaticMarkProps {
  /**
   * Optional state flavour — kept for parity with <Spark>, but a StaticMark
   * NEVER animates. Empty states use this. Default: "idle-breathe".
   */
  state?: SparkState;
  /**
   * The app dial. A StaticMark is always static ink-on-yellow; higher dials
   * only add a soft *static* halo so a dial-3 empty state feels a touch warmer.
   */
  dial?: Dial;
  /** Pixel size (square). Default: 96 (empty-state scale). */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** aria-label; default "" (decorative). Empty states usually pair it with copy. */
  label?: string;
}

/**
 * The static ink-on-yellow Spark mark — the empty-state art for every dial. It
 * reuses the dial-0 resolution (ink glyph on a yellow tile) unconditionally, so
 * it is identical whether motion is allowed or not: safe, high-contrast, sober.
 * Requires ../spark.css (or the copied amp/marks/spark.css).
 */
export function StaticMark({
  state = "idle-breathe",
  dial = 0,
  size = 96,
  className,
  style,
  label,
}: StaticMarkProps) {
  const decorative = !label;
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": label } as const);

  return (
    <span
      {...a11y}
      className={[
        // dial-0 class forces the static ink-on-yellow treatment in spark.css
        `amp-spark amp-spark--${state} amp-spark--dial-0`,
        `amp-static-mark amp-static-mark--dial-${dial}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--amp-spark-size": `${size}px`, ...style } as CSSProperties}
      data-amp-static-mark=""
    >
      <span className="amp-spark__glow" aria-hidden="true" />
      <svg className="amp-spark__glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect className="amp-spark__tile" x="3" y="3" width="58" height="58" rx="16" />
        <path className="amp-spark__body" d={SPARK_GLYPH_PATH} />
      </svg>
    </span>
  );
}
