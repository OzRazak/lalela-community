/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-primitives — the estate's five MOMENT_KINDS, typed.
// Source of truth: auxo-2026/lib/theme.ts `MOMENT_KINDS` (the mission
// scoreboard). Kept verbatim here so <Milestone kind> is semantic — the type
// tells the user what kind of value they just created (comprehension wearing a
// party hat), not a generic "success!". Only "exceptional-recognised" carries
// `accent: true` — the ONLY kind that may earn the full yellow burst.

export interface Moment {
  /** Stable machine key used in props, config and lint. */
  key: string;
  /** Human label shown in the quiet typed check. */
  title: string;
  /** One-line description of the value kind (from the scoreboard). */
  detail: string;
  /** True only for "Exceptional recognised" — gates the full-burst rung. */
  accent: boolean;
}

export const MOMENT_KINDS = [
  {
    key: "time-saved",
    title: "Time saved",
    detail: "A team avoids manual work, repetitive admin or slow document handling.",
    accent: false,
  },
  {
    key: "capability-unlocked",
    title: "Capability unlocked",
    detail: "A person can now do something faster, better or with more confidence.",
    accent: false,
  },
  {
    key: "decision-improved",
    title: "Decision improved",
    detail: "A tool, dashboard or AI assistant helps someone make a clearer decision.",
    accent: false,
  },
  {
    key: "experience-improved",
    title: "Experience improved",
    detail: "A client, user or employee feels the work was meaningfully easier or better.",
    accent: false,
  },
  {
    key: "exceptional-recognised",
    title: "Exceptional recognised",
    detail: "Someone explicitly says the output, service or experience was exceptional.",
    accent: true,
  },
] as const satisfies readonly Moment[];

/** Union of the five valid moment keys. */
export type MomentKind = (typeof MOMENT_KINDS)[number]["key"];

const BY_KEY = new Map<string, Moment>(MOMENT_KINDS.map((m) => [m.key, m]));

/** Resolve a moment definition by key. Throws on an unknown key so a typo can't
 *  silently render a wrong celebration. */
export function getMoment(kind: MomentKind): Moment {
  const m = BY_KEY.get(kind);
  if (!m) throw new Error(`[amp] unknown MOMENT_KIND "${kind}"`);
  return m;
}

export const MOMENT_KEYS = MOMENT_KINDS.map((m) => m.key) as MomentKind[];
