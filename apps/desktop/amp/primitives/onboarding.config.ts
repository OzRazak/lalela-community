/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-primitives — onboarding.config schema + the 3 archetype presets.
//
// No app hand-builds a flow: <Welcome>, <Checklist>, <Tour> and the teaching
// EmptyStates render from this per-app config. An agent PICKS a preset (A/B/C)
// and edits copy — it never designs a journey. The three shipped arrangements
// (the archetype recipes) are below; `resolveOnboarding` merges a preset with
// per-app overrides.
import type { MomentKind } from "./moments";
import type { EmptyStateTone } from "./EmptyState";
import type { Tour } from "./tour-types";

/** Mirrors `@auxo/amp-schema`'s Archetype (A dashboard / B tool / C desktop).
 *  Defined locally so a source-copied primitives folder needs only the
 *  @auxo/amp-react alias, not the schema package too. */
export type Archetype = "A" | "B" | "C";

/** Human-readable preset name; 1:1 with the manifest archetype letter. */
export type ArchetypePreset = "dashboard" | "tool" | "desktop";

export const ARCHETYPE_TO_PRESET: Record<Archetype, ArchetypePreset> = {
  A: "dashboard",
  B: "tool",
  C: "desktop",
};
export const PRESET_TO_ARCHETYPE: Record<ArchetypePreset, Archetype> = {
  dashboard: "A",
  tool: "B",
  desktop: "C",
};

export interface WelcomeConfig {
  id: string;
  title: string;
  body?: string;
  nextStep?: { label: string; href?: string };
  firstSessionOnly?: boolean;
}

export interface ChecklistStepConfig {
  id: string;
  label: string;
  hint?: string;
  action?: { label: string; href?: string };
}
export interface ChecklistConfig {
  id: string;
  title?: string;
  steps: ChecklistStepConfig[];
  completeMoment?: MomentKind;
  completeMessage?: string;
}

export interface TourConfig {
  /** Documents the trigger contract. Tours are ALWAYS opt-in — never auto-run. */
  trigger: "opt-in";
  tour: Tour;
}

export interface EmptyStateCopy {
  title: string;
  body?: string;
  mark?: boolean;
  tone?: EmptyStateTone;
  ghost?: boolean;
}

export interface OnboardingConfig {
  preset: ArchetypePreset;
  archetype: Archetype;
  /** Orientation card. Present on dashboard/tool, null on desktop. */
  welcome: WelcomeConfig | null;
  /** Just-in-time checklist. Present on dashboard only by default. */
  checklist: ChecklistConfig | null;
  /** Opt-in tour. Present on desktop by default; null = none offered. */
  tour: TourConfig | null;
  /** Teaching empty-state copy, keyed by surface id. */
  emptyStates: Record<string, EmptyStateCopy>;
}

// ── The three archetype recipes ─────────────────────────────────────────────
// A · dashboard — Welcome orientation card + teaching empties, NO forced tour.
const dashboardPreset: OnboardingConfig = {
  preset: "dashboard",
  archetype: "A",
  welcome: {
    id: "home",
    title: "Welcome — here's your workspace",
    body: "This is your home base. The panels below fill in as you work; start with the highlighted step.",
    nextStep: { label: "Take the first step" },
    firstSessionOnly: true,
  },
  checklist: {
    id: "getting-started",
    title: "Getting started",
    steps: [
      { id: "step-1", label: "Create your first item" },
      { id: "step-2", label: "Invite a teammate" },
      { id: "step-3", label: "Connect your data" },
    ],
    completeMoment: "capability-unlocked",
    completeMessage: "You're set up — nice work.",
  },
  tour: null, // dashboards teach through empties, not a forced walkthrough
  emptyStates: {
    default: {
      title: "Nothing here yet",
      body: "This is where your work will show up. Create your first one to see it here.",
      mark: true,
      tone: "neutral",
    },
  },
};

// B · tool — ONE welcome + ONE CTA. Lean; the tool's own surface does the rest.
const toolPreset: OnboardingConfig = {
  preset: "tool",
  archetype: "B",
  welcome: {
    id: "start",
    title: "Let's get your first result",
    body: "One step to value — do this and you'll see what this tool does for you.",
    nextStep: { label: "Start now" },
    firstSessionOnly: true,
  },
  checklist: null,
  tour: null,
  emptyStates: {
    default: {
      title: "Ready when you are",
      body: "Kick off your first run to see results here.",
      mark: true,
      tone: "neutral",
    },
  },
};

// C · desktop — empties FIRST; an opt-in tour offered after the first action.
const desktopPreset: OnboardingConfig = {
  preset: "desktop",
  archetype: "C",
  welcome: null, // desktop apps orient through the workspace + empties, not a card
  checklist: null,
  tour: {
    trigger: "opt-in",
    tour: {
      id: "show-me-around",
      title: "Show me around",
      description: "A quick tour of the main areas.",
      steps: [
        { target: "primary-action", title: "Start here", body: "This is where you create your first thing.", advance: "next" },
        { target: "nav-primary", title: "Where things live", body: "Everything you make lands here.", advance: "click" },
        { target: "nav-settings", title: "Make it yours", body: "Tune the defaults in Settings when you're ready.", advance: "next" },
      ],
    },
  },
  emptyStates: {
    default: {
      title: "Your workspace is empty",
      body: "Create your first item to get going — or take the quick tour.",
      mark: true,
      tone: "neutral",
    },
  },
};

export const ARCHETYPE_PRESETS: Record<ArchetypePreset, OnboardingConfig> = {
  dashboard: dashboardPreset,
  tool: toolPreset,
  desktop: desktopPreset,
};

/** Resolve a preset (by preset name OR archetype letter) merged with per-app
 *  overrides. Shallow-merges the top-level slots; a `null` override removes a
 *  slot, an object replaces it. */
export function resolveOnboarding(
  which: ArchetypePreset | Archetype,
  overrides: Partial<OnboardingConfig> = {},
): OnboardingConfig {
  const presetName: ArchetypePreset =
    which in ARCHETYPE_PRESETS
      ? (which as ArchetypePreset)
      : ARCHETYPE_TO_PRESET[which as Archetype];
  const base = ARCHETYPE_PRESETS[presetName];
  if (!base) throw new Error(`[amp] unknown archetype/preset "${which}"`);
  return {
    ...base,
    ...overrides,
    emptyStates: { ...base.emptyStates, ...(overrides.emptyStates ?? {}) },
  };
}
