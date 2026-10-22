import { supabase } from "@/lib/supabase";
import {
  bumpCloudGeneration,
  cloudGeneration,
  enqueueCloudWrite,
  withTimeout,
} from "@/lib/meetingCloudQueue";
import { normaliseStages, type TaskStage } from "@/lib/settings";
import { pullTags } from "@/lib/tagsSync";
import { pullAutomations, pullAutomationRuns } from "@/lib/automationsSync";
import {
  createProject,
  flattenProjectTree,
  listProjects,
  listMeetings,
  getMeeting,
  importMeeting,
  rekeyMeeting,
  saveMeetingImage,
  meetingImageSrc,
  claimNoteEntries,
  listNoteEntries,
  upsertNoteEntries,
  type ActionItem,
  type Attendee,
  type FullMeeting,
  type MeetingImage,
  type MeetingMeta,
  type NoteEntry,
} from "@/lib/lalela";
import {
  CloudWriteError,
  PushLedger,
  fingerprint,
  isNetworkFailure,
  isRlsRejection,
  withNetworkRetry,
} from "@/lib/syncLedger";
import { isForeignRowRejection } from "@/lib/syncRlsCore";
import { connectorProviderOf, rekeyTargetFor } from "@/lib/connectorIds";

const IMAGE_BUCKET = "meeting-images";

/** Storage object path for a meeting image: <meeting_id>/<filename>. */
function imagePath(meetingId: string, relPath: string): string {
  return `${meetingId}/${relPath.split("/").pop()}`;
}

/**
 * Best-effort cloud image sync (Phase 9). Uploads each local capture to the
 * `meeting-images` bucket and records the image metadata on the meeting row.
 * Fully guarded: if the bucket/column aren't provisioned yet (migration not
 * applied) or we're offline, it silently no-ops and never blocks text sync.
 *
 * Incremental: captures are immutable files keyed by name, so a path the
 * ledger (or the bucket listing) already knows is never re-uploaded — the old
 * `upsert: true` loop re-sent every image 3–4× a day. A path enters the ledger
 * only INSIDE its queue turn, after the upload succeeded, so a fenced
 * (deleted), timed-out or refused upload is retried by the next sync.
 */
async function pushMeetingImages(meetingId: string, ledger: PushLedger) {
  try {
    // Re-read the local meeting when this turn comes, so a slow earlier write
    // can't leave a stale image list to land last.
    const m = await getMeeting(meetingId).catch(() => null);
    const images = m?.images ?? [];
    if (!m || !images.length || !m.dir_path) return;
    const dir = m.dir_path;
    let pending = images.filter((img) => !ledger.hasImage(imagePath(meetingId, img.rel_path)));
    if (pending.length) {
      // One listing call learns what a previous version (pre-ledger) or
      // another device already uploaded, so the first run after upgrading
      // doesn't re-send the whole library. A read — no queue turn needed.
      const { data: existing } = await supabase.storage
        .from(IMAGE_BUCKET)
        .list(meetingId, { limit: 1000 });
      for (const obj of existing ?? []) ledger.setImage(`${meetingId}/${obj.name}`);
      pending = pending.filter((img) => !ledger.hasImage(imagePath(meetingId, img.rel_path)));
    }
    for (const img of pending) {
      const path = imagePath(meetingId, img.rel_path);
      const gen = cloudGeneration(meetingId);
      // One queue turn per image: a folder move / save never waits behind the
      // whole batch, and a delete fences the remaining uploads (no orphans).
      // Bounded: a stalled upload must not hold the meeting's queue (it would
      // block saves, folder moves and delete). Timeout = best-effort failure,
      // retried on the next sync (the path never reached the ledger).
      await enqueueCloudWrite(meetingId, gen, () =>
        withTimeout(async (signal) => {
          const blob = await fetch(meetingImageSrc(dir, img.rel_path), { signal }).then((r) =>
            r.blob(),
          );
          const { error } = await supabase.storage
            .from(IMAGE_BUCKET)
            .upload(path, blob, { upsert: false, contentType: "image/png" });
          // "already exists" means another run/device beat us to it — same bytes.
          if (!error || /exists|duplicate/i.test(error.message)) {
            ledger.setImage(path);
            return;
          }
          // Not ours to write (RLS) — stop this meeting's image run entirely.
          if (isRlsRejection(error)) throw new CloudWriteError(error, 403);
          // Anything else: skip this image; the next sync retries it.
        }),
      );
      if (cloudGeneration(meetingId) !== gen) return; // deleted meanwhile
    }
    const gen = cloudGeneration(meetingId);
    await enqueueCloudWrite(meetingId, gen, async () => {
      await supabase.from("meetings").update({ images }).eq("id", meetingId);
    });
  } catch {
    /* migration not applied yet / offline / not ours — text sync is unaffected */
  }
}

