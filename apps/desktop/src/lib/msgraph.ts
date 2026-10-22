// Thin Microsoft Graph client (Slice 9). All calls are delegated (the
// connected user's own data), CORS-served by Graph, and depend on msauth for
// tokens: 401 → one forced refresh + retry, 429 → Retry-After backoff.

import { getAccessToken } from "@/lib/msauth";
import type { Attendee } from "@/lib/lalela";

const GRAPH = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable Graph code, when the error body carried one. */
    public code: string | null = null,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/**
 * The most specific machine-readable code in a Graph error body:
 * `error.innerError.code` when present, else `error.code`. The inner code is
 * the one that names the actual cause — e.g. a tenant that has switched off
 * the transcript API answers 403 `Forbidden` on the outside but
 * `GraphAccessToTranscriptsDisabled` inside, and only the latter tells the
 * user an admin has to act.
 */
function graphErrorCode(body: string): string | null {
  try {
    const { error } = JSON.parse(body) as {
      error?: { code?: string; innerError?: { code?: string } };
    };
    return error?.innerError?.code ?? error?.code ?? null;
  } catch {
    return null; // non-JSON body (Graph does this for some 5xx)
  }
}

/**
 * Hard ceiling on a single Graph call. The webview's `fetch` has no timeout of
 * its own, so one request that never settles hangs the entire import: the run
 * neither imports anything nor records an outcome, and from the outside that is
 * indistinguishable from "still working". Failing loudly at 60s is far above
 * Graph's normal latency and above the longest `Retry-After` we honour.
 */
const GRAPH_TIMEOUT_MS = 60_000;

