// Anonymous product usage analytics (PostHog EU) — the ONE front door for
// usage events on desktop. Event names + allowed properties live in
// analyticsCore.ts; the dictionary for dashboards is docs/ANALYTICS.md.
//
// * ON by default; the person can untick Settings ▸ Privacy ▸ "Share anonymous
//   usage data" (or the first-run screen). Off = nothing sent from that moment
//   (opt_out_capturing + the before_send gate), and it persists.
// * Never content: no recordings, transcripts, notes, summaries, titles,
//   names, emails, file names, prompts or AI output. Properties are closed
//   enums, booleans or bucketed numbers (enforced in analyticsCore.ts).
// * Identity: a random per-install id; when signed in, the Supabase user id
//   (never the email) so desktop + web join up as one person in PostHog.
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { PostHog } from "posthog-js";
import type { EventName, EventProps } from "./analyticsCore";
import { getPosthog, posthogBuildConfig, setPosthogUserId, syncPosthogConsent } from "./posthog";
import { getUsageDataEnabled, USAGE_DATA_EVENT } from "./settings";
import { IS_ANDROID, IS_IOS, IS_MACOS, IS_WINDOWS } from "./platform";
import { DISTRIBUTION } from "./distribution";

export {
  aiErrorKind,
  countBucket,
  durationBucket,
  importFormat,
  isInternalEmail,
  modelFamily,
} from "./analyticsCore";

/** The public privacy policy (Settings, onboarding, docs all link here). */
export const PRIVACY_POLICY_URL = "https://lalela.auxodigital.africa/privacy";

/** True when this build can send and the person hasn't opted out. */
export function usageAnalyticsActive(): boolean {
  return posthogBuildConfig() !== null && getUsageDataEnabled();
}

/** True when this build can send telemetry at all (controls are shown). */
export function telemetryCapable(): boolean {
  return posthogBuildConfig() !== null;
}

// ---- super properties ------------------------------------------------------

const extraSuper: Record<string, unknown> = {};
let baseSuper: Promise<Record<string, unknown>> | null = null;

function fallbackPlatform(): string {
  if (IS_IOS) return "ios";
  if (IS_ANDROID) return "android";
  if (IS_WINDOWS) return "windows";
  if (IS_MACOS) return "macos";
  return "unknown";
}

async function computeBaseSuper(): Promise<Record<string, unknown>> {
  let app_version = "unknown";
  try {
    app_version = await getVersion();
  } catch {
    /* non-Tauri (tests) */
  }
  let platform = fallbackPlatform();
  let arch = "unknown";
  try {
    const [os, a] = await invoke<[string, string]>("build_target");
    platform = os;
    arch = a;
  } catch {
    /* older backend */
  }
  return { app: "lalela-desktop", app_version, platform, arch, distribution: DISTRIBUTION };
}

/** Register the super properties (app, version, platform, arch,
 *  distribution, signed_in, plan) on the shared client. */
export async function ensureSuperProps(ph: PostHog): Promise<void> {
  baseSuper ??= computeBaseSuper();
  ph.register({ ...(await baseSuper), ...extraSuper });
}

/** Update a super property (signed_in, plan) for every later event. */
export function setSuperProp(key: "signed_in" | "plan", value: boolean | string): void {
  extraSuper[key] = value;
  if (!usageAnalyticsActive()) return;
  void getPosthog().then((ph) => ph?.register({ [key]: value }));
}

export async function appVersion(): Promise<string> {
  baseSuper ??= computeBaseSuper();
  return String((await baseSuper).app_version);
}

// ---- capture -----------------------------------------------------------------

/** Send one named usage event. No-op when usage data is off. Never throws. */
export function trackEvent<E extends EventName>(name: E, props: EventProps<E> = {} as EventProps<E>): void {
  if (!usageAnalyticsActive()) return;
  void getPosthog()
    .then(async (ph) => {
      if (!ph || !usageAnalyticsActive()) return;
      await ensureSuperProps(ph);
      ph.capture(name, props as Record<string, unknown>);
    })
    .catch(() => {});
}

/** Send a one-time event (guarded in localStorage, per install). */
export function trackOnce<E extends EventName>(name: E, props?: EventProps<E>): void {
  const key = `lalela.analytics.once.${name}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "1");
  trackEvent(name, props);
}

/** Link this install to a signed-in account (Supabase user id only) and
 *  flag team accounts so dashboards can filter them out. */
export function identifyUser(userId: string, isInternal: boolean): void {
  setPosthogUserId(userId);
  if (!usageAnalyticsActive()) return;
  void getPosthog()
    .then((ph) => {
      if (!ph || !usageAnalyticsActive()) return;
      // Sent as a `$identify` event; the before_send router sets
      // distinct_id = userId and $anon_distinct_id = this install's id, and
      // lets only the `is_internal` person property through.
      ph.capture("$identify", { $set: { is_internal: isInternal } }, { $set: { is_internal: isInternal } });
    })
    .catch(() => {});
}

// ---- AI call bookkeeping (summary_generated needs the route that ran) -------

let lastAi: { route: string; model: string } | null = null;
export function noteAiCall(route: string, model: string): void {
  lastAi = { route, model };
}
export function lastAiCall(): { route: string; model: string } | null {
  return lastAi;
}
/** Route string → the closed analytics list. */
export function aiRouteLabel(route: string | null | undefined): "local" | "apple" | "byok" | "free" | "none" {
  return route === "local" || route === "apple" || route === "byok" || route === "free" ? route : "none";
}

// ---- recording timer (recording_stopped duration bucket) ---------------------

let recordingStartedAt: number | null = null;
export function markRecordingStarted(): void {
  recordingStartedAt = Date.now();
}
/** Milliseconds since the recording started (0 when unknown); resets. */
export function takeRecordingDuration(): number {
  const ms = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
  recordingStartedAt = null;
  return ms;
}

/** The activation milestone: first recording or import on this install. */
export function markMeetingCaptured(source: "recording" | "import"): void {
  trackOnce("first_meeting_captured", { source });
}

// ---- startup -----------------------------------------------------------------

const LAST_VERSION_KEY = "lalela.analytics.lastVersion";
let started = false;

/** Called once from main.tsx: app_opened (+ first_launch), and react to the
 *  usage toggle immediately. Auth + sync tracking: analyticsAuth.ts. */
export function initAnalytics(opts: { firstRun: boolean }): void {
  if (started) return;
  started = true;
  window.addEventListener(USAGE_DATA_EVENT, () => syncPosthogConsent());
  if (!usageAnalyticsActive()) return;
  void appVersion().then((version) => {
    const prev = localStorage.getItem(LAST_VERSION_KEY);
    localStorage.setItem(LAST_VERSION_KEY, version);
    if (opts.firstRun) trackOnce("first_launch");
    trackEvent("app_opened", {
      first_run: opts.firstRun,
      signed_in: extraSuper.signed_in === true,
      updated: prev !== null && prev !== version,
      ...(prev && prev !== version ? { previous_version: prev } : {}),
    });
  });
}