/** Download a synced meeting's images into its local folder (best-effort). */
async function pullMeetingImages(meetingId: string, images: MeetingImage[]) {
  for (const img of images) {
    try {
      const { data } = await supabase.storage
        .from(IMAGE_BUCKET)
        .download(imagePath(meetingId, img.rel_path));
      if (!data) continue;
      const bytes = Array.from(new Uint8Array(await data.arrayBuffer()));
      await saveMeetingImage(meetingId, img.rel_path, bytes);
    } catch {
      /* missing/blocked — skip this image */
    }
  }
}

/** Push one project the current user owns. */
export async function pushProject(
  uid: string,
  p: { id: string; name: string; created_at: number; parent_id?: string | null },
) {
  const row: Record<string, unknown> = {
    id: p.id,
    owner_id: uid,
    name: p.name,
    created_at: new Date(p.created_at).toISOString(),
  };
  // Only touch parent_id when the caller knows it — callers with partial
  // project info (e.g. shareProject) must not null out the cloud value.
  if (p.parent_id !== undefined) row.parent_id = p.parent_id;
  const { error, status } = await supabase.from("projects").upsert(row);
  // Surface the failure — shareProject must abort here (a missing project row
  // makes the invite RPC's membership FK fail with a raw, confusing error).
  // Background callers already `.catch()` and treat it as best-effort.
  if (error) throw new CloudWriteError(error, status);
}

/** Best-effort cloud removal of a deleted project (RLS: owner only). */
export async function deleteCloudProject(id: string) {
  try {
    await supabase.from("projects").delete().eq("id", id);
  } catch {
    /* offline or not synced — fine */
  }
}

/** Best-effort cloud removal of a deleted meeting (RLS: owner only — the web
 * app deletes the same way). Without it a signed-in delete was local-only, and
 * the next pull (`pullOwnCloudMeetings`, missing-only) re-imported the meeting
 * from the cloud copy, so deleted meetings came back after a restart. */
export async function deleteCloudMeeting(id: string) {
  // Fence first (synchronously): row/image/notes writes already queued for this
  // meeting are skipped, so none can resurrect it or orphan data after the
  // delete. The delete itself then runs in order behind any in-flight write.
  bumpCloudGeneration(id);
  try {
    await enqueueCloudWrite(id, cloudGeneration(id), async () => {
      await supabase.from("meetings").delete().eq("id", id);
    });
  } catch {
    /* offline or never synced — fine */
  }
}

/** Push one local meeting to the cloud (mirror/backup). Every cloud write for
 * a meeting (row upsert, each image upload, image metadata, notes-log) goes
 * through the per-meeting queue (meetingCloudQueue), so they land in issue
 * order and the last local choice wins. Image/notes work is split into small
 * turns that re-read local state, so a slow upload never blocks a folder move
 * for long. A delete fences everything requested before it. */
export async function pushMeeting(uid: string, m: FullMeeting): Promise<void> {
  const ledger = new PushLedger(uid);
  try {
    await pushMeetingWith(uid, m, ledger);
  } finally {
    // Record what landed (row and/or images) so the next syncUp skips it.
    ledger.flush();
  }
}

/** Push one meeting against an open ledger (shared by `pushMeeting` and the
 * batched `syncUp` loop). Throws a {@link CloudWriteError} on rejection — for a
 * row someone else owns that is an RLS 403, thrown BEFORE any image or notes
 * write is queued, so foreign meetings never reach those paths either. */
async function pushMeetingWith(
  uid: string,
  m: FullMeeting,
  ledger: PushLedger,
  allowRekey = true,
): Promise<void> {
  const gen = cloudGeneration(m.id);
  const row = meetingRow(uid, m);
  // The upsert is idempotent, so a transport blip is safe to retry. Each
  // attempt is its own queue turn, so a delete during the backoff still fences
  // the retry (enqueueCloudWrite resolves undefined once the generation moved).
  try {
    await withNetworkRetry(() =>
      enqueueCloudWrite(m.id, gen, async () => {
        await pushMeetingRow(row);
        // Inside the turn: only a row that actually landed is recorded.
        ledger.setMeeting(m.id, meetingFingerprint(row, m));
      }),
    );
  } catch (e) {
    // The id is taken by another account's row we can't even see (pre-#284
    // connector imports derived ids from the external meeting alone, so two
    // users importing the same Teams call collide). Remember it so incremental
    // runs don't re-ask; then, for a connector import, move OUR copy to our
    // per-owner id and push that instead (once — a second refusal stays a skip).
    if (isForeignRowRejection(e)) {
      ledger.setForeign(m.id);
      if (allowRekey) {
        const moved = await rekeyForeignConnectorMeeting(uid, m.id, ledger);
        if (moved) return pushMeetingWith(uid, moved, ledger, false);
      }
    }
    // Rethrow so no image/notes write is queued for it.
    throw e;
  }
  if (cloudGeneration(m.id) !== gen) return;
  // Images ride along best-effort — a failed image upload must never undo
  // the text push that already succeeded.
  await pushMeetingImages(m.id, ledger);
  // Notes-log entries (A7) ride along too, best-effort. Only reached for
  // OWNED meetings (the row upsert throws first for meetings you don't own).
  await pushNoteEntries(uid, m.id);
}

