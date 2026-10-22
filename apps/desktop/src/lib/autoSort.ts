// Auto-sort meetings into folders — the IMPURE half: Tauri commands for the
// meeting_sort ledger (src-tauri/src/autosort.rs), settings, folder discovery,
// the resumable background batch (module-level store, like summaryGen.ts) and
// the new-meeting hook. Prompting/parsing/routing are pure in autoSortCore.ts.
//
// Folders ARE projects (meetings.project_id, one folder per meeting). Every
// AI call goes through the one front door (aiGenerate) on the auto-generation
// model, so the user's configured provider (local / Apple / BYOK / free) is
// respected. Nothing is ever filed into a folder the user hasn't approved, and
// a folder set by hand is never overwritten (enforced in Rust).

import { trackEvent } from "./analytics";
import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  aiGenerate,
  aiRoute,
  NoAiError,
  preflightCloudAiConsent,
  QuotaError,
  type AiRoute,
} from "@/lib/ai";
import { AiConsentError } from "@/lib/aiConsent";
import { autogenModel } from "@/lib/autogen";
import {
  createProject,
  flattenProjectTree,
  getMeeting,
  listMeetings,
  listProjects,
  moveMeetingToProject,
  renameProject,
  type FullMeeting,
  type Project,
} from "@/lib/lalela";
import { pushProject } from "@/lib/sync";
import { supabase } from "@/lib/supabase";
import { onSummaryGenerated } from "@/lib/summaryGen";
import { meetingCloudQueue } from "@/lib/meetingCloudQueue";
import {
  buildClassifyPrompt,
  buildDiscoveryPrompt,
  ClassifyParseError,
  clusterTitles,
  createSingleFlight,
  planFolderPush,
  DEFAULT_THRESHOLD,
  parseClassifyOutput,
  parseDiscoveryOutput,
  routeDecision,
  type ClassifyResult,
  type ProposedFolder,
  type SortFolder,
} from "@/lib/autoSortCore";

// ── Ledger commands ──────────────────────────────────────────────────────

export interface SortDecision {
  meeting_id: string;
  status: "auto" | "review";
  folder_id: string | null;
  suggested_new_folder: string | null;
  confidence: number;
  title_mismatch: boolean;
  reason: string;
  run_id: string | null;
  model: string | null;
}

export interface RecordOutcome {
  result: "filed" | "queued" | "kept";
  meeting: FullMeeting | null;
}

export interface SortRecord {
  meeting_id: string;
  title: string;
  created_at: number;
  project_id: string | null;
  status: "auto" | "review" | "manual" | "skipped";
  folder_id: string | null;
  suggested_new_folder: string | null;
  confidence: number | null;
  title_mismatch: boolean;
  reason: string;
  run_id: string | null;
  updated_at: number;
  summary_head: string;
}

export interface SortStats {
  unsorted: number;
  review: number;
  auto: number;
  manual: number;
  skipped: number;
  last_run_id: string | null;
  last_run_count: number;
}

const recordDecision = (decision: SortDecision) =>
  invoke<RecordOutcome>("autosort_record", { decision });
export const markManualSort = (meetingId: string, folderId: string | null) =>
  invoke<void>("autosort_mark_manual", { meetingId, folderId });
const skipSort = (meetingId: string) => invoke<void>("autosort_skip", { meetingId });
const sortCandidates = () => invoke<string[]>("autosort_candidates");
export const sortReviewQueue = () => invoke<SortRecord[]>("autosort_review_queue");
export const recentAutoSorts = (limit = 50) => invoke<SortRecord[]>("autosort_recent", { limit });
export const sortStats = () => invoke<SortStats>("autosort_stats");
export interface RevertedSort {
  meeting_id: string;
  /** The folder the undone run had filed it into. */
  folder_id: string;
}
const undoSortRun = (runId: string) => invoke<RevertedSort[]>("autosort_undo_run", { runId });

// ── Change notifications (sidebar badge, queue view) ─────────────────────

const changeListeners = new Set<() => void>();
export function onSortChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}
function emitChanged(): void {
  for (const l of changeListeners) {
    try {
      l();
    } catch {
      /* a listener must never break the sorter */
    }
  }
}

// ── Settings (localStorage, like settings.ts) ────────────────────────────

const KEYS = {
  config: "lalela.autosort.config",
  threshold: "lalela.autosort.threshold",
  autoNew: "lalela.autosort.autoNew",
  activeRun: "lalela.autosort.activeRun",
};

/** The approved folder set: project ids + optional "what goes here" hints. */
export interface SortConfig {
  folders: { id: string; hint: string }[];
  approvedAt: number;
}

