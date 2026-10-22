// How the last cloud sync ended, persisted so a broken sync is visible instead
// of being a line in a console nobody reads. Mirrors the Teams-import outcome
// (`lalela.ms.import.lastOutcome`, lib/msauth.ts): the failure that taught us
// this — a paused Supabase project — looked, from inside the app, exactly like
// everything working. Local-first means a dead cloud costs nothing *today*;
// the cost is the user believing their meetings are backed up and shared when
// they are not.

import { DEVICE_NOUN } from "@/lib/platform";

const KEY = "lalela.sync.lastOutcome";

/** Broadcast whenever an outcome is recorded, so the TopBar chip and Settings
 * update live (localStorage's own `storage` event never fires in the document
 * that made the write). */
export const SYNC_OUTCOME_CHANGED_EVENT = "lalela:sync-outcome-changed";

/**
 * Why a sync failed, because the honest sentence differs by cause:
 * - `auth` — the session is gone/expired: the user must sign in again.
 * - `offline` — no route to the server (DNS, dropped wifi, fetch failure).
 * - `server` — we reached something and it broke (HTTP 5xx, project paused).
 * - `denied` — the cloud refused a row on permission grounds (row-level
 *   security): the session is fine, the user just may not write that row.
 */
export type SyncErrorClass = "auth" | "offline" | "server" | "denied";

/** How the last sync run ended. */
export interface SyncOutcome {
  ok: boolean;
  /** When the run finished (epoch ms). */
  at: number;
  /** Raw error text, kept for diagnosis (never the primary UI copy). */
  error: string | null;
  /** Machine-readable code where the backend gave one (e.g. `PGRST301`, `503`). */
  code: string | null;
  errorClass: SyncErrorClass | null;
  /** Start of the current failing streak (epoch ms); null while healthy. */
  failingSince: number | null;
  /** Rows not uploaded because another account owns them (shared with me, or
   * an id collision with someone else's connector import). Not a failure. */
  skipped?: number;
}

/** After this long of continuous failure, sync is not a blip — say so in the
 * header, not only in Settings. */
export const SYNC_ALERT_AFTER_MS = 30 * 60 * 1000;

export function getSyncOutcome(): SyncOutcome | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncOutcome;
    return { ...parsed, failingSince: parsed.failingSince ?? null };
  } catch {
    return null;
  }
}

function save(outcome: SyncOutcome): SyncOutcome {
  localStorage.setItem(KEY, JSON.stringify(outcome));
  window.dispatchEvent(new CustomEvent(SYNC_OUTCOME_CHANGED_EVENT));
  return outcome;
}

export function recordSyncSuccess(
  opts: { skipped?: number } = {},
  at = Date.now(),
): SyncOutcome {
  return save({
    ok: true,
    at,
    error: null,
    code: null,
    errorClass: null,
    failingSince: null,
    skipped: opts.skipped ?? 0,
  });
}

export function recordSyncFailure(e: unknown, at = Date.now()): SyncOutcome {
  const { errorClass, code, message } = classifySyncError(e);
  // The streak starts at the FIRST failure, so "failing since 09:10" is true
  // rather than "failing since the last retry a minute ago".
  const prev = getSyncOutcome();
  const failingSince = prev && !prev.ok && prev.failingSince ? prev.failingSince : at;
  return save({ ok: false, at, error: message, code, errorClass, failingSince });
}

/** Pull a status code out of whatever the client threw (supabase-js errors
 * carry `status`/`code`; a fetch failure carries neither). */
function statusOf(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  if (typeof s === "number") return s;
  if (typeof s === "string" && /^\d+$/.test(s)) return Number(s);
  return null;
}

export function classifySyncError(e: unknown): {
  errorClass: SyncErrorClass;
  code: string | null;
  message: string;
} {
  const message = (e instanceof Error ? e.message : String(e)) || "Unknown error";
  const rawCode = (e as { code?: unknown } | null)?.code;
  const status = statusOf(e);
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : null;

  // Network first: an offline machine produces a bare TypeError whose text can
  // otherwise trip the auth/server word tests.
  if (
    status === null &&
    /failed to fetch|networkerror|network request failed|load failed|dns|enotfound|econnrefused|econnreset|etimedout|offline|unreachable|timeout/i.test(
      message,
    )
  )
    return { errorClass: "offline", code, message };

  // RLS refusals arrive as 403 too, but they are not a sign-in problem — telling
  // the user to sign in again would send them chasing the wrong fix.
  if (code === "42501" || /row-level security|violates row level security|permission denied/i.test(message))
    return { errorClass: "denied", code, message };

  if (status === 401 || status === 403 || /jwt|not authenticated|unauthoriz|invalid (api key|token)|refresh token|session (expired|missing)/i.test(message))
    return { errorClass: "auth", code, message };

  return { errorClass: "server", code, message };
}

/** One honest sentence about what is wrong, in the user's terms. */
export function syncFailureHint(outcome: SyncOutcome): string {
  switch (outcome.errorClass) {
    case "auth":
      return "You're signed out of Lalela cloud — sign in again to resume syncing.";
    case "offline":
      return "Lalela cloud unreachable — check your internet connection.";
    case "denied":
      return `Lalela cloud refused some meetings (no permission to write them) — they're safe on this ${DEVICE_NOUN}.`;
    default:
      return `Lalela cloud isn't responding — your meetings are safe on this ${DEVICE_NOUN} and will sync once it's back.`;
  }
}

/** True once sync has been failing long enough to be worth a header badge. */
export function isSyncAlerting(outcome: SyncOutcome | null, now = Date.now()): boolean {
  if (!outcome || outcome.ok || !outcome.failingSince) return false;
  return now - outcome.failingSince >= SYNC_ALERT_AFTER_MS;
}

export function formatSyncTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