/**
 * #284 re-key: a connector import whose id another account owns in the cloud
 * moves, locally, to this user's per-owner id (lib/connectorIds.ts) — one Rust
 * transaction over the row and every child table, old id kept as an alias. The
 * Markdown folder doesn't move (its path never contained the id). Returns the
 * moved meeting, or null when the meeting isn't a connector import or the
 * re-key was refused locally (e.g. the per-owner copy is already here — then
 * this one stays local-only, as in 1.3.9).
 */
async function rekeyForeignConnectorMeeting(
  uid: string,
  id: string,
  ledger: PushLedger,
): Promise<FullMeeting | null> {
  const target = await rekeyTargetFor(id, uid);
  if (!target) return null;
  try {
    const moved = await rekeyMeeting(id, target);
    // The old id is gone locally; drop its foreign mark so the ledger doesn't
    // keep counting it. Fence writes still queued for it (they would only hit
    // the other account's invisible row anyway).
    ledger.setForeign(id, false);
    bumpCloudGeneration(id);
    console.info(`sync: re-keyed ${id} → ${target} (id owned by another account)`);
    return moved;
  } catch (e) {
    console.warn("sync: re-key refused", id, e instanceof Error ? e.message : e);
    return null;
  }
}

async function pushMeetingRow(row: Record<string, unknown>) {
  const { error, status } = await supabase
    .from("meetings")
    .upsert({ ...row, updated_at: new Date().toISOString() });
  // Surface the text-push failure so callers (shareProject) can react. Common
  // real causes: the meeting's project_id points at a folder that isn't in the
  // cloud yet → meetings_project_id_fkey; or the row is a teammate's → RLS
  // 403. Background callers `.catch()`.
  if (error) throw new CloudWriteError(error, status);
}

/** The cloud row for a local meeting, minus `updated_at` (stamped at send time
 * so it never perturbs the change fingerprint). */
function meetingRow(uid: string, m: FullMeeting): Record<string, unknown> {
  return {
    id: m.id,
    owner_id: uid,
    project_id: m.project_id,
    title: m.title,
    created_at: new Date(m.created_at).toISOString(),
    transcript: m.segments,
    notes: m.notes,
    summary: m.summary,
    // Calendar attendees (Slice 9) — the cloud column exists since phase17.
    attendees: m.attendees ?? null,
    // Enhanced notes (Wave A3): ONLY sent when non-empty. The prod column
    // (phase25) is applied separately by the orchestrator; until then, sending
    // an unknown column would 400 and — since #173 made pushes throw — fail the
    // whole push. An empty field is the common case, so this is a safe no-op
    // for un-enhanced meetings and only rides up once both the migration is
    // live AND the user has actually enhanced.
    ...(m.enhanced_notes ? { enhanced_notes: m.enhanced_notes } : {}),
  };
}

/** Change fingerprint for a meeting: the row we'd send plus its image list
 * (images ride a separate update, so they must count as a change too).
 * Notes-log entries need no slot of their own — they re-derive `notes`. */
function meetingFingerprint(row: Record<string, unknown>, m: FullMeeting): string {
  return fingerprint([row, m.images ?? []]);
}

/** True when every local image of the meeting is known to be in the bucket. A
 * timed-out/fenced upload leaves a gap here even though the row's fingerprint
 * landed, and that gap alone must re-send the meeting next run. */
function imagesAllPushed(m: FullMeeting, ledger: PushLedger): boolean {
  // No local folder → nothing pushMeetingImages could upload anyway.
  if (!m.dir_path) return true;
  return (m.images ?? []).every((img) => ledger.hasImage(imagePath(m.id, img.rel_path)));
}

// ── Notes-log entries (A7) ────────────────────────────────────────────────
// The whole entries sync degrades silently when phase26 isn't applied yet (the
// cloud table is missing) — a single console.warn, never a thrown error, so a
// meeting push is never blocked by it. phase26 must be applied to prod BEFORE
// any release that ships A7.

/**
 * Push the entries YOU authored for a meeting. Authorless entries created on
 * this device (recording-finish / legacy backfill) are first CLAIMED as yours
 * (author_id = uid) — the cloud RLS forbids inserting a null author.
 */
export async function pushNoteEntries(uid: string, meetingId: string) {
  const gen = cloudGeneration(meetingId);
  await enqueueCloudWrite(meetingId, gen, () => pushNoteEntriesNow(uid, meetingId));
}