export function getSortConfig(): SortConfig | null {
  try {
    const raw = localStorage.getItem(KEYS.config);
    if (!raw) return null;
    const c = JSON.parse(raw) as SortConfig;
    return Array.isArray(c.folders) ? c : null;
  } catch {
    return null;
  }
}
function saveSortConfig(c: SortConfig): void {
  localStorage.setItem(KEYS.config, JSON.stringify(c));
  emitChanged();
}

export function getSortThreshold(): number {
  const v = Number(localStorage.getItem(KEYS.threshold));
  return Number.isFinite(v) && v >= 0.5 && v <= 0.99 ? v : DEFAULT_THRESHOLD;
}
export function setSortThreshold(v: number): void {
  localStorage.setItem(KEYS.threshold, String(Math.min(0.99, Math.max(0.5, v))));
}

/** Classify new meetings once their summary exists (default on once approved). */
export function getSortNewMeetings(): boolean {
  return localStorage.getItem(KEYS.autoNew) !== "false";
}
export function setSortNewMeetings(v: boolean): void {
  localStorage.setItem(KEYS.autoNew, String(v));
}

/** Approved folders that still exist, with their full display path. */
export function approvedFolders(projects: Project[], config = getSortConfig()): SortFolder[] {
  if (!config) return [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const path = (p: Project): string => {
    const parts = [p.name];
    let cur = p.parent_id ? byId.get(p.parent_id) : undefined;
    for (let i = 0; cur && i < 8; i++) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join(" / ");
  };
  return config.folders
    .filter((f) => byId.has(f.id))
    .map((f) => ({ id: f.id, name: path(byId.get(f.id)!), hint: f.hint || undefined }));
}

// ── Cloud: the folder rides the existing meetings mirror ─────────────────


/** Best-effort: mirror a folder change to the cloud meeting row (owner RLS).
 * Runs on the SAME per-meeting queue as every pushMeeting (hand moves included),
 * so a hand move issued after an auto-file is always written after it — and by
 * the time the auto-file's turn comes it re-reads local and skips if moved.
 * Lighter than a full pushMeeting — only project_id changes. A meeting that
 * isn't in the cloud yet simply gets the folder on its next full push.
 *
 * The LAST LOCAL CHOICE ALWAYS WINS (review P1): writes are serialised per
 * meeting; right before writing, the local folder is re-read and the write is
 * dropped if it no longer matches (a later hand move / undo superseded it);
 * and `ifCloudIs` makes the write a compare-and-set — an auto-file only lands
 * if the cloud row is still Unfiled, an undo only if the cloud row still holds
 * the run's folder — so it can't clobber a move made via pushMeeting or web. */
function pushFolderChange(
  meetingId: string,
  projectId: string | null,
  ifCloudIs?: string | null,
): Promise<void> {
  return meetingCloudQueue(meetingId, async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return; // signed out: cloud push is gated on sign-in
      const local = await getMeeting(meetingId).then(
        (m) => m.project_id,
        () => undefined,
      );
      if (planFolderPush(projectId, local) === "skip") return;
      let q = supabase.from("meetings").update({ project_id: projectId }).eq("id", meetingId);
      if (ifCloudIs !== undefined) {
        q = ifCloudIs === null ? q.is("project_id", null) : q.eq("project_id", ifCloudIs);
      }
      await q;
    } catch {
      /* offline — the next full sync carries it */
    }
  });
}

// ── Classification ───────────────────────────────────────────────────────

/** Serialise every classifier call (batch + new-meeting hook) — the local
 * sidecar is a single channel, and paid routes are throttled anyway. */
let serial: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = serial.then(fn, fn);
  serial = next.catch(() => {});
  return next;
}

function classifyInputFrom(m: FullMeeting) {
  const people = new Set<string>();
  for (const a of m.attendees ?? []) {
    const n = (a.name || a.email || "").trim();
    if (n) people.add(n);
  }
  for (const s of m.segments) {
    const sp = (s.speaker || "").trim();
    if (sp && !/^(speaker\s*\d+|unknown)$/i.test(sp)) people.add(sp);
  }
  return {
    title: m.title,
    date: new Date(m.created_at).toISOString().slice(0, 10),
    people: [...people],
    summary: m.summary || "",
    lines: m.segments.map((s) => `${s.speaker}: ${s.text}`),
  };
}

