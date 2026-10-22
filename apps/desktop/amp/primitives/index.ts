/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-primitives — the First-Mile onboarding layer.
// Every surface answers: Where am I? → What can I do? → What's my one next step?
// personality exists to make those answers land faster.

// Spark (behind an interface — @auxo/amp-marks injects the real one)
export {
  StubSpark,
  SparkProvider,
  useSpark,
  type SparkComponent,
  type SparkProps,
  type SparkState,
} from "./spark";

// Moments
export {
  MOMENT_KINDS,
  MOMENT_KEYS,
  getMoment,
  type Moment,
  type MomentKind,
} from "./moments";

// Scoreboard reporting — fire-and-forget moment ingestion (env-gated, opt-out-aware)
export {
  reportMoment,
  makeDedupeKey,
  momentsEnv,
  momentsEnabled,
  setMomentsEnabled,
  type MomentEvent,
  type MomentEvidence,
  type MomentBeneficiary,
} from "./report";

// Primitives
export { EmptyState, type EmptyStateProps, type EmptyStateTone } from "./EmptyState";
export { Welcome, type WelcomeProps, type WelcomeNextStep } from "./Welcome";
export { Checklist, type ChecklistProps, type ChecklistStep } from "./Checklist";
export { Tour, type TourProps } from "./Tour";
export { getTourById, type Tour as TourModel, type TourStep, type TourAdvance } from "./tour-types";
export {
  Milestone,
  resolveRung,
  type MilestoneProps,
  type MilestoneRung,
} from "./Milestone";

// Onboarding config + the 3 archetype presets
export {
  ARCHETYPE_PRESETS,
  ARCHETYPE_TO_PRESET,
  PRESET_TO_ARCHETYPE,
  resolveOnboarding,
  type OnboardingConfig,
  type Archetype,
  type ArchetypePreset,
  type WelcomeConfig,
  type ChecklistConfig,
  type ChecklistStepConfig,
  type TourConfig,
  type EmptyStateCopy,
} from "./onboarding.config";