// Runs inside the meeting's queue turn, so local entries are read at write time.
async function pushNoteEntriesNow(uid: string, meetingId: string) {
  try {
    const local = await listNoteEntries(meetingId);
    // Only fetch my display name when there's actually something to claim.
    if (local.some((e) => e.author_id === null)) {
      const name = await myActorName(uid);
      await claimNoteEntries(meetingId, uid, name);
    }
    const mine = (await listNoteEntries(meetingId)).filter((e) => e.author_id === uid);
    if (!mine.length) return;
    const { error } = await supabase.from("meeting_note_entries").upsert(
      mine.map((e) => ({
        id: e.id,
        meeting_id: e.meeting_id,
        author_id: e.author_id,
        author_name: e.author_name,
        text: e.text,
        created_at: new Date(e.created_at).toISOString(),
        updated_at: new Date(e.updated_at).toISOString(),
      })),
    );
    if (error) throw error;
  } catch (e) {
    console.warn("note entries: push skipped", e instanceof Error ? e.message : e);
  }
}

/** Pull a meeting's cloud entries and upsert them locally (last-write-wins). */
export async function pullNoteEntries(meetingId: string) {
  try {
    const { data, error } = await supabase
      .from("meeting_note_entries")
      .select("id,meeting_id,author_id,author_name,text,created_at,updated_at")
      .eq("meeting_id", meetingId);
    if (error) throw error;
    if (!data?.length) return;
    const entries: NoteEntry[] = data.map((r) => ({
      id: r.id,
      meeting_id: r.meeting_id,
      author_id: (r.author_id as string | null) ?? null,
      author_name: r.author_name ?? "",
      text: r.text ?? "",
      created_at: Date.parse(r.created_at),
      updated_at: Date.parse(r.updated_at),
    }));
    await upsertNoteEntries(entries);
  } catch (e) {
    console.warn("note entries: pull skipped", e instanceof Error ? e.message : e);
  }
}

/** What a `syncUp` run pushed, and what it couldn't. Returned rather than
 * swallowed so the caller can surface a failing sync — counting failures in a
 * console warning is how a two-week cloud outage stayed invisible. */
export interface SyncUpResult {
  pushed: number;
  failed: number;
  /** Rows owned by someone else (shared with me) — never pushed, not failures. */
  skipped: number;
  /** Meetings unchanged since their last successful push. */
  unchanged: number;
  /** The most telling per-item error, for classification/diagnosis: the last
   * non-network error if there was one, else the last network error. */
  lastError: unknown;
}

/** Owner of each given cloud row (ids absent from the map aren't in the cloud,
 * or aren't visible to me). Chunked to keep the `in.(…)` URL short. */
async function cloudOwners(
  table: "projects" | "meetings",
  ids: string[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const rows = await withNetworkRetry(async () => {
      const { data, error, status } = await supabase
        .from(table)
        .select("id,owner_id")
        .in("id", chunk);
      if (error) throw new CloudWriteError(error, status);
      return data ?? [];
    });
    for (const r of rows) owners.set(r.id as string, r.owner_id as string);
  }
  return owners;
}

/** True when the cloud row exists and belongs to another user (the single-row
 * re-check after a 403). */
async function isForeignRow(
  table: "projects" | "meetings",
  uid: string,
  id: string,
): Promise<boolean> {
  try {
    const { data } = await supabase.from(table).select("owner_id").eq("id", id).maybeSingle();
    return !!data && data.owner_id !== uid;
  } catch {
    return false;
  }
}

/** Only one syncUp at a time. Supabase hands out a new session object on every
 * token refresh, which re-fired the sign-in effect and stacked full pushes on
 * top of each other (≈3× the meeting POSTs). A second caller for the same user
 * joins the run in flight instead of starting another. */
let inflight: { uid: string; full: boolean; run: Promise<SyncUpResult> } | null = null;

/** Push local projects + meetings owned by this user (called on sign-in and
 * from Settings → Sync now). Best-effort and tolerant: one bad row must never
 * abort the whole sync (the caller chains `pullOwnCloudMeetings` off this
 * resolving). Per-item failures are counted, warned AND reported back in
 * {@link SyncUpResult}.
 *
 * Incremental by default: a meeting is re-sent only when its content
 * fingerprint differs from its last successful push, or its cloud row is gone.
 * `full` ignores the fingerprints and re-sends every owned meeting. */
export function syncUp(uid: string, opts: { full?: boolean } = {}): Promise<SyncUpResult> {
  const full = !!opts.full;
  // Join the run in flight when it covers this request; otherwise queue behind
  // it (never alongside) — e.g. "Sync now" (full) during a background run.
  if (inflight?.uid === uid && (inflight.full || !full)) return inflight.run;
  const prev = inflight ? inflight.run.catch(() => undefined) : Promise.resolve();
  const run = prev.then(() => runSyncUp(uid, full));
  const entry = { uid, full, run };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  run.then(clear, clear);
  return run;
}