/** One meeting → validated classifier result (one retry on a malformed reply). */
export async function classifyMeeting(
  m: FullMeeting,
  folders: SortFolder[],
  model = autogenModel(),
): Promise<ClassifyResult> {
  const { system, user } = buildClassifyPrompt(classifyInputFrom(m), folders);
  const raw = await aiGenerate(user, system, model);
  try {
    return parseClassifyOutput(raw, folders);
  } catch (e) {
    if (!(e instanceof ClassifyParseError)) throw e;
    const retry = await aiGenerate(
      user,
      `${system}\n\nYour previous reply was not valid JSON of the required shape. Reply with the JSON object ONLY.`,
      model,
    );
    return parseClassifyOutput(retry, folders);
  }
}

/** Classify + apply one meeting. Returns the ledger outcome. */
async function sortOne(
  m: FullMeeting,
  folders: SortFolder[],
  threshold: number,
  runId: string | null,
  model: string,
): Promise<RecordOutcome> {
  const r = await classifyMeeting(m, folders, model);
  const { route } = routeDecision(r, threshold);
  const outcome = await recordDecision({
    meeting_id: m.id,
    status: route,
    folder_id: r.folderId,
    suggested_new_folder: r.suggestedNewFolder ?? null,
    confidence: r.confidence,
    title_mismatch: r.titleMismatch,
    reason: r.reason,
    run_id: runId,
    model,
  });
  if (outcome.result === "filed" && outcome.meeting) {
    // Auto-file only ever applies to an Unfiled meeting: CAS on cloud NULL.
    void pushFolderChange(m.id, outcome.meeting.project_id, null);
  }
  return outcome;
}

// ── New meetings: classify once the summary exists ───────────────────────

let hooksInstalled = false;
/** Install the new-meeting hook (idempotent; called once from App). */
export function installAutoSortHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  onSummaryGenerated((meetingId) => {
    void (async () => {
      const config = getSortConfig();
      if (!config || !getSortNewMeetings()) return;
      try {
        const m = await getMeeting(meetingId);
        if (m.project_id) return; // already in a folder (recorded into one, or by hand)
        const folders = approvedFolders(await listProjects(), config);
        if (folders.length === 0) return;
        const model = autogenModel();
        await serialised(() => sortOne(m, folders, getSortThreshold(), null, model));
        emitChanged();
      } catch {
        /* best-effort — never disturbs the summary that triggered it */
      }
    })();
  });
}

// ── Batch run (resumable, cancellable, throttled) ────────────────────────

export type RunStatus = "idle" | "running" | "cancelling" | "paused" | "done" | "error";

export interface RunState {
  status: RunStatus;
  runId: string | null;
  total: number;
  processed: number;
  filed: number;
  queued: number;
  failed: number;
  /** Rolling average ms per meeting (incl. throttle) — drives the ETA. */
  msPerItem: number;
  error?: string;
}

const IDLE: RunState = {
  status: "idle",
  runId: null,
  total: 0,
  processed: 0,
  filed: 0,
  queued: 0,
  failed: 0,
  msPerItem: 0,
};

/** Min gap between paid calls (BYOK / free tier) — a gentle throttle. */
export const PAID_GAP_MS = 1500;
const MAX_CONSECUTIVE_FAILURES = 5;

function loadPersisted(): RunState {
  try {
    const raw = localStorage.getItem(KEYS.activeRun);
    if (!raw) return IDLE;
    const s = JSON.parse(raw) as RunState;
    // A run that was going when the app quit comes back paused — resuming
    // costs money on paid routes, so it waits for the user's click.
    return s.runId ? { ...s, status: "paused" } : IDLE;
  } catch {
    return IDLE;
  }
}

let state: RunState = loadPersisted();
const runListeners = new Set<() => void>();
let cancelRequested = false;

function setState(next: RunState): void {
  state = next;
  if (next.status === "running" || next.status === "cancelling" || next.status === "paused") {
    localStorage.setItem(KEYS.activeRun, JSON.stringify(next));
  } else {
    localStorage.removeItem(KEYS.activeRun);
  }
  for (const l of runListeners) l();
}

/** True while an auto-sort batch is filing meetings — folder automations wait
 * for it so their "new since last run" window is complete. */
export function autoSortBusy(): boolean {
  return state.status === "running" || state.status === "cancelling";
}

export function useAutoSortRun(): RunState {
  return useSyncExternalStore(
    (l) => {
      runListeners.add(l);
      return () => {
        runListeners.delete(l);
      };
    },
    () => state,
    () => state,
  );
}

/** Claims the batch slot synchronously (review P2: a double-click on Start
 * must not launch two overlapping paid batches). */
const batchGate = createSingleFlight();

