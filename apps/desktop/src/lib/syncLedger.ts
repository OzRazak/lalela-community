// Bookkeeping that keeps `syncUp` incremental and honest. Before this, every
// run re-upserted ALL local meetings (full transcripts) and re-uploaded EVERY
// image — ~1,100 sequential requests on a busy account — so one WebKit network
// blip ("TypeError: Load failed") anywhere in the run failed the whole sync,
// and one meeting owned by a teammate (RLS 403) failed EVERY run. Kept free of
// Tauri/Supabase imports so the pure parts stay easy to reason about.

import { classifySyncError } from "@/lib/syncStatus";

const LEDGER_PREFIX = "lalela.sync.pushed.v1:";

/** Stable, cheap content fingerprint (FNV-1a 32-bit + length). Only used to
 * notice "this meeting changed since we last pushed it" — not a security hash. */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}.${s.length.toString(16)}`;
}

interface LedgerData {
  /** meeting id → fingerprint of the row last pushed successfully. */
  meetings: Record<string, string>;
  /** storage paths (`<meeting_id>/<file>`) known to exist in the bucket. */
  images: Record<string, 1>;
  /** meeting ids whose cloud row belongs to ANOTHER account and is invisible to
   * us (the upsert was refused with RLS "USING expression"), so incremental
   * runs skip them without a request. A `full` push re-checks them. */
  foreign: Record<string, 1>;
}

/**
 * What this device has already pushed, per signed-in user (a different account
 * on the same machine must push everything afresh). Persisted in localStorage;
 * callers batch writes and `flush()` — rewriting a ~1,100-entry map after every
 * single push would be quadratic.
 */
export class PushLedger {
  private data: LedgerData;
  /** Entries set since the last flush. Several ledgers can be open at once (a
   * long syncUp plus one-off pushMeeting saves), so flush merges ONLY these
   * into the stored copy instead of overwriting it with a stale snapshot. */
  private changedMeetings = new Map<string, string>();
  private changedImages = new Set<string>();
  /** id → true (mark foreign) / false (clear the mark). */
  private changedForeign = new Map<string, boolean>();

  constructor(private readonly uid: string) {
    this.data = this.load();
  }

  private load(): LedgerData {
    try {
      const raw = localStorage.getItem(LEDGER_PREFIX + this.uid);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LedgerData>;
        return {
          meetings: parsed.meetings ?? {},
          images: parsed.images ?? {},
          foreign: parsed.foreign ?? {},
        };
      }
    } catch {
      /* corrupt/absent — start empty, which just means one full push */
    }
    return { meetings: {}, images: {}, foreign: {} };
  }

  meeting(id: string): string | undefined {
    return this.data.meetings[id];
  }

  setMeeting(id: string, fp: string) {
    this.data.meetings[id] = fp;
    this.changedMeetings.set(id, fp);
    // The row landed, so it is ours (again) — drop any stale foreign mark.
    if (this.data.foreign[id] === 1) this.setForeign(id, false);
  }

  isForeign(id: string): boolean {
    return this.data.foreign[id] === 1;
  }

  setForeign(id: string, foreign = true) {
    if (foreign) this.data.foreign[id] = 1;
    else delete this.data.foreign[id];
    this.changedForeign.set(id, foreign);
  }

  hasImage(path: string): boolean {
    return this.data.images[path] === 1;
  }

  setImage(path: string) {
    if (this.data.images[path] === 1) return;
    this.data.images[path] = 1;
    this.changedImages.add(path);
  }

  /** Persist if anything changed. `every` lets a long loop flush periodically
   * so a run killed mid-way (app quit, Mac asleep) keeps its progress. */
  flush(every = 1) {
    if (this.changedMeetings.size + this.changedImages.size + this.changedForeign.size < every)
      return;
    try {
      // Re-read, then layer our changes on top: another ledger may have
      // flushed since we loaded, and its entries must survive.
      const merged = this.load();
      for (const [id, fp] of this.changedMeetings) merged.meetings[id] = fp;
      for (const path of this.changedImages) merged.images[path] = 1;
      for (const [id, f] of this.changedForeign) {
        if (f) merged.foreign[id] = 1;
        else delete merged.foreign[id];
      }
      localStorage.setItem(LEDGER_PREFIX + this.uid, JSON.stringify(merged));
      this.data = merged;
      this.changedMeetings.clear();
      this.changedImages.clear();
      this.changedForeign.clear();
    } catch {
      /* quota — worst case the next run pushes a bit more than needed */
    }
  }
}

/** An error from a cloud write that keeps the HTTP status + Postgres code, so
 * callers can tell "not yours" (RLS) from "offline" from "server broke". A bare
 * `new Error(error.message)` threw both away. */
export class CloudWriteError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(err: { message: string; code?: string | null }, status?: number | null) {
    super(err.message);
    this.name = "CloudWriteError";
    // postgrest-js reports a transport failure with status 0 — no response.
    this.status = status ? status : null;
    this.code = err.code ? String(err.code) : null;
  }
}

/** The cloud refused the write on permission grounds (row-level security):
 * HTTP 403, Postgres 42501, or the RLS message text. */
export function isRlsRejection(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return (
    status === 403 ||
    code === "42501" ||
    /row-level security|violates row level security|permission denied/i.test(message)
  );
}

/** A transport failure that never reached the server (WebKit "Load failed",
 * "Failed to fetch", DNS, reset…) — the only kind worth retrying blindly. */
export function isNetworkFailure(e: unknown): boolean {
  return classifySyncError(e).errorClass === "offline";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an idempotent cloud call, retrying ONLY network-class failures with a
 * short backoff before giving up. A laptop waking from sleep or a wifi hand-off
 * drops one request; that must not count as a failed sync.
 */
export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [750, 2500],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length || !isNetworkFailure(e)) throw e;
      await sleep(delaysMs[attempt]);
    }
  }
}