async function runSyncUp(uid: string, full: boolean): Promise<SyncUpResult> {
  let pushed = 0;
  let failed = 0;
  let skipped = 0;
  let unchanged = 0;
  let lastError: unknown = null;
  let lastNetworkError: unknown = null;
  const fail = (e: unknown) => {
    failed++;
    if (isNetworkFailure(e)) lastNetworkError = e;
    else lastError = e;
  };

  // Skip rows owned by someone else. Shares imported via importSharedMeeting
  // keep their cloud ids, and pushing them would stamp owner_id = uid on a row
  // the user doesn't own → RLS rejects it (403) on EVERY sync cycle, so the
  // sync never went green. Asking "who owns these ids?" for OUR local ids is
  // exact; the old `.neq("owner_id", uid)` listing could silently miss rows
  // (PostgREST caps a response at 1,000) and fell back to "push everything" on
  // any hiccup. If this lookup fails too, rejections are re-checked per row.
  const projects = await listProjects();
  let projectOwners: Map<string, string> | null = null;
  try {
    projectOwners = await cloudOwners("projects", projects.map((p) => p.id));
  } catch {
    /* offline — rejections are classified per row below */
  }
  for (const p of projects) {
    const owner = projectOwners?.get(p.id);
    if (owner && owner !== uid) {
      skipped++;
      continue;
    }
    try {
      await withNetworkRetry(() => pushProject(uid, p));
      pushed++;
    } catch (e) {
      // "USING expression" = the row exists and belongs to someone else, even
      // when RLS hides it from us entirely (isForeignRow would see nothing).
      if (
        isForeignRowRejection(e) ||
        (isRlsRejection(e) && (await isForeignRow("projects", uid, p.id)))
      ) {
        skipped++;
        continue;
      }
      fail(e);
      console.warn("syncUp: project push failed", p.id, e instanceof Error ? e.message : e);
    }
  }

  const metas = await listMeetings(null);
  let owners: Map<string, string> | null = null;
  try {
    owners = await cloudOwners("meetings", metas.map((m) => m.id));
  } catch {
    /* offline — fingerprints alone decide; rejections re-checked per row */
  }
  const ledger = new PushLedger(uid);
  try {
    for (const meta of metas) {
      const owner = owners?.get(meta.id);
      if (owner && owner !== uid) {
        skipped++;
        continue;
      }
      // Known to collide with another account's invisible row (see
      // pushMeetingWith). A connector import (#284) is re-keyed to this user's
      // per-owner id — a local move, no request — and pushed under it below;
      // this is how meetings marked foreign by 1.3.9 get backed up. Anything
      // else (or a refused re-key) is skipped without a request. `full`
      // re-checks it, and so does a cloud lookup that now says the row is ours.
      let rekeyed: FullMeeting | null = null;
      if (!full && owner !== uid && ledger.isForeign(meta.id)) {
        if (connectorProviderOf(meta.id))
          rekeyed = await rekeyForeignConnectorMeeting(uid, meta.id, ledger);
        if (!rekeyed) {
          skipped++;
          continue;
        }
      }
      const pushId = rekeyed?.id ?? meta.id;
      try {
        if (rekeyed) {
          await pushMeetingWith(uid, rekeyed, ledger, false);
          pushed++;
          ledger.flush(50);
          continue;
        }
        const m = await getMeeting(meta.id);
        // Unchanged since the last good push AND (when we could check) still in
        // the cloud → nothing to send. A row deleted cloud-side re-pushes.
        const inCloud = owners ? owner === uid : true;
        const fp = meetingFingerprint(meetingRow(uid, m), m);
        if (!full && inCloud && ledger.meeting(m.id) === fp && imagesAllPushed(m, ledger)) {
          unchanged++;
          continue;
        }
        await pushMeetingWith(uid, m, ledger);
        pushed++;
      } catch (e) {
        // A permission refusal on a row that turns out to be someone else's is
        // a skip (theirs to sync), not a failure of ours. Re-checked for this one
        // row even when the batch lookup ran: ownership can change mid-run, and
        // the lookup may have failed (offline) and left `owners` null.
        // "USING expression" means the row exists and isn't ours even when it's
        // invisible to us (another account's connector import with the same
        // id) — isForeignRow can't see those, so it's classified from the error.
        if (
          isForeignRowRejection(e) ||
          (isRlsRejection(e) && (await isForeignRow("meetings", uid, pushId)))
        )
          skipped++;
        else fail(e);
      }
      // Periodic flush: a run cut short (app quit, Mac asleep) keeps progress.
      ledger.flush(50);
    }
  } finally {
    ledger.flush();
  }
  if (failed) console.warn(`syncUp: ${failed} push(es) failed`);
  return { pushed, failed, skipped, unchanged, lastError: lastError ?? lastNetworkError };
}

/** Meetings shared with me (owned by someone else, visible via membership). */
export async function listSharedMeetings(uid: string): Promise<MeetingMeta[]> {
  const { data, error } = await supabase
    .from("meetings")
    .select("id,title,project_id,created_at,summary,owner_id")
    .neq("owner_id", uid)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    project_id: r.project_id,
    created_at: Date.parse(r.created_at),
    has_summary: !!(r.summary && r.summary.trim()),
    snippet: (r.summary ?? "").slice(0, 160),
    // Favourites are a local-only preference; shared cloud meetings carry none.
    is_favorite: false,
  }));
}

