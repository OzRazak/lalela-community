/* Amp kit · react · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { useContext, useMemo, type ElementType, type ReactNode } from "react";
import { AmpContext } from "./context";

export interface SoberZoneProps {
  children: ReactNode;
  /** Wrapper element type. Default: div. Use "section"/"main" as fits the DOM. */
  as?: ElementType;
  className?: string;
}

/**
 * Pins its subtree to dial 0 regardless of the app dial — consent, destructive
 * and legal surfaces. Stamps `data-amp="0"` + `data-amp-sober` so the token
 * CSS collapses motion to its calm resolution, and overrides context so
 * useDial() returns 0 and personality primitives render their sober form.
 */
export function SoberZone({ children, as, className }: SoberZoneProps) {
  const parent = useContext(AmpContext);
  const value = useMemo(
    () => ({ dial: 0 as const, reducedMotion: parent.reducedMotion, moments: parent.moments }),
    [parent.reducedMotion, parent.moments],
  );
  const Tag = (as ?? "div") as ElementType;

  return (
    <AmpContext.Provider value={value}>
      <Tag data-amp="0" data-amp-sober="" className={className}>
        {children}
      </Tag>
    </AmpContext.Provider>
  );
}
