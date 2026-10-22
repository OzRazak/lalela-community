// Tags + automations (phase 19) — thin invoke wrappers over the SQLite store.
// A tag optionally carries ONE automation: `match`/`aiClassify` decide when a
// meeting gets the tag, `actions` decide what happens next (move to folder,
// run workflow, bind summary prompt/model, send to a destination). The JSON
// shapes mirror the cloud jsonb columns (docs/sql/phase19_tags_automations.sql).

import { invoke } from "@tauri-apps/api/core";

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: number;
}

export interface MeetingTag {
  meeting_id: string;
  tag_id: string;
  added_by: "manual" | "rule" | "ai";
}

/** OR across configured groups; schedule_window (if set) ANDs with the rest. */
export interface AutomationMatch {
  title_keywords?: string[];
  attendee_emails?: string[];
  attendee_names?: string[];
  sources?: string[]; // 'desktop' | 'web' | 'teams' | 'readai' | 'granola' | 'fathom' | 'fireflies'
  schedule_window?: {
    days: number[];
    start_hhmm: string;
    end_hhmm: string;
    /** Owner's UTC offset in minutes (editor stamps the browser's); 0 = UTC. */
    utc_offset_minutes?: number;
  };
}

export interface AutomationAiClassify {
  enabled: boolean;
  hint?: string;
  model?: string;
}

/** `atlas` = approved action items → Atlas delivery tickets (MCP).
 * `atlas_pack` = the whole ready meeting (summary, action items, attendees and,
 * only when `includeTranscript`, the transcript) → Atlas actions pack (REST). */
export type SendDestination = "artemis" | "atlas" | "atlas_pack" | "arete" | "artemis_lead_flow";

export interface AutomationSend {
  destination: SendDestination;
  target?: { type: string; id: string; name: string };
  mode: "auto" | "ask";
  /** atlas_pack only: also send the full transcript (opt-in, default off). */
  includeTranscript?: boolean;
}

export interface AutomationActions {
  project_id?: string;
  workflow_id?: string;
  /** Prompt-library id the summary template was copied from — display only. */
  prompt_id?: string;
  /** The runnable summary prompt, inlined (library prompts live client-side
   * in localStorage, so the cloud engine can't resolve prompt_id). */
  summary_prompt_text?: string;
  summary_model?: string;
  actions_model?: string;
  sends?: AutomationSend[];
}

/** Parsed automation (the store keeps the JSON fields as strings). */
export interface Automation {
  tag_id: string;
  enabled: boolean;
  match: AutomationMatch;
  ai_classify: AutomationAiClassify;
  actions: AutomationActions;
}

export type RunStatus = "done" | "pending_approval" | "failed" | "dismissed";

export interface AutomationRun {
  meeting_id: string;
  tag_id: string;
  action: string; // 'tag' | 'move' | 'workflow' | 'summary' | 'send:<destination>'
  status: RunStatus;
  detail: Record<string, unknown> | null;
  ran_by: "cloud" | "desktop";
  ran_at: number;
}

interface RawAutomation {
  tag_id: string;
  enabled: boolean;
  match_json: string;
  ai_classify_json: string;
  actions_json: string;
}

interface RawRun {
  meeting_id: string;
  tag_id: string;
  action: string;
  status: RunStatus;
  detail_json: string | null;
  ran_by: "cloud" | "desktop";
  ran_at: number;
}

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// ---- tags ----

export function listTags(): Promise<Tag[]> {
  return invoke<Tag[]>("list_tags");
}

/** Upsert; pass an empty id to create. */
export function saveTag(tag: { id?: string; name: string; color: string }): Promise<Tag> {
  return invoke<Tag>("save_tag", {
    tag: { id: tag.id ?? "", name: tag.name, color: tag.color, created_at: 0 },
  });
}

export function deleteTag(id: string): Promise<void> {
  return invoke("delete_tag", { id });
}

export function getMeetingTags(meetingId: string): Promise<string[]> {
  return invoke<string[]>("get_meeting_tags", { meetingId });
}

/** Replace a meeting's tag set (manual chips editor). */
export function setMeetingTags(meetingId: string, tagIds: string[]): Promise<void> {
  return invoke("set_meeting_tags", { meetingId, tagIds, addedBy: "manual" });
}

/** Additive tag (engine or sync pull-down); false = was already tagged. */
export function addMeetingTag(
  meetingId: string,
  tagId: string,
  addedBy: "manual" | "rule" | "ai",
): Promise<boolean> {
  return invoke<boolean>("add_meeting_tag", { meetingId, tagId, addedBy });
}

export function listMeetingTags(): Promise<MeetingTag[]> {
  return invoke<MeetingTag[]>("list_meeting_tags");
}

// ---- automations ----

export async function listAutomations(): Promise<Automation[]> {
  const raw = await invoke<RawAutomation[]>("list_automations");
  return raw.map((a) => ({
    tag_id: a.tag_id,
    enabled: a.enabled,
    match: parse<AutomationMatch>(a.match_json, {}),
    ai_classify: parse<AutomationAiClassify>(a.ai_classify_json, { enabled: false }),
    actions: parse<AutomationActions>(a.actions_json, {}),
  }));
}

export function upsertAutomation(a: Automation): Promise<void> {
  return invoke("upsert_automation", {
    automation: {
      tag_id: a.tag_id,
      enabled: a.enabled,
      match_json: JSON.stringify(a.match),
      ai_classify_json: JSON.stringify(a.ai_classify),
      actions_json: JSON.stringify(a.actions),
    },
  });
}

export function deleteAutomation(tagId: string): Promise<void> {
  return invoke("delete_automation", { tagId });
}

// ---- idempotency ledger ----

/** False = the (meeting, tag, action) row already exists → skip, don't error. */
export function recordAutomationRun(run: {
  meeting_id: string;
  tag_id: string;
  action: string;
  status: RunStatus;
  detail?: Record<string, unknown>;
  ran_by: "cloud" | "desktop";
}): Promise<boolean> {
  return invoke<boolean>("record_automation_run", {
    run: {
      meeting_id: run.meeting_id,
      tag_id: run.tag_id,
      action: run.action,
      status: run.status,
      detail_json: run.detail ? JSON.stringify(run.detail) : null,
      ran_by: run.ran_by,
      ran_at: 0, // 0 → store stamps now_millis()
    },
  });
}

export function updateAutomationRunStatus(
  meetingId: string,
  tagId: string,
  action: string,
  status: RunStatus,
): Promise<void> {
  return invoke("update_automation_run_status", { meetingId, tagId, action, status });
}

export function hasAutomationRun(
  meetingId: string,
  tagId: string,
  action: string,
): Promise<boolean> {
  return invoke<boolean>("has_automation_run", { meetingId, tagId, action });
}

export async function listAutomationRuns(meetingId?: string): Promise<AutomationRun[]> {
  const raw = await invoke<RawRun[]>("list_automation_runs", {
    meetingId: meetingId ?? null,
  });
  return raw.map((r) => ({
    meeting_id: r.meeting_id,
    tag_id: r.tag_id,
    action: r.action,
    status: r.status,
    detail: parse<Record<string, unknown> | null>(r.detail_json, null),
    ran_by: r.ran_by,
    ran_at: r.ran_at,
  }));
}