/** Names of projects shared with me (owned by others) — for grouping the
 * Shared view into folders. */
export async function listSharedProjectNames(uid: string): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name")
    .neq("owner_id", uid);
  if (error) throw new Error(error.message);
  const names: Record<string, string> = {};
  for (const p of data ?? []) names[p.id] = p.name;
  return names;
}

/** Of the given (locally owned) project ids, the ones with at least one
 * membership row — i.e. folders I've shared out. RLS lets owners read their
 * projects' memberships (project_role walks the parent chain), so this is a
 * cheap select. */
export async function listSharedOutProjectIds(ownedIds: string[]): Promise<Set<string>> {
  const shared = new Set<string>();
  for (let i = 0; i < ownedIds.length; i += 200) {
    const chunk = ownedIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from("memberships")
      .select("project_id")
      .in("project_id", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) shared.add(row.project_id);
  }
  return shared;
}

/**
 * Fetch a cloud meeting row and import it into the local store (this path —
 * `import_meeting` → `upsert_meeting` — keeps the FTS index in sync).
 * `projectId` overrides the cloud project assignment when the caller has
 * mapped cloud folder ids to local ones; `undefined` keeps the cloud value.
 */
async function importCloudMeeting(id: string, projectId?: string | null): Promise<string> {
  const { data, error } = await supabase.from("meetings").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  const full: FullMeeting = {
    id: data.id,
    title: data.title,
    project_id: projectId === undefined ? data.project_id : projectId,
    created_at: Date.parse(data.created_at),
    dir_path: null,
    segments: data.transcript ?? [],
    notes: data.notes ?? "",
    summary: data.summary ?? "",
    // enhanced_notes rides down only once the prod column exists (phase25); the
    // `?? ""` keeps pre-migration cloud rows (no such key) importing cleanly.
    enhanced_notes: (data.enhanced_notes as string | null) ?? "",
    images: (data.images as MeetingImage[]) ?? [],
    attendees: (data.attendees as Attendee[] | null) ?? null,
  };
  await importMeeting(full);
  // Pull the actual image files into the local meeting folder (best-effort).
  if (full.images.length) await pullMeetingImages(full.id, full.images);
  // Pull the notes-log entries (A7) so the log — and the derived notes/notes.md
  // — reflect every teammate's attributed additions (best-effort, degrades if
  // phase26 isn't applied yet).
  await pullNoteEntries(full.id);
  return full.id;
}

/** Fetch a cloud meeting and import it into the local store, returning its id. */
export async function importSharedMeeting(id: string): Promise<string> {
  return importCloudMeeting(id);
}

/**
 * Pull the user's OWN cloud-created meetings down into local SQLite: web
 * recordings (`web-*` ids), connector imports (`conn-*` ids) — anything owned
 * by this user that only exists in the cloud `meetings` table. Until now sync
 * was one-way up, so those never reached local FTS/briefs/wiki.
 *
 * v1 policy: missing-only. Meetings that already exist locally are never
 * overwritten. Returns the number of meetings imported. `onImported` receives
 * the freshly-imported meeting ids (for the automation engine choke point).
 */
export async function pullOwnCloudMeetings(
  uid: string,
  onImported?: (ids: string[]) => void,
): Promise<number> {
  // --- Folders first, so pulled meetings land in the right project. The
  // local create path (`create_project`) generates its own ids, so cloud
  // folder ids are mapped to local ones: by id when the folder round-tripped
  // from this device, else by name+parent, else freshly created (parents
  // before children so the hierarchy is preserved).
  const { data: cloudProjects, error: pErr } = await supabase
    .from("projects")
    .select("id,name,parent_id,created_at")
    .eq("owner_id", uid);
  if (pErr) throw new Error(pErr.message);

  const localProjects = await listProjects();
  const localIds = new Set(localProjects.map((p) => p.id));
  const cloudToLocal = new Map<string, string>();

  // Depth-first, parents before children (missing parents behave as roots).
  const ordered = flattenProjectTree(
    (cloudProjects ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? "",
      parent_id: p.parent_id ?? null,
      created_at: Date.parse(p.created_at) || Date.now(),
      // Local-only preference; the cloud never stores it.
      is_favorite: false,
    })),
  );
  for (const { project: cp } of ordered) {
    if (localIds.has(cp.id)) {
      cloudToLocal.set(cp.id, cp.id);
      continue;
    }
    const parentLocal = cp.parent_id ? cloudToLocal.get(cp.parent_id) ?? null : null;
    const match = localProjects.find(
      (lp) =>
        lp.name.trim().toLowerCase() === cp.name.trim().toLowerCase() &&
        (lp.parent_id ?? null) === parentLocal,
    );
    if (match) {
      cloudToLocal.set(cp.id, match.id);
      continue;
    }
    const created = await createProject(cp.name, parentLocal);
    localProjects.push(created);
    localIds.add(created.id);
    cloudToLocal.set(cp.id, created.id);
  }

  // --- Meetings: import only the ones missing locally.
  const { data: cloudMeetings, error: mErr } = await supabase
    .from("meetings")
    .select("id,project_id")
    .eq("owner_id", uid);
  if (mErr) throw new Error(mErr.message);

  const have = new Set((await listMeetings(null)).map((m) => m.id));
  const importedIds: string[] = [];
  for (const row of cloudMeetings ?? []) {
    if (have.has(row.id)) continue;
    try {
      const projectId = row.project_id ? cloudToLocal.get(row.project_id) ?? null : null;
      await importCloudMeeting(row.id, projectId);
      importedIds.push(row.id);
    } catch {
      /* one bad row must not block the rest */
    }
  }

  // Tags + automations ride the same pull: definitions + assignments made on
  // web or by the cloud automation engine, plus the shared run ledger (all
  // best-effort, never block meeting sync).
  await pullTags(uid);
  await pullAutomations(uid);
  await pullAutomationRuns(uid);

  if (importedIds.length) onImported?.(importedIds);
  return importedIds.length;
}

