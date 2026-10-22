/* Amp kit · react · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { createContext } from "react";

export type Dial = 0 | 1 | 2 | 3;

export interface AmpContextValue {
  /** The effective playfulness dial for this subtree. */
  dial: Dial;
  /** True when the OS requests reduced motion — JS-driven motion must honour it. */
  reducedMotion: boolean;
  /**
   * Whether <Milestone> celebrations may report to the moments scoreboard.
   * Mirrors `moments` in auxo-design.json (default true; privacy-first apps
   * like lalela set false). Defaulting true keeps existing providers unchanged.
   */
  moments: boolean;
}

/** Default: sober (dial 0), reduced-motion off, reporting allowed — the safe
 *  SSR baseline (the env still gates whether anything actually leaves the app). */
export const AmpContext = createContext<AmpContextValue>({
  dial: 0,
  reducedMotion: false,
  moments: true,
});