export function cancelAutoSort(): void {
  if (state.status === "running") {
    cancelRequested = true;
    setState({ ...state, status: "cancelling" });
  } else if (state.status === "paused") {
    setState({ ...state, status: "done" });
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sort every unsorted meeting (or resume the paused run). Re-entrant calls
 * while a batch is starting or running return the in-flight batch. */
export function startAutoSort(opts: { resume?: boolean } = {}): Promise<void> {
  if (batchGate.busy()) return Promise.resolve();
  trackEvent("feature_used", { feature: "auto_sort", action: "run_started" });
  return batchGate.run(() => runBatch(opts));
}

async function runBatch(opts: { resume?: boolean }): Promise<void> {
  if (state.status === "running" || state.status === "cancelling") return;
  const config = getSortConfig();
  const folders = approvedFolders(await listProjects(), config);
  if (!config || folders.length === 0) {
    setState({ ...IDLE, status: "error", error: "Approve your folders first." });
    return;
  }
  const model = autogenModel();
  const route: AiRoute = await aiRoute(model);
  if (route === "none") {
    setState({ ...IDLE, status: "error", error: "no-ai" });
    return;
  }
  // User-started batch: ask for cloud-AI consent once, up front (each
  // classification below is a background call).
  if (!(await preflightCloudAiConsent(model).catch(() => false))) {
    setState({ ...IDLE, status: "error", error: new AiConsentError().message });
    return;
  }
  const resuming = opts.resume && state.status === "paused" && state.runId;
  const base: RunState = resuming
    ? { ...state }
    : { ...IDLE, runId: `sort-${Date.now()}` };
  const ids = await sortCandidates();
  cancelRequested = false;
  setState({ ...base, status: "running", total: base.processed + ids.length, error: undefined });

  const threshold = getSortThreshold();
  const paid = route === "byok" || route === "free";
  let consecutiveFailures = 0;
  for (const id of ids) {
    if (cancelRequested) break;
    const t0 = Date.now();
    let s = { ...state };
    try {
      const m = await getMeeting(id);
      const out = await serialised(() => sortOne(m, folders, threshold, s.runId, model));
      if (out.result === "filed") s.filed++;
      else if (out.result === "queued") s.queued++;
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof NoAiError || e instanceof QuotaError || e instanceof AiConsentError) {
        setState({
          ...state,
          status: "paused",
          error: e instanceof NoAiError ? "no-ai" : e.message,
        });
        emitChanged();
        return;
      }
      s.failed++;
      consecutiveFailures++;
      s.error = e instanceof Error ? e.message : String(e);
    }
    if (paid) {
      const spent = Date.now() - t0;
      if (spent < PAID_GAP_MS) await wait(PAID_GAP_MS - spent);
    }
    const elapsed = Date.now() - t0;
    s = {
      ...s,
      status: state.status, // keep "cancelling" if it was requested mid-item
      processed: s.processed + 1,
      msPerItem: s.msPerItem ? s.msPerItem * 0.8 + elapsed * 0.2 : elapsed,
    };
    setState(s);
    if ((s.filed + s.queued) % 10 === 0) emitChanged();
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      setState({ ...state, status: "paused", error: `Stopped after repeated errors: ${s.error}` });
      emitChanged();
      return;
    }
  }
  setState({ ...state, status: "done" });
  emitChanged();
}

/** Undo the most recent auto-sort run: its meetings go back to Unfiled (only
 * those still in the folder the run chose). Returns how many were reverted. */
export async function undoLastAutoSort(): Promise<number> {
  trackEvent("feature_used", { feature: "auto_sort", action: "undone" });
  const s = await sortStats();
  if (!s.last_run_id) return 0;
  const reverted = await undoSortRun(s.last_run_id);
  // CAS: only clear the cloud folder if it still holds the run's choice.
  for (const r of reverted) void pushFolderChange(r.meeting_id, null, r.folder_id);
  emitChanged();
  return reverted.length;
}

// ── Review queue actions ─────────────────────────────────────────────────

/** File a queued meeting into `folderId` by hand (Accept / Pick another). */
export async function fileByHand(meetingId: string, folderId: string): Promise<void> {
  // move_meeting_to_project marks the ledger 'manual' in Rust.
  await moveMeetingToProject(meetingId, folderId);
  void pushFolderChange(meetingId, folderId);
  emitChanged();
}

export async function skipInQueue(meetingId: string): Promise<void> {
  await skipSort(meetingId);
  emitChanged();
}

/** "Create folder & file": the user approved the classifier's new-folder
 * suggestion with this click — create it, add it to the approved set, file. */
