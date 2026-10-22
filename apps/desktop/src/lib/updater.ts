// In-app auto-update: check the configured endpoint for a newer *signed* build,
// then download + install + relaunch. Signature is verified against the pubkey
// baked into tauri.conf.json, so a tampered manifest/artifact is rejected.

import { trackEvent } from "./analytics";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { COMMUNITY_UNAVAILABLE_MESSAGE, IS_COMMUNITY } from "./edition";

export type { Update };

/** Full outcome of a check. Unlike {@link checkForUpdate}, this distinguishes
 * "you're already current" from "the check itself failed" (offline, manifest
 * unreachable) — what a user-triggered "Check for updates" needs to report. */
export type UpdateCheck =
  | { status: "available"; update: Update; checkedAt: number }
  | { status: "current"; checkedAt: number }
  | { status: "error"; message: string; checkedAt: number };

/** Look for a newer signed build and report the full outcome. Never throws —
 * a failed check surfaces as `{ status: "error" }` with a readable message. */
export async function checkForUpdateDetailed(): Promise<UpdateCheck> {
  const checkedAt = Date.now();
  // The Community edition has no updater (no feed, no signing key, plugin not
  // registered); its UI never offers a check. Defensive: never call check().
  if (IS_COMMUNITY) {
    return { status: "error", message: COMMUNITY_UNAVAILABLE_MESSAGE, checkedAt };
  }
  try {
    const update = await check();
    return update ? { status: "available", update, checkedAt } : { status: "current", checkedAt };
  } catch (e) {
    console.error("update check failed", e);
    return { status: "error", message: updateErrorMessage(e), checkedAt };
  }
}

// --- Consecutive-failure tracking -------------------------------------------
// A dead feed (host moved, 404, malformed manifest) is indistinguishable from
// "you're up to date" unless the app says so — the exact silent failure that
// left every installed build stranded on 1.3.3 for weeks. One flaky-wifi check
// is noise, though, so the automatic banner only speaks after this many
// consecutive failures, counted ACROSS LAUNCHES (hence localStorage, not a
// ref): a permanently broken feed always reaches the threshold, a blip never
// does.

const KEYS = {
  failures: "lalela.update.checkFailures",
  lastCheck: "lalela.update.lastCheck",
} as const;

/** Consecutive failed checks before the update banner surfaces the error. */
export const UPDATE_ERROR_AFTER_FAILURES = 2;

/** How the last update check ended, persisted across launches. */
export interface UpdateCheckRecord {
  status: UpdateCheck["status"];
  checkedAt: number;
  error: string | null;
}

export function lastUpdateCheck(): UpdateCheckRecord | null {
  const raw = localStorage.getItem(KEYS.lastCheck);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UpdateCheckRecord;
  } catch {
    return null;
  }
}

/** Consecutive failed checks so far (0 once a check succeeds). */
export function updateCheckFailures(): number {
  const n = Number(localStorage.getItem(KEYS.failures));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Persist the outcome of a check and return the consecutive-failure count —
 * 0 whenever the check actually reached the feed. */
export function recordUpdateCheck(result: UpdateCheck): number {
  trackEvent("update_check", { outcome: result.status });
  const failures = result.status === "error" ? updateCheckFailures() + 1 : 0;
  localStorage.setItem(KEYS.failures, String(failures));
  localStorage.setItem(
    KEYS.lastCheck,
    JSON.stringify({
      status: result.status,
      checkedAt: result.checkedAt,
      error: result.status === "error" ? result.message : null,
    } satisfies UpdateCheckRecord),
  );
  return failures;
}

/** Look for a newer version. Returns the Update handle if one is available,
 * else null. Never throws — a failed check (offline, no manifest yet) just
 * means "no update right now". */
export async function checkForUpdate(): Promise<Update | null> {
  const result = await checkForUpdateDetailed();
  return result.status === "available" ? result.update : null;
}

/** A human-readable one-liner for a failed check or install. A dropped network
 * is the common case (offline, or the manifest/artifact host unreachable), so
 * we phrase that plainly; anything else falls back to the raw message. */
export function updateErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/network|fetch|connect|dns|timeout|offline|reach|resolve|host/i.test(raw))
    return "Couldn't reach the update server — check your internet connection and try again.";
  return raw || "Something went wrong. Please try again.";
}

/** Download + install the update (reporting progress), then relaunch into the
 * new version. The process is replaced by `relaunch()`, so nothing after it
 * runs on success. */
export async function installAndRelaunch(
  update: Update,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.(downloaded, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
  trackEvent("update_installed"); // best-effort: relaunch may win the race
  await relaunch();
}