/** Share a project with someone by email + role (ensures the project exists in cloud). */
export async function shareProject(
  uid: string,
  projectId: string,
  projectName: string,
  projectCreatedMs: number,
  email: string,
  role: "admin" | "editor" | "viewer",
) {
  // Push the folder FIRST and fail fast — the invite RPC inserts a membership
  // whose FK requires the project row to already exist in the cloud. A thrown
  // error surfaces verbatim in ShareDialog (e.g. an RLS 403 if phase24 isn't
  // applied yet, instead of the raw downstream FK message).
  await pushProject(uid, { id: projectId, name: projectName, created_at: projectCreatedMs });
  // Also push the project's meetings so the invitee can see them. Tolerant: one
  // bad meeting must not block the share — the folder + membership are what
  // matter, and the rest re-sync on the next cycle.
  const metas = await listMeetings(projectId);
  let failed = 0;
  for (const meta of metas) {
    try {
      await pushMeeting(uid, await getMeeting(meta.id));
    } catch {
      failed++;
    }
  }
  if (failed) console.warn(`shareProject: ${failed} of ${metas.length} meeting push(es) failed`);

  const { error } = await supabase.rpc("invite_member", {
    p_project: projectId,
    p_email: email,
    p_role: role,
  });
  if (error) throw new Error(error.message);
}

export type MeetingRole = "owner" | "admin" | "editor" | "viewer" | null;

/**
 * The current user's effective role for a meeting. `null` means it's a purely
 * local meeting (or we can't reach the cloud) → treat as fully editable. A
 * cloud meeting owned by someone else returns the membership role; "viewer"
 * is read-only (RLS also enforces this server-side).
 */
export async function myRoleForMeeting(uid: string, meetingId: string): Promise<MeetingRole> {
  const { data: m, error } = await supabase
    .from("meetings")
    .select("owner_id,project_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (error || !m) return null; // local-only / not synced → editable
  if (m.owner_id === uid) return "owner";
  if (!m.project_id) return null;
  const { data: mem } = await supabase
    .from("memberships")
    .select("role")
    .eq("project_id", m.project_id)
    .eq("user_id", uid)
    .maybeSingle();
  return (mem?.role as MeetingRole) ?? "viewer";
}

export interface Member {
  user_id: string;
  role: string;
  email: string | null;
  display_name: string | null;
}

/** List members of a project (for the sharing UI). */
export async function listMembers(projectId: string): Promise<Member[]> {
  const { data: mem, error } = await supabase
    .from("memberships")
    .select("user_id,role")
    .eq("project_id", projectId);
  if (error) throw new Error(error.message);
  const ids = (mem ?? []).map((m) => m.user_id);
  let profiles: Record<string, { email: string; display_name: string }> = {};
  if (ids.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id,email,display_name")
      .in("id", ids);
    for (const p of profs ?? []) profiles[p.id] = { email: p.email, display_name: p.display_name };
  }
  return (mem ?? []).map((m) => ({
    user_id: m.user_id,
    role: m.role,
    email: profiles[m.user_id]?.email ?? null,
    display_name: profiles[m.user_id]?.display_name ?? null,
  }));
}

/** Change a member's role (owner/admin only — enforced server-side). */
export async function updateMemberRole(projectId: string, userId: string, role: string) {
  const { error } = await supabase.rpc("update_member", {
    p_project: projectId,
    p_user: userId,
    p_role: role,
  });
  if (error) throw new Error(error.message);
}

/** Remove a member (owner/admin, or yourself to leave the share). */
export async function removeMember(projectId: string, userId: string) {
  const { error } = await supabase.rpc("remove_member", {
    p_project: projectId,
    p_user: userId,
  });
  if (error) throw new Error(error.message);
}

// --- Action items (cloud mirror; needs the phase11 migration) ---

/** Mirror one approved/in-flight action item so a matched assignee (and the
 * user's other devices) see it on their board — in its EXACT custom stage.
 * phase21 relaxed the cloud `action_items.status` CHECK so the stage id is
 * stored verbatim (cross-device + cross-user placement). Best-effort and
 * defensive: a pre-migration cloud (old CHECK still live) rejects a custom
 * status, so we swallow the error here rather than let it bubble — callers
 * already `.catch()`, and a rejected upsert must never be fatal. */
export async function pushActionItem(uid: string, item: ActionItem) {
  try {
    const { error } = await supabase.from("action_items").upsert({
      id: item.id,
      meeting_id: item.meeting_id,
      owner_id: uid,
      project_id: item.project_id,
      title: item.title,
      assignee_name: item.assignee_name,
      assignee_uid: item.assignee_uid,
      status: item.status,
      due: item.due,
      meeting_title: item.meeting_title,
    });
    if (error) {
      // Most likely a pre-migration CHECK rejecting a custom stage id. Non-fatal.
      console.warn("pushActionItem: cloud upsert rejected (non-fatal)", error.message);
    }
  } catch {
    /* offline or transport error — best effort */
  }
}

export async function deleteCloudActionItem(id: string) {
  try {
    await supabase.from("action_items").delete().eq("id", id);
  } catch {
    /* offline or not mirrored — fine */
  }
}

/** Tasks assigned to me from OTHER people's meetings (for my Tasks board). */
export async function listAssignedActionItems(uid: string): Promise<ActionItem[]> {
  const { data, error } = await supabase
    .from("action_items")
    .select("*")
    .eq("assignee_uid", uid)
    .neq("owner_id", uid);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    meeting_id: r.meeting_id,
    title: r.title,
    assignee_name: r.assignee_name,
    assignee_uid: r.assignee_uid,
    status: r.status,
    due: r.due,
    created_at: Date.parse(r.created_at),
    updated_at: Date.parse(r.updated_at),
    meeting_title: r.meeting_title ?? "",
    project_id: r.project_id,
  }));
}