export async function createFolderAndFile(meetingId: string, name: string, uid?: string): Promise<Project> {
  const p = await createProject(name.trim(), null);
  if (uid) pushProject(uid, p).catch(() => {});
  const config = getSortConfig() ?? { folders: [], approvedAt: Date.now() };
  saveSortConfig({ ...config, folders: [...config.folders, { id: p.id, hint: "" }] });
  await fileByHand(meetingId, p.id);
  return p;
}

// ── Folder discovery (first run) ─────────────────────────────────────────

/** Propose a folder set from existing folders + title clusters + a content
 * sample. Never creates anything. Falls back to a no-AI proposal (existing
 * folders + frequent title terms) when no model is usable or the reply is bad. */
export async function proposeFolders(): Promise<{ proposals: ProposedFolder[]; usedAi: boolean; error?: string }> {
  const projects = await listProjects();
  // Every existing folder by full path ("PPS / Pricing engine"), tree order.
  const existing = approvedFolders(projects, {
    folders: flattenProjectTree(projects).map(({ project }) => ({ id: project.id, hint: "" })),
    approvedAt: 0,
  }).map((f) => ({ id: f.id, name: f.name }));
  const metas = await listMeetings(null);
  const clusters = clusterTitles(metas.map((m) => m.title));
  // Spread the content sample across the whole history, not just recent.
  const step = Math.max(1, Math.floor(metas.length / 60));
  const samples = metas
    .filter((_, i) => i % step === 0)
    .slice(0, 60)
    .map((m) => ({ title: m.title, snippet: m.snippet }));

  const fallback = (): ProposedFolder[] => {
    const out: ProposedFolder[] = existing.map((e) => ({ name: e.name, hint: "", existingId: e.id }));
    for (const c of clusters.slice(0, 15)) {
      const name = c.term.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
      if (!out.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
        out.push({ name, hint: `Titles mentioning "${c.term}" (${c.count})` });
      }
    }
    return out;
  };

  const { system, user } = buildDiscoveryPrompt(
    existing.map((e) => e.name),
    clusters,
    samples,
  );
  try {
    const raw = await aiGenerate(user, system, autogenModel(), { interactive: true }); // "Find folders" button
    const proposals = parseDiscoveryOutput(raw, existing);
    // Existing folders the model left out are still offered (unticked in UI).
    for (const e of existing) {
      if (!proposals.some((p) => p.existingId === e.id)) {
        proposals.push({ name: e.name, hint: "", existingId: e.id });
      }
    }
    return { proposals, usedAi: true };
  } catch (e) {
    const error = e instanceof NoAiError ? "no-ai" : e instanceof Error ? e.message : String(e);
    return { proposals: fallback(), usedAi: false, error };
  }
}

/** Save the approved set — creating ONLY the new folders the user approved —
 * and push new folders to the cloud when signed in. Existing folders are
 * renamed only if the user renamed them here. */
export async function approveFolders(
  approved: ProposedFolder[],
  uid?: string,
): Promise<SortConfig> {
  trackEvent("feature_used", { feature: "auto_sort", action: "folders_approved" });
  const projects = await listProjects();
  const folders: SortConfig["folders"] = [];
  for (const p of approved) {
    const name = p.name.trim();
    if (!name) continue;
    const current = p.existingId ? projects.find((x) => x.id === p.existingId) : undefined;
    if (current) {
      // Renamed on the approval screen → rename the folder (leaf name only).
      const leaf = name.split(" / ").pop()!.trim();
      const currentPath = approvedFolders(projects, {
        folders: [{ id: current.id, hint: "" }],
        approvedAt: 0,
      })[0]?.name;
      if (leaf && name !== currentPath && leaf !== current.name) {
        const renamed = await renameProject(current.id, leaf);
        if (uid) await pushProject(uid, renamed).catch(() => {});
      }
      folders.push({ id: current.id, hint: p.hint.trim() });
      continue;
    }
    // A nested proposal "PPS / Pricing" creates PPS (if needed) then Pricing.
    const parts = name.split(" / ").map((s) => s.trim()).filter(Boolean);
    let parent: string | null = null;
    let made: Project | null = null;
    for (const part of parts) {
      const found: Project | undefined = projects.find(
        (x) => x.name.toLowerCase() === part.toLowerCase() && (x.parent_id ?? null) === parent,
      );
      if (found) {
        made = found;
      } else {
        made = await createProject(part, parent);
        projects.push(made);
        if (uid) await pushProject(uid, made).catch(() => {});
      }
      parent = made.id;
    }
    if (made) folders.push({ id: made.id, hint: p.hint.trim() });
  }
  const config = { folders, approvedAt: Date.now() };
  saveSortConfig(config);
  return config;
}
