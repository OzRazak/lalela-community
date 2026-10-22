// People & Companies auto-grouping (Wave E2) — CRM-lite aggregation over the
// LOCAL meeting store. Pure client-side: it reads a lean attendees-only
// projection of every meeting (the `list_meeting_attendees` command — one query,
// id/title/folder/timestamp + attendees, no transcript/summary payloads), the
// local task board (`list_action_items`), and clusters them into:
//
//   • People   — one entry per distinct attendee (keyed by email, falling back
//                to a normalized name), with their meetings, first/last-met
//                dates and the open action items involving them.
//   • Companies — people/meetings clustered by email DOMAIN, excluding the
//                signed-in user's own domain and consumer/webmail domains.
//
// No cloud, no schema. The old path read each meeting's FULL row via `get_meeting`
// (one call per meeting) and so was capped at ~2000 rows to stay cheap; the lean
// projection lifts that cap — even a 10k-meeting store is a few MB, so ALL
// meetings are grouped. Memoized (module cache keyed on the meeting-list
// signature) so re-entering the view is instant and it only recomputes when the
// meeting list actually changes.

import {
  listActionItems,
  listMeetingAttendees,
  type ActionItem,
  type Attendee,
  type MeetingAttendees,
} from "@/lib/lalela";
import { connectedAccount } from "@/lib/msauth";
import { emailDomain, isConsumerDomain } from "@/lib/teammates";

/** Extra webmail labels excluded from company clustering, on top of teammates'
 *  `isConsumerDomain` full-domain set — mirrors dossiers' label-level list so
 *  regional variants (gmail.co.uk, yahoo.fr, …) are caught too. */
const CONSUMER_LABELS = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "ymail",
  "icloud", "me", "mac", "proton", "protonmail", "aol", "msn", "gmx",
  "qq", "163", "126", "fastmail", "zoho", "hey",
]);

export interface MeetingRef {
  id: string;
  title: string;
  created_at: number;
}

export interface Person {
  /** Stable identity key: lowercased email, else `name:<normalized-name>`. */
  key: string;
  name: string;
  email: string | null;
  domain: string | null;
  /** Their meetings, newest first. */
  meetings: MeetingRef[];
  meetingCount: number;
  firstMet: number; // epoch ms
  lastMet: number; // epoch ms
  /** Open (approved / in-flight) action items involving them. */
  openActionItems: ActionItem[];
}

export interface Company {
  domain: string;
  /** Display label derived from the domain (acme.com → "Acme"). */
  label: string;
  /** Members, most-recently-met first. */
  people: Person[];
  /** Union of members' meetings, newest first. */
  meetings: MeetingRef[];
  meetingCount: number;
  personCount: number;
  firstMet: number;
  lastMet: number;
}

export interface PeopleCompanies {
  people: Person[]; // sorted by lastMet desc
  companies: Company[]; // sorted by lastMet desc
  /** How many meetings were actually read (≤ MAX_SCAN_MEETINGS). */
  scannedMeetings: number;
  /** Total meetings in the store. */
  totalMeetings: number;
  /** True when the scan hit MAX_SCAN_MEETINGS (older meetings not scanned). */
  capped: boolean;
}

/** The signed-in user, so we can drop them from their own attendee lists and
 *  exclude their company from the Companies view. */
export interface SelfIdentity {
  emails: Set<string>; // lowercased
  names: Set<string>; // normalized
  domains: Set<string>; // lowercased
}

// --- Helpers ---------------------------------------------------------------

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function firstName(norm: string): string {
  return norm.split(" ")[0] ?? "";
}

