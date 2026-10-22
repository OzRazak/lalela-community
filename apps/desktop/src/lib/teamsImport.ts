// Direct Teams transcript import (Slice 9): calendarView over the backfill
// window → events with an onlineMeeting join URL (recurring series deduped by
// join URL) → resolve the online meeting → list transcripts → VTT → segments,
// saved straight into local SQLite through the same import path the cloud
// pull-down uses (import_meeting → upsert_meeting keeps FTS in sync).
//
// Convergence with the WEB Teams connector (apps/web/lib/connectors/):
// meeting ids are derived exactly as the web engine derives them (see
// lib/connectorIds.ts) from externalId `${meetingId}:${transcriptId}` — per
// owner since #284 — and the folder/notes provenance matches, so a transcript
// imported here and one synced by the web connector land on ONE record
// instead of duplicating.

import { countBucket, markMeetingCaptured, trackEvent } from "./analytics";
import { supabase } from "@/lib/supabase";
import {
  chooseConnectorImportId,
  connectorImportIds,
  legacyConnectorMeetingId,
} from "@/lib/connectorIds";
import {
  GraphError,
  calendarView,
  eventAttendees,
  findOnlineMeetingByJoinUrl,
  getTranscriptVtt,
  graphDateMs,
  listTranscripts,
  takeGraphTruncation,
} from "@/lib/msgraph";
import { parseVtt } from "@/lib/vtt";
import type { MsImportErrorClass, MsImportOutcome } from "@/lib/msauth";
import {
  createProject,
  importMeeting,
  listMeetingIdAliases,
  listMeetings,
  listProjects,
  type FullMeeting,
} from "@/lib/lalela";

/** Same folder name the web connector uses (`Imported from ${adapter.name}`). */
export const TEAMS_PROJECT_NAME = "Imported from Microsoft Teams";

/** conn-teams-<sha1(externalId)[0..16]> — the LEGACY (pre-#284) id. New
 * imports use the per-owner id when signed in; see lib/connectorIds.ts. */
export async function teamsMeetingId(externalId: string): Promise<string> {
  return legacyConnectorMeetingId("teams", externalId);
}

/** The signed-in Lalela user, or null (signed out / offline session read). */
async function currentUid(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Owners of these ids in the cloud (only rows visible to us). Null when the
 * lookup failed — the caller then decides from local state alone. */
async function cloudOwnersOf(ids: string[]): Promise<Map<string, string> | null> {
  try {
    const { data, error } = await supabase.from("meetings").select("id,owner_id").in("id", ids);
    if (error) return null;
    return new Map((data ?? []).map((r) => [r.id as string, r.owner_id as string]));
  } catch {
    return null;
  }
}

/** Reuse-or-create the local "Imported from Microsoft Teams" folder. Name
 * match is case-insensitive so a folder mirrored down from the web connector
 * is adopted instead of duplicated. */
async function ensureTeamsProject(): Promise<string> {
  const projects = await listProjects();
  const existing = projects.find(
    (p) => p.name.trim().toLowerCase() === TEAMS_PROJECT_NAME.toLowerCase(),
  );
  if (existing) return existing.id;
  return (await createProject(TEAMS_PROJECT_NAME, null)).id;
}

/**
 * Sort a thrown error into the three buckets the UI can actually act on, and
 * pull out Graph's machine-readable code so a tenant-level block is nameable
 * (`GraphAccessToTranscriptsDisabled`) rather than just "something 403'd".
 *
 * `invalid_grant` / AADSTS errors arrive as plain Errors from the token
 * endpoint (msauth's tokenRequest), not as GraphErrors — they are still an
 * expired session, so they classify as `auth` too.
 */
export function classifyImportError(e: unknown): {
  errorClass: MsImportErrorClass;
  code: string | null;
  message: string;
} {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof GraphError) {
    const errorClass: MsImportErrorClass =
      e.status === 401 ? "auth" : e.status === 403 ? "forbidden" : "transient";
    return { errorClass, code: e.code, message };
  }
  if (/invalid_grant|AADSTS/i.test(message)) {
    return { errorClass: "auth", code: null, message };
  }
  return { errorClass: "transient", code: null, message };
}