export async function graphFetch(path: string, accept = "application/json"): Promise<Response> {
  let token = await getAccessToken();
  if (!token) throw new GraphError(401, "Microsoft account is not connected.");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (e) {
      // 408 keeps this in the `transient` class, so it retries on the next run
      // instead of being reported to the user as a permissions problem.
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new GraphError(
          408,
          `Microsoft Graph did not respond within ${GRAPH_TIMEOUT_MS / 1000}s.`,
        );
      }
      throw e;
    }
    if (res.status === 401 && attempt === 0) {
      token = await getAccessToken(true);
      if (!token) {
        throw new GraphError(
          401,
          "Microsoft session expired — reconnect under Settings → Connections.",
        );
      }
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GraphError(
        res.status,
        `Microsoft Graph error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        graphErrorCode(body),
      );
    }
    return res;
  }
}

async function graphJson<T>(path: string): Promise<T> {
  return (await graphFetch(path)).json() as Promise<T>;
}

// --- Paging ------------------------------------------------------------------

/**
 * Sanity caps for `graphListAll`. Generous enough for a genuinely busy account
 * (a 30-day calendar window measured 113 events; a long-lived recurring series
 * accumulates transcripts indefinitely) while still refusing to loop forever on
 * a malformed or cyclic nextLink chain.
 */
const GRAPH_MAX_PAGES = 25;
const GRAPH_MAX_ITEMS = 2000;

/** A `graphListAll` run that stopped at the cap with results still unread. */
export interface GraphTruncation {
  /** Which list ran out of headroom, e.g. `"calendarView"`. */
  what: string;
  pages: number;
  items: number;
  at: number;
}

let lastTruncation: GraphTruncation | null = null;

/**
 * Take (and clear) the most recent paging-cap trip, or null when every list
 * since the last call paged to exhaustion. Callers fold this into their run
 * outcome so a cap trip is diagnosable afterwards instead of quietly returning
 * a short list — the exact failure mode this helper exists to kill.
 */
export function takeGraphTruncation(): GraphTruncation | null {
  const truncation = lastTruncation;
  lastTruncation = null;
  return truncation;
}

interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * Read a Graph collection to the end, following `@odata.nextLink`.
 *
 * Graph paginates every collection, and a caller that reads `json.value` and
 * drops the continuation token gets a silent truncation: page 1 is a complete,
 * successful-looking 200. That is how transcript imports stalled for weeks —
 * `/transcripts` defaults to a 20-item page, so once a recurring series passed
 * 20 transcripts the new ones fell off the end of page 1 forever, and
 * `calendarView`'s `$top=50` hid everything after the 50th event in the window.
 *
 * Ordering is deliberately not assumed: the transcripts endpoint does not
 * document a default sort, so correctness comes from consuming every page
 * rather than from betting on newest-first.
 *
 * Non-2xx responses propagate as `GraphError` exactly as a single-page read
 * does — paging adds no new error semantics.
 */
async function graphListAll<T>(firstPath: string, what: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = firstPath;
  let pages = 0;
  while (next) {
    // Annotated, not inferred: `next` is reassigned from `page` below, and
    // without this tsc chases the two types in a circle (TS7022).
    const page: GraphPage<T> = await graphJson<GraphPage<T>>(next);
    pages++;
    if (page.value?.length) items.push(...page.value);
    next = page["@odata.nextLink"] ?? null;
    if (next && (pages >= GRAPH_MAX_PAGES || items.length >= GRAPH_MAX_ITEMS)) {
      // Never silent: remember it for the run outcome AND say so live.
      lastTruncation = { what, pages, items: items.length, at: Date.now() };
      console.warn(
        `[msgraph] ${what}: stopped at the paging cap after ${pages} page(s) / ` +
          `${items.length} item(s) — Microsoft Graph has more results that were NOT read.`,
      );
      break;
    }
  }
  return items;
}

// --- Calendar ----------------------------------------------------------------

export interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}

export interface GraphEventAttendee {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphEvent {
  id?: string;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string };
  attendees?: GraphEventAttendee[];
}

/** Graph returns calendarView datetimes in UTC WITHOUT a zone suffix
 * ("2026-07-05T10:00:00.0000000") — Date.parse would read that as local
 * time, so append the Z ourselves when no zone marker is present. */
export function graphDateMs(dt?: GraphDateTime): number | null {
  if (!dt?.dateTime) return null;
  const raw = dt.dateTime;
  const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(raw);
  const utc = (dt.timeZone ?? "UTC").toUpperCase() === "UTC";
  const parsed = Date.parse(hasZone || !utc ? raw : `${raw}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Expanded calendar instances (recurring meetings included) in the window.
 * `$top` is a PAGE size, not a limit — every page is read, so a 30-day window
 * over a busy mailbox no longer stops at the oldest 50 events. */
export async function calendarView(startIso: string, endIso: string): Promise<GraphEvent[]> {
  const path =
    `/me/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
    `&endDateTime=${encodeURIComponent(endIso)}` +
    `&$top=50&$select=id,subject,start,end,onlineMeeting,isOnlineMeeting,attendees` +
    `&$orderby=start/dateTime`;
  return graphListAll<GraphEvent>(path, "calendarView");
}

/**
 * Upcoming calendar instances from `now` through +`days` days: anything not yet
 * finished (in-progress meetings included), sorted by start, capped at `cap`.
 * Powers the Meetings "Coming up" rail (horizon is user-configurable — default
 * 1 day). Throws (GraphError) like calendarView — the caller hides the rail on
 * any failure, so an expired session is silent.
 */
export async function upcomingEvents(
  now = Date.now(),
  days = 1,
  cap = 10,
): Promise<GraphEvent[]> {
  const events = await calendarView(
    new Date(now).toISOString(),
    new Date(now + days * 86_400_000).toISOString(),
  );
  return events
    .filter((e) => {
      const start = graphDateMs(e.start);
      if (start === null) return false;
      const end = graphDateMs(e.end);
      // Keep anything still running or yet to start.
      return (end ?? start) >= now;
    })
    .sort((a, b) => (graphDateMs(a.start) ?? 0) - (graphDateMs(b.start) ?? 0))
    .slice(0, cap);
}

/** An event's attendees in the shape the local store persists ({name,email}[],
 * capped at 30 — same as the web Teams connector). */
export function eventAttendees(event: GraphEvent): Attendee[] {
  return (event.attendees ?? [])
    .map((a) => ({
      name: a?.emailAddress?.name ?? null,
      email: a?.emailAddress?.address ?? null,
    }))
    .filter((a) => a.name || a.email)
    .slice(0, 30);
}

/**
 * The calendar event most plausibly happening NOW (native-recording match):
 * events overlapping `now` inside a (now−90 min, now+30 min) view, preferring
 * online meetings, then the start time closest to now. Null when nothing
 * overlaps — the recording proceeds exactly as before.
 */
export async function currentCalendarEvent(now = Date.now()): Promise<GraphEvent | null> {
  const events = await calendarView(
    new Date(now - 90 * 60_000).toISOString(),
    new Date(now + 30 * 60_000).toISOString(),
  );
  const overlapping = events.filter((e) => {
    const start = graphDateMs(e.start);
    const end = graphDateMs(e.end);
    return start !== null && start <= now && (end === null || end >= now);
  });
  if (overlapping.length === 0) return null;
  overlapping.sort((a, b) => {
    const aOnline = a.isOnlineMeeting ? 0 : 1;
    const bOnline = b.isOnlineMeeting ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return (
      Math.abs(now - (graphDateMs(a.start) ?? 0)) - Math.abs(now - (graphDateMs(b.start) ?? 0))
    );
  });
  return overlapping[0];
}

// --- Online meetings / transcripts --------------------------------------------

export interface GraphOnlineMeeting {
  id: string;
  subject?: string;
  joinWebUrl?: string;
}

export async function findOnlineMeetingByJoinUrl(
  joinUrl: string,
): Promise<GraphOnlineMeeting | null> {
  const filter = encodeURIComponent(`JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`);
  const json = await graphJson<{ value?: GraphOnlineMeeting[] }>(
    `/me/onlineMeetings?$filter=${filter}`,
  );
  return json.value?.[0] ?? null;
}

export interface GraphTranscript {
  id: string;
  createdDateTime?: string;
}

/**
 * Every transcript on a meeting. `$top=100` raises the page size off Graph's
 * 20-item default and paging reads the rest, so a recurring series that has run
 * for months still surfaces its newest transcripts. No `$orderby`: the endpoint
 * does not document a default sort and none is assumed — the whole collection
 * is consumed and the caller dedupes by id.
 */
export async function listTranscripts(meetingId: string): Promise<GraphTranscript[]> {
  return graphListAll<GraphTranscript>(
    `/me/onlineMeetings/${meetingId}/transcripts?$top=100`,
    "listTranscripts",
  );
}

export async function getTranscriptVtt(meetingId: string, transcriptId: string): Promise<string> {
  const res = await graphFetch(
    `/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
    "text/vtt",
  );
  return res.text();
}
