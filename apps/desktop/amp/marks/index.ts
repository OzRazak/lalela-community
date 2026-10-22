/* Amp kit · marks · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-marks — the Spark (Amp's estate mascot) as CSS/SVG.
// Load the stylesheet once (v4: `@import "amp/marks/spark.css";`, or import it
// in your global CSS) so the state × dial classes resolve.
export { Spark, type SparkProps } from "./Spark";
export { StaticMark, type StaticMarkProps } from "./StaticMark";
export {
  SPARK_STATES,
  DIALS,
  SPARK_GLYPH_PATH,
  SPARK_COLORS,
  SPARK_LABELS,
  sparkClassName,
  type SparkState,
  type Dial,
} from "./marks";