/** acme.com → "Acme"; sub.acme-corp.io → "Acme Corp". */
function domainLabel(domain: string): string {
  const first = domain.split(".")[0] ?? domain;
  return first
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isConsumerCompanyDomain(email: string, domain: string): boolean {
  if (isConsumerDomain(email)) return true;
  const label = domain.split(".")[0] ?? "";
  return CONSUMER_LABELS.has(label);
}

/** Build the self-identity from the app auth email/name plus, if present, the
 *  connected Microsoft account (whose calendar is where most attendees come
 *  from — the user is listed on their own events). */
export function buildSelfIdentity(opts: {
  email?: string | null;
  name?: string | null;
}): SelfIdentity {
  const emails = new Set<string>();
  const names = new Set<string>();
  const domains = new Set<string>();
  const addEmail = (e?: string | null) => {
    const v = (e ?? "").trim().toLowerCase();
    if (v.includes("@")) {
      emails.add(v);
      const d = emailDomain(v);
      if (d) domains.add(d);
    }
  };
  const addName = (n?: string | null) => {
    const v = normalizeName(n ?? "");
    if (v) names.add(v);
  };
  addEmail(opts.email);
  addName(opts.name);
  const ms = connectedAccount();
  if (ms) {
    addEmail(ms.mail);
    addName(ms.displayName);
  }
  return { emails, names, domains };
}

// --- Aggregation -----------------------------------------------------------

interface PersonAcc {
  key: string;
  email: string | null;
  domain: string | null;
  meetings: MeetingRef[];
  seen: Set<string>; // meeting ids
  nameCounts: Map<string, number>; // raw display name → occurrences
}

/** Core aggregation over already-loaded lean meeting projections + their
 *  attendees (attendees are passed alongside, index-aligned to `metas`). */
function build(
  metas: MeetingAttendees[],
  attendeesByMeeting: Attendee[][],
  actionItems: ActionItem[],
  self: SelfIdentity,
): { people: Person[]; companies: Company[] } {
  const accs = new Map<string, PersonAcc>();
  // meetingId → the set of person keys attending it (for source-meeting action
  // items and for company meeting unions after merges).
  const keysByMeeting = new Map<string, Set<string>>();

  metas.forEach((m, idx) => {
    const ref: MeetingRef = { id: m.id, title: m.title, created_at: m.created_at };
    const here = keysByMeeting.get(m.id) ?? new Set<string>();
    for (const a of attendeesByMeeting[idx] ?? []) {
      const email = ((a.email ?? "").trim().toLowerCase() || null) as string | null;
      const rawName = (a.name ?? "").trim();
      const normName = normalizeName(rawName);
      if (!email && !normName) continue; // empty attendee
      // Drop self — this view is about the OTHER people.
      if (email && self.emails.has(email)) continue;
      if (!email && normName && self.names.has(normName)) continue;

      const key = email ?? `name:${normName}`;
      let acc = accs.get(key);
      if (!acc) {
        acc = {
          key,
          email,
          domain: email ? emailDomain(email) : null,
          meetings: [],
          seen: new Set(),
          nameCounts: new Map(),
        };
        accs.set(key, acc);
      }
      if (rawName) acc.nameCounts.set(rawName, (acc.nameCounts.get(rawName) ?? 0) + 1);
      if (!acc.seen.has(m.id)) {
        acc.seen.add(m.id);
        acc.meetings.push(ref);
      }
      here.add(key);
    }
    if (here.size) keysByMeeting.set(m.id, here);
  });

  // Messy-data pass: fold a name-only person into an email-keyed person when
  // their normalized name matches EXACTLY ONE email person (calendar gives
  // email+name; a Teams/transcript import may give name-only — same human).
  const emailKeysByNorm = new Map<string, string[]>();
  for (const acc of accs.values()) {
    if (!acc.email) continue;
    for (const nm of acc.nameCounts.keys()) {
      const norm = normalizeName(nm);
      if (!norm) continue;
      const arr = emailKeysByNorm.get(norm) ?? [];
      if (!arr.includes(acc.key)) arr.push(acc.key);
      emailKeysByNorm.set(norm, arr);
    }
  }
  for (const acc of [...accs.values()]) {
    if (!acc.key.startsWith("name:")) continue;
    const norm = acc.key.slice("name:".length);
    const targets = emailKeysByNorm.get(norm);
    if (!targets || targets.length !== 1) continue;
    const target = accs.get(targets[0]);
    if (!target) continue;
    for (const mr of acc.meetings) {
      if (!target.seen.has(mr.id)) {
        target.seen.add(mr.id);
        target.meetings.push(mr);
      }
    }
    for (const [nm, n] of acc.nameCounts) {
      target.nameCounts.set(nm, (target.nameCounts.get(nm) ?? 0) + n);
    }
    for (const set of keysByMeeting.values()) {
      if (set.delete(acc.key)) set.add(target.key);
    }
    accs.delete(acc.key);
  }

  // Finalize people.
  const people: Person[] = [];
  for (const acc of accs.values()) {
    let best = "";
    let bestN = 0;
    for (const [nm, n] of acc.nameCounts) {
      if (n > bestN) {
        best = nm;
        bestN = n;
      }
    }
    const name = best || acc.email || "Unknown";
    const times = acc.meetings.map((x) => x.created_at);
    people.push({
      key: acc.key,
      name,
      email: acc.email,
      domain: acc.domain,
      meetings: acc.meetings.sort((a, b) => b.created_at - a.created_at),
      meetingCount: acc.meetings.length,
      firstMet: Math.min(...times),
      lastMet: Math.max(...times),
      openActionItems: [],
    });
  }

  // Attach open action items. Primary: assignee name matches the person (full
  // or first name). Secondary: an UNASSIGNED open item from a meeting they
  // attended (a shared loose end that involves them). Assigned-but-unmatched
  // items attach to nobody here.
  const keysByName = new Map<string, Set<string>>();
  const addName = (nm: string, key: string) => {
    const set = keysByName.get(nm) ?? new Set<string>();
    set.add(key);
    keysByName.set(nm, set);
  };
  for (const p of people) {
    const norm = normalizeName(p.name);
    if (!norm) continue;
    addName(norm, p.key);
    const fn = firstName(norm);
    if (fn.length >= 3) addName(fn, p.key);
  }
  const itemsByKey = new Map<string, ActionItem[]>();
  const pushItem = (key: string, it: ActionItem) => {
    const arr = itemsByKey.get(key) ?? [];
    if (!arr.some((x) => x.id === it.id)) arr.push(it);
    itemsByKey.set(key, arr);
  };
  for (const it of actionItems) {
    const assignee = normalizeName(it.assignee_name ?? "");
    if (assignee) {
      const keys = keysByName.get(assignee) ?? keysByName.get(firstName(assignee));
      if (keys) for (const k of keys) pushItem(k, it);
    } else {
      const keys = keysByMeeting.get(it.meeting_id);
      if (keys) for (const k of keys) pushItem(k, it);
    }
  }
  for (const p of people) p.openActionItems = itemsByKey.get(p.key) ?? [];

  people.sort((a, b) => b.lastMet - a.lastMet || b.meetingCount - a.meetingCount);

  // Cluster into companies by domain (external orgs only).
  const byDomain = new Map<string, { people: Person[]; meetings: Map<string, MeetingRef> }>();
  for (const p of people) {
    if (!p.email || !p.domain) continue;
    if (isConsumerCompanyDomain(p.email, p.domain)) continue;
    if (self.domains.has(p.domain)) continue; // exclude own company
    let bucket = byDomain.get(p.domain);
    if (!bucket) {
      bucket = { people: [], meetings: new Map() };
      byDomain.set(p.domain, bucket);
    }
    bucket.people.push(p);
    for (const mr of p.meetings) bucket.meetings.set(mr.id, mr);
  }
  const companies: Company[] = [];
  for (const [domain, bucket] of byDomain) {
    const meetings = [...bucket.meetings.values()].sort(
      (a, b) => b.created_at - a.created_at,
    );
    const times = meetings.map((m) => m.created_at);
    companies.push({
      domain,
      label: domainLabel(domain),
      people: bucket.people, // already lastMet-desc from the people sort
      meetings,
      meetingCount: meetings.length,
      personCount: bucket.people.length,
      firstMet: Math.min(...times),
      lastMet: Math.max(...times),
    });
  }
  companies.sort((a, b) => b.lastMet - a.lastMet || b.meetingCount - a.meetingCount);

  return { people, companies };
}

// --- Public API (with a module-level memo) ---------------------------------

function signature(metas: MeetingAttendees[], self: SelfIdentity): string {
  let hash = 0;
  for (const m of metas) {
    const s = `${m.id}:${m.created_at}`;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return `${[...self.emails].sort().join(",")}#${metas.length}#${hash}`;
}

let cache: { sig: string; data: PeopleCompanies } | null = null;

/** Drop the memo so the next call recomputes (e.g. after a sign-in change). */
export function invalidatePeopleCompanies(): void {
  cache = null;
}

/**
 * Aggregate People & Companies from the local store. One lean Rust query
 * (`list_meeting_attendees`) returns every meeting's attendees with no cap and no
 * heavy payloads, so ALL meetings are grouped. Memoized on a signature of the
 * meeting list (+ self identity), so re-entering the view returns instantly and
 * it only recomputes when meetings were added/removed.
 */
export async function getPeopleCompanies(
  self: SelfIdentity,
  force = false,
): Promise<PeopleCompanies> {
  const metas = await listMeetingAttendees();
  const sig = signature(metas, self);
  if (!force && cache && cache.sig === sig) return cache.data;

  // Attendees arrive inline on each lean row — index-aligned to `metas`.
  const attendeesByMeeting = metas.map((m) => m.attendees ?? []);

  let actionItems: ActionItem[] = [];
  try {
    actionItems = (await listActionItems()).filter(
      (it) => it.status !== "done" && it.status !== "suggested",
    );
  } catch {
    actionItems = [];
  }

  const { people, companies } = build(metas, attendeesByMeeting, actionItems, self);
  const data: PeopleCompanies = {
    people,
    companies,
    // No cap any more: every meeting is scanned, so scanned == total, never capped.
    scannedMeetings: metas.length,
    totalMeetings: metas.length,
    capped: false,
  };
  cache = { sig, data };
  return data;
}
