// The ONE PostHog client the desktop app uses — shared by usage analytics
// (analytics.ts, ON by default, untickable) and crash reports
// (errorReporting.ts, opt-in). See docs/ANALYTICS.md and docs/DECISIONS.md.
//
// * Lazy: posthog-js is dynamically imported only when something is actually
//   allowed to send, so a person with both toggles off never loads it.
// * Every event goes through ONE `before_send` router:
//     `$exception`  → only if crash reports are on → errorScrub.scrubEvent,
//                     with a per-launch random id (never linked to a person);
//     named events  → only if usage data is on → analyticsCore.routeUsageEvent
//                     (allowlisted props, distinct id = Supabase user id when
//                     signed in, else a random per-install id);
//     anything else → dropped (no pageviews, autocapture, $set, …).
// * Same PostHog EU project as apps/web (the shared Auxo estate project,
//   ADR-010); events are told apart by the `app` super property.
import type { PostHog } from "posthog-js";
import { scrubEvent, type ScrubbableEvent } from "./errorScrub";
import { randomId, routeUsageEvent, type RouteState, type RoutableEvent } from "./analyticsCore";
import { getErrorReportsEnabled, getUsageDataEnabled } from "./settings";
import { IS_COMMUNITY } from "./edition";

export interface PosthogBuildConfig {
  key: string;
  host: string;
}

/** Build-time PostHog config. `VITE_POSTHOG_KEY` overrides the release
 *  default `VITE_POSTHOG_DEFAULT_KEY` (the shared estate project's public,
 *  write-only key, same as apps/web — it lives in edition/official.env); set
 *  it to `off` to build a binary that can never send. Dev builds (`vite dev` /
 *  `tauri dev`) only send when a key is set explicitly, so development never
 *  pollutes production dashboards. The Community edition never sends anything
 *  (TELEMETRY.md), whatever is set. */
export function posthogBuildConfig(): PosthogBuildConfig | null {
  if (IS_COMMUNITY) return null;
  const explicit = (import.meta.env.VITE_POSTHOG_KEY as string | undefined)?.trim();
  if (explicit?.toLowerCase() === "off") return null;
  if (!explicit && import.meta.env.DEV) return null;
  const key = explicit || import.meta.env.VITE_POSTHOG_DEFAULT_KEY?.trim();
  if (!key) return null;
  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined)?.trim().replace(/\/$/, "") ||
    "https://eu.i.posthog.com";
  return { key, host };
}

// ---- identity -------------------------------------------------------------

const INSTALL_ID_KEY = "lalela.analytics.installId";
const USER_ID_KEY = "lalela.analytics.userId";
const launchId = randomId();

/** Persistent random id for this install (never derived from anything). */
export function installId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

/** New anonymous id — on sign-out, so the next account on this machine is
 *  never merged with the previous one. */
export function rotateInstallId(): void {
  localStorage.setItem(INSTALL_ID_KEY, randomId());
}

/** The signed-in Supabase user id (never email), shared with other windows
 *  (the dictation overlay) through localStorage. */
export function setPosthogUserId(id: string | null): void {
  if (id) localStorage.setItem(USER_ID_KEY, id);
  else localStorage.removeItem(USER_ID_KEY);
}
export function posthogUserId(): string | null {
  return localStorage.getItem(USER_ID_KEY);
}

export function routeState(): RouteState {
  return {
    usageOn: getUsageDataEnabled(),
    crashOn: getErrorReportsEnabled(),
    installId: installId(),
    launchId,
    userId: posthogUserId(),
  };
}

/** True when anything at all may be sent from this build. */
export function posthogWanted(): boolean {
  return posthogBuildConfig() !== null && (getUsageDataEnabled() || getErrorReportsEnabled());
}

/** The before_send router (exported for tests via analyticsCore/errorScrub). */
function route(ev: RoutableEvent | null): RoutableEvent | null {
  if (!ev) return null;
  const s = routeState();
  let out: RoutableEvent | null;
  if (ev.event === "$exception") {
    if (!s.crashOn) return null;
    out = scrubEvent(ev as unknown as ScrubbableEvent) as unknown as RoutableEvent | null;
    if (out) out.properties.distinct_id = s.launchId;
  } else {
    out = routeUsageEvent(ev, s);
  }
  // No IP → location lookup on PostHog's side: we never want a city/country on
  // an event (and the App Store privacy label declares no location data).
  if (out) out.properties.$geoip_disable = true;
  return out;
}

// ---- client ---------------------------------------------------------------

let client: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;

/** Load + init posthog-js once. Resolves null when nothing may be sent. */
export function getPosthog(): Promise<PostHog | null> {
  const cfg = posthogBuildConfig();
  if (!cfg || !posthogWanted()) return Promise.resolve(null);
  if (client) {
    if (client.has_opted_out_capturing()) client.opt_in_capturing();
    return Promise.resolve(client);
  }
  loading ??= (async () => {
    try {
      const { default: posthog } = await import("posthog-js");
      posthog.init(cfg.key, {
        api_host: cfg.host,
        // We manage identity ourselves (routeState); nothing persisted by
        // posthog-js beyond this launch.
        persistence: "memory",
        bootstrap: { distinctID: installId() },
        person_profiles: "identified_only",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        rageclick: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_performance: false,
        // errorReporting.ts installs its own handlers so every report is scrubbed.
        capture_exceptions: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_product_tours: true,
        disable_conversations: true,
        disable_external_dependency_loading: true,
        advanced_disable_flags: true,
        save_referrer: false,
        save_campaign_params: false,
        before_send: (ev) => route(ev as unknown as RoutableEvent) as unknown as typeof ev,
      });
      client = posthog;
      return posthog;
    } catch {
      loading = null;
      return null; // Telemetry must never break the app.
    }
  })();
  return loading;
}

/** Re-evaluate after a toggle: stop immediately when both are off. */
export function syncPosthogConsent(): void {
  if (!client) return;
  if (posthogWanted()) {
    if (client.has_opted_out_capturing()) client.opt_in_capturing();
  } else {
    client.opt_out_capturing();
  }
}
