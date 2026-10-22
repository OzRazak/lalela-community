/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-primitives — reportMoment: fire-and-forget moment ingestion.
//
// Wires a created value moment (a celebrated <Milestone>, or any explicit
// event) to the Atlas scoreboard's `POST /api/moments`. Two hard gates, both
// fail-closed:
//   1. ENV GATE — a silent no-op unless all three NEXT_PUBLIC_MOMENTS_* vars are
//      present. This is the estate's env-gated acceptance bar: a repo merges Amp
//      reporting INERT; Oz mints a per-app key in Atlas admin + sets the envs to
//      activate it (OZ-TODO). Nothing leaves the app until then.
//   2. OPT-OUT GATE — privacy-first apps (e.g. lalela) disable reporting even
//      when the env is present. The opt-out lives in `auxo-design.json`
//      (`moments: false`); it flows to <Milestone> via <AmpProvider moments>
//      → context, and to non-React callers via setMomentsEnabled(false).
//
// reportMoment never throws, never blocks, never awaits — reporting must never
// break or slow the app it's measuring.

import type { MomentKind } from "./moments";

/** Who the created value accrued to. Every moment is tagged so the scoreboard
 *  tallies stay re-sliceable (Wave 8 policy default: attribution & counting). */
export type MomentBeneficiary = "internal" | "client" | "end-user";

export interface MomentEvidence {
  /** Verbatim recognition quote — the evidence an exceptional moment needs. */
  quote?: string;
  /** What happened / why it mattered (always present). */
  context: string;
  /** Deep link to the artifact, so a reviewer can confirm it. */
  url?: string;
}

/** The payload shape Atlas `POST /api/moments` accepts (minus appId/appKey,
 *  which reportMoment injects from the env). */
export interface MomentEvent {
  /** One of the five estate MOMENT_KINDS. */
  kind: MomentKind;
  /** internal | client | end-user. */
  beneficiary: MomentBeneficiary;
  /** { context, quote?, url? }. */
  evidence: MomentEvidence;
  /** Who created the value (name/handle hint; the server may resolve it). */
  actorHint?: string;
  /** Minutes saved — feeds the 100M-hours metric (time-saved kind). */
  minutesSaved?: number;
  /** Idempotency key, unique within the app. Auto-derived when omitted. */
  dedupeKey?: string;
  /** ISO timestamp of the moment. Defaults to now. */
  ts?: string;
}

interface MomentsEnv {
  url: string;
  appId: string;
  key: string;
}

// Module opt-out. false = never report regardless of env (the non-React mirror
// of auxo-design.json `moments: false`). Default enabled → the env decides.
let reportingDisabled = false;

/**
 * Enable or hard-disable moment reporting for non-React call sites.
 * `setMomentsEnabled(false)` mirrors `moments: false` in auxo-design.json for
 * code that reports without an <AmpProvider> in scope. Passing `true` clears the
 * opt-out — it does NOT force reporting on; the env gate still applies.
 */
export function setMomentsEnabled(enabled: boolean): void {
  reportingDisabled = !enabled;
}

/** Trim an env value to a non-empty string, or undefined. */
function nonEmpty(v: string | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Resolve the endpoint + credentials from the env, or null when unconfigured.
 *
 *  CRITICAL — the env is read via THREE literal, static
 *  `process.env.NEXT_PUBLIC_MOMENTS_*` member accesses, never a computed
 *  `process.env[name]` lookup. Next.js inlines `NEXT_PUBLIC_*` into the CLIENT
 *  bundle ONLY on static dot-access; a dynamic key read is left un-inlined, so
 *  the values never reach the browser and every client-side `reportMoment`
 *  silently no-ops even once the keys are set. Keep these three reads literal —
 *  do not refactor them back into a loop or a name-keyed helper. The try/catch
 *  keeps the kit safe under plain Node and bundlers that don't define `process`
 *  (in Next, each access is already replaced by a string literal at build, so
 *  no bare `process` reference survives). */
export function momentsEnv(): MomentsEnv | null {
  let url: string | undefined;
  let appId: string | undefined;
  let key: string | undefined;
  try {
    url = nonEmpty(process.env.NEXT_PUBLIC_MOMENTS_URL);
    appId = nonEmpty(process.env.NEXT_PUBLIC_MOMENTS_APP_ID);
    key = nonEmpty(process.env.NEXT_PUBLIC_MOMENTS_KEY);
  } catch {
    return null;
  }
  if (!url || !appId || !key) return null;
  return { url, appId, key };
}

/** True only when a report would actually fire: env present AND not opted out.
 *  Used as the default for <Milestone report> ("true when env present"). */
export function momentsEnabled(): boolean {
  if (reportingDisabled) return false;
  return momentsEnv() !== null;
}

/** Deterministic, dependency-free dedupe key derived from a moment's identity
 *  fields (djb2). Two calls describing the same moment collapse server-side. */
export function makeDedupeKey(e: MomentEvent): string {
  const basis = [
    e.kind,
    e.beneficiary,
    e.actorHint ?? "",
    e.evidence?.url ?? "",
    e.evidence?.quote ?? e.evidence?.context ?? "",
  ].join("|");
  let h = 5381;
  for (let i = 0; i < basis.length; i++) {
    h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  }
  return `${e.kind}-${(h >>> 0).toString(36)}`;
}

/**
 * Fire-and-forget a moment to the Atlas scoreboard. No-ops silently when the
 * env is unconfigured or reporting is opted out. Never throws, never blocks,
 * ignores the response — a failed report must never surface to the user.
 */
export function reportMoment(event: MomentEvent): void {
  if (!momentsEnabled()) return; // gate 1 (env) + gate 2 (opt-out)
  const env = momentsEnv();
  if (!env) return;

  const payload = {
    appId: env.appId,
    appKey: env.key,
    kind: event.kind,
    beneficiary: event.beneficiary,
    evidence: event.evidence,
    actorHint: event.actorHint,
    minutesSaved: event.minutesSaved,
    dedupeKey: event.dedupeKey ?? makeDedupeKey(event),
    ts: event.ts ?? new Date().toISOString(),
  };

  try {
    const f: typeof fetch | undefined = typeof fetch !== "undefined" ? fetch : undefined;
    if (!f) return; // no fetch (old SSR runtime) — degrade to no-op
    // keepalive: survives a navigation/unload so the moment isn't lost.
    // credentials omitted: auth is the appKey in the body, not cookies.
    void f(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* swallow — reporting is best-effort */
    });
  } catch {
    /* never let reporting break the app */
  }
}