/** Assignee-side status move for a task someone else owns. Stores the EXACT
 * stage id (phase21) so the move survives on their board and every device. */
export async function updateCloudActionItemStatus(id: string, status: string) {
  const { error } = await supabase.from("action_items").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}

// --- Task board stage definitions (per-user; needs the phase21 migration) ---
// The user's custom columns, cloud-backed so every one of their devices shows
// the same board. Owner-only under RLS. Best-effort: a pre-migration cloud
// (no task_stages table) just leaves the local mirror/cache in charge.

/** This user's saved stage list, or null if none is stored (or the migration
 * isn't applied yet). Normalised so "Done" is always pinned last. */
export async function pullTaskStages(uid: string): Promise<TaskStage[] | null> {
  const { data, error } = await supabase
    .from("task_stages")
    .select("stages")
    .eq("owner_id", uid)
    .maybeSingle();
  if (error || !data?.stages) return null;
  try {
    const list = data.stages as TaskStage[];
    return Array.isArray(list) && list.length ? normaliseStages(list) : null;
  } catch {
    return null;
  }
}

/** Upsert this user's stage list (one row per user; owner_id is the PK). */
export async function pushTaskStages(uid: string, stages: TaskStage[]): Promise<void> {
  try {
    const { error } = await supabase
      .from("task_stages")
      .upsert({ owner_id: uid, stages });
    if (error) console.warn("pushTaskStages: cloud upsert rejected (non-fatal)", error.message);
  } catch {
    /* offline or pre-migration — the local mirror/cache stands */
  }
}

// --- Activity feed / notifications (needs the phase12 migration) ---

export interface ActivityItem {
  id: string;
  actor_id: string;
  actor_name: string;
  /** null = team event (visible to the folder's members). */
  recipient_id: string | null;
  project_id: string | null;
  kind: string;
  title: string;
  body: string;
  meeting_id: string | null;
  created_at: number;
}

/** Emit one activity event. Best-effort — callers swallow failures. */
export async function pushNotification(n: {
  actorId: string;
  actorName: string;
  recipientId?: string | null;
  projectId?: string | null;
  kind: string;
  title: string;
  body?: string;
  meetingId?: string | null;
}) {
  await supabase.from("notifications").insert({
    actor_id: n.actorId,
    actor_name: n.actorName,
    recipient_id: n.recipientId ?? null,
    project_id: n.projectId ?? null,
    kind: n.kind,
    title: n.title,
    body: n.body ?? "",
    meeting_id: n.meetingId ?? null,
  });
}

/** Everything I'm allowed to see (RLS filters), newest first. */
export async function listNotifications(): Promise<ActivityItem[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, created_at: Date.parse(r.created_at) }));
}

/** My display name for activity entries (profile name, else email). */
export async function myActorName(uid: string): Promise<string> {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("display_name,email")
      .eq("id", uid)
      .maybeSingle();
    return data?.display_name || data?.email || "A teammate";
  } catch {
    return "A teammate";
  }
}
