/* Amp kit · react · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
import { useEffect, useMemo, type ReactNode } from "react";
import { AmpContext, type Dial } from "./context";
import { useReducedMotion } from "./useReducedMotion";

export interface AmpProviderProps {
  /** The app's playfulness dial (from its auxo-design.json). */
  dial: Dial;
  children: ReactNode;
  /**
   * Whether <Milestone> celebrations may report to the moments scoreboard —
   * mirrors `moments` in auxo-design.json. Default true; privacy-first apps
   * (e.g. lalela) pass false to hard-disable reporting regardless of env.
   */
  moments?: boolean;
  /**
   * Element to stamp `data-amp` on. Defaults to the document root so global
   * CSS (motion.css, personality selectors) can key off the dial everywhere.
   */
  target?: "root" | HTMLElement | null;
}

/**
 * Root Amp provider. Stamps `data-amp="<dial>"` on the document root so the
 * token CSS can gate motion/personality by dial, exposes the dial + the OS
 * reduced-motion preference via context, and re-stamps if the dial changes.
 * SSR-safe: the DOM stamp happens in an effect, context is available in render.
 */
export function AmpProvider({ dial, children, moments = true, target = "root" }: AmpProviderProps) {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el =
      target === "root" || target == null
        ? document.documentElement
        : target;
    const prev = el.getAttribute("data-amp");
    el.setAttribute("data-amp", String(dial));
    return () => {
      if (prev === null) el.removeAttribute("data-amp");
      else el.setAttribute("data-amp", prev);
    };
  }, [dial, target]);

  const value = useMemo(() => ({ dial, reducedMotion, moments }), [dial, reducedMotion, moments]);

  return <AmpContext.Provider value={value}>{children}</AmpContext.Provider>;
}
