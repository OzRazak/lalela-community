/* Amp kit · react · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { useContext } from "react";
import { AmpContext, type Dial } from "./context";

/**
 * The effective playfulness dial for the current subtree — the app dial from
 * <AmpProvider>, or 0 inside a <SoberZone>. Personality primitives read this
 * to pick their dial resolution.
 */
export function useDial(): Dial {
  return useContext(AmpContext).dial;
}

/** The full Amp context: `{ dial, reducedMotion, moments }`. */
export function useAmp() {
  return useContext(AmpContext);
}
