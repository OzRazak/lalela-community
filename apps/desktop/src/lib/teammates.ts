// Same-domain teammate discovery (Wave D2). A user whose colleagues already use
// Lalela has no way to find them — folder sharing is by email but there's no
// discovery. This module surfaces OTHER users on the caller's own email domain
// (their company) so they can invite/share.
//
// PRIVACY: the ONLY read path is the SECURITY DEFINER RPC same_domain_profiles()
// (docs/sql/phase28_domain_suggestions.sql) — it excludes consumer/webmail
// domains, excludes the caller, caps at 20, and never widens the profiles table
// policy. The client never queries profiles directly for discovery.

import { supabase } from "@/lib/supabase";

export interface Teammate {
  display_name: string | null;
  email: string;
}

/** Consumer / free-webmail domains — a shared domain here does NOT imply a
 *  shared company, so the feature stays dark for these users. Mirrors the
 *  hardcoded list in the SQL function (client-side short-circuit so we never
 *  even fire the RPC for a consumer-domain user). */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "msn.com",
]);

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/** True for signed-out, malformed, or consumer-domain addresses — i.e. anyone
 *  the same-domain feature should never render for. */
export function isConsumerDomain(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  return !domain || CONSUMER_DOMAINS.has(domain);
}

// Small in-memory cache so the Settings block and the sign-in nudge don't each
// fire the RPC. TTL keeps it fresh enough; cleared on sign-out via clearCache().
let cache: { at: number; data: Teammate[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function clearTeammatesCache() {
  cache = null;
}

/** Same-domain teammates via the privacy-safe RPC. Returns [] on any error, for
 *  consumer domains, or when signed out — callers render nothing on empty. */
export async function sameDomainProfiles(force = false): Promise<Teammate[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const { data, error } = await supabase.rpc("same_domain_profiles");
    if (error) return [];
    const rows = (data ?? []) as Array<{ display_name: string | null; email: string | null }>;
    const mates = rows
      .filter((r) => !!r.email)
      .map((r) => ({ display_name: r.display_name ?? null, email: r.email as string }));
    cache = { at: Date.now(), data: mates };
    return mates;
  } catch {
    return [];
  }
}

// --- Settings "People at your company" block: dismiss-all ("Don't show this").
const DISMISS_KEY = "lalela.teammates.dismissed";
export const teammatesDismissed = () => localStorage.getItem(DISMISS_KEY) === "1";
export const dismissTeammates = () => localStorage.setItem(DISMISS_KEY, "1");

// --- One-time NotificationBell nudge (subtle, in-app, never an OS notification).
const NUDGE_PENDING_KEY = "lalela.teammates.nudge"; // queued payload (JSON)
const NUDGE_SEEN_KEY = "lalela.teammates.nudgeSeen"; // "1" once shown → never again

export interface DomainNudge {
  domain: string;
  count: number;
  ts: number;
}

/** The queued nudge waiting to be shown in the bell, if any. */
export function pendingNudge(): DomainNudge | null {
  try {
    const raw = localStorage.getItem(NUDGE_PENDING_KEY);
    return raw ? (JSON.parse(raw) as DomainNudge) : null;
  } catch {
    return null;
  }
}

/** Called once after sign-in. If a corporate-domain user has >= 1 same-domain
 *  teammate and the nudge has NEVER been shown, queue it for the bell. Never
 *  re-queues (guards on the seen flag and an already-pending payload). */
export async function maybeQueueDomainNudge(email: string | null | undefined): Promise<void> {
  if (localStorage.getItem(NUDGE_SEEN_KEY) === "1") return;
  if (pendingNudge()) return;
  if (isConsumerDomain(email)) return;
  const domain = emailDomain(email);
  if (!domain) return;
  const mates = await sameDomainProfiles();
  if (mates.length < 1) return;
  const nudge: DomainNudge = { domain, count: mates.length, ts: Date.now() };
  try {
    localStorage.setItem(NUDGE_PENDING_KEY, JSON.stringify(nudge));
  } catch {
    /* best-effort */
  }
}

/** Mark the nudge shown+consumed: clears the pending payload and blocks any
 *  future queueing. Idempotent. */
export function consumeNudge(): void {
  localStorage.removeItem(NUDGE_PENDING_KEY);
  localStorage.setItem(NUDGE_SEEN_KEY, "1");
}