/**
 * Import Teams transcripts from the last `days` days into the local store.
 * Idempotent: transcripts whose meeting id already exists locally (from an
 * earlier run OR from the web connector via pull-down sync) are skipped.
 * `onImported` receives the freshly imported meeting ids (for the automation
 * engine choke point).
 *
 * Returns how the run ended rather than throwing: Graph/auth/network failures
 * are classified into the result so callers can persist and surface them. A
 * failure that stops the whole run (auth, or a calendar read that never got
 * off the ground) reports `ok: false`; so does a run where every meeting we
 * touched refused us — that is the shape of the 2026-07-31 incident, where a
 * tenant flag 403'd every transcript call and seven days of imports vanished
 * with nobody being told — and so does a run that found new transcripts and had
 * every download refused, which is the same incident wearing a different hat
 * (`SpeakerAttributionNotAllowed`: the list succeeds, the content 403s).
 * Isolated 403s (meetings organised by others, which are expected and normal)
 * still just skip, because other meetings were read successfully.
 */
export async function importTeamsTranscripts({
  days = 30,
  onImported,
}: { days?: number; onImported?: (ids: string[]) => void } = {}): Promise<MsImportOutcome> {
  const importedIds: string[] = [];
  let scanned = 0;
  let resolved = 0;
  let unresolved = 0;
  let refused = 0;
  // Transcripts whose CONTENT this run actually tried to download. A run that
  // attempted downloads and imported nothing is a failure however many other
  // meetings had nothing new — that is the shape of a tenant-side content block
  // (403 `SpeakerAttributionNotAllowed`: Graph lists the transcripts but
  // refuses their text), which otherwise hides behind a majority of
  // "nothing new here" meetings and reports a cheerful `ok: true`.
  let attempted = 0;

  const done = (
    extra: Partial<MsImportOutcome> = {},
  ): MsImportOutcome => {
    if (importedIds.length) onImported?.(importedIds);
    if (importedIds.length) {
      trackEvent("meeting_imported", { connector: "teams", count: countBucket(importedIds.length) });
      markMeetingCaptured("import");
    }
    const outcome: MsImportOutcome = {
      ok: true,
      at: Date.now(),
      scanned,
      resolved,
      unresolved,
      refused,
      imported: importedIds.length,
      errorClass: null,
      code: null,
      message: null,
      ...extra,
    };
    // A Graph paging cap trip is not a failure — the run still imported what it
    // read — but it means a list came back incomplete, so it is recorded in the
    // persisted outcome rather than lost. Verdict and counts are untouched.
    const truncated = takeGraphTruncation();
    if (truncated) {
      const note =
        `Graph paging cap reached in ${truncated.what} ` +
        `(${truncated.pages} pages, ${truncated.items} items) — list was incomplete.`;
      outcome.message = outcome.message ? `${outcome.message} | ${note}` : note;
    }
    return outcome;
  };
  const failed = (e: unknown): MsImportOutcome => {
    const { errorClass, code, message } = classifyImportError(e);
    return done({ ok: false, errorClass, code, message });
  };

  let events;
  let have: Set<string>;
  // Owner of new imports (#284): per-owner ids while signed in, legacy ids
  // while signed out (re-keyed at first push if they collide).
  const uid = await currentUid();
  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    events = (await calendarView(start.toISOString(), end.toISOString())).filter(
      (e) => e.isOnlineMeeting && e.onlineMeeting?.joinUrl,
    );
    // Local ids PLUS the old ids of re-keyed meetings: a transcript whose
    // legacy id moved to a per-owner id is still "already imported".
    have = new Set((await listMeetings(null)).map((m) => m.id));
    for (const old of await listMeetingIdAliases().catch(() => [] as string[])) have.add(old);
  } catch (e) {
    // Nothing was even enumerated — the whole run is a failure.
    return failed(e);
  }

  const seenJoinUrls = new Set<string>(); // recurring series share a join URL
  let projectId: string | null = null;
  // The last per-meeting failure, promoted to the run's verdict by the rules at
  // the bottom of this function. The download failure is tracked separately so
  // a "found transcripts, imported none" verdict names the error that actually
  // blocked the download rather than whichever unrelated meeting failed last —
  // the difference between telling an admin to fix speaker attribution and
  // sending them after the wrong switch.
  let lastFailure: unknown = null;
  let lastDownloadFailure: unknown = null;

  for (const event of events) {
    const joinUrl = event.onlineMeeting!.joinUrl!;
    if (seenJoinUrls.has(joinUrl)) continue;
    seenJoinUrls.add(joinUrl);
    scanned++;
    let downloading = false;
    try {
      const meeting = await findOnlineMeetingByJoinUrl(joinUrl);
      if (!meeting?.id) {
        // Nothing was read here, so this is NOT a success. Counting it as one
        // used to inflate the success tally and mask runs where every meeting
        // we could actually read had refused us.
        unresolved++;
        continue;
      }
      for (const t of await listTranscripts(meeting.id)) {
        const ids = await connectorImportIds("teams", `${meeting.id}:${t.id}`, uid);
        let choice = chooseConnectorImportId({ ...ids, have, uid });
        if (choice.action === "import" && uid) {
          // Already ours in the cloud under either id (imported on web, or on
          // another device) → pull-down sync brings it; don't fork a copy.
          const owners = await cloudOwnersOf([ids.legacy, ...(ids.owned ? [ids.owned] : [])]);
          choice = chooseConnectorImportId({ ...ids, have, uid, cloudOwners: owners });
        }
        if (choice.action === "skip") continue;
        const id = choice.id;
        attempted++;
        downloading = true;
        const segments = parseVtt(await getTranscriptVtt(meeting.id, t.id));
        downloading = false;
        if (segments.length === 0) continue;
        if (!projectId) projectId = await ensureTeamsProject();
        const attendees = eventAttendees(event);
        const full: FullMeeting = {
          id,
          title: String(event.subject ?? "Teams meeting"),
          project_id: projectId,
          created_at:
            Date.parse(t.createdDateTime ?? "") || graphDateMs(event.start) || Date.now(),
          dir_path: null,
          segments,
          notes: `Imported from Microsoft Teams — ${joinUrl}`,
          summary: "",
          enhanced_notes: "",
          images: [],
          attendees: attendees.length > 0 ? attendees : null,
        };
        await importMeeting(full);
        have.add(ids.legacy);
        if (ids.owned) have.add(ids.owned);
        importedIds.push(id);
      }
      resolved++;
    } catch (e) {
      // Auth problems abort the whole run — nothing else can succeed.
      if (e instanceof GraphError && e.status === 401) return failed(e);
      // Everything else: remember it and keep going, so one bad event never
      // sinks the sync. The rules below decide whether it becomes the verdict.
      refused++;
      lastFailure = e;
      if (downloading) lastDownloadFailure = e;
    }
  }

  // Two distinct ways a run is a failure rather than a quiet "nothing new":
  //  - nothing was readable at all (every meeting we touched refused us), or
  //  - we DID find new transcripts and every single download was refused.
  // The second rule is what catches a tenant that lists transcripts but blocks
  // their content: without it the run reports `ok: true, imported: 0` forever,
  // because the meetings with nothing new drown out the ones that failed.
  if (lastFailure !== null && (resolved === 0 || (attempted > 0 && importedIds.length === 0))) {
    return failed(lastDownloadFailure ?? lastFailure);
  }
  return done();
}
