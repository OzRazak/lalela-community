// Cloud mirror for automations + the automation_runs ledger (phase 19). Local
// SQLite is canonical for the editor UI, but the CLOUD automation_runs table is
// the shared idempotency ledger between the desktop engine and the cloud engine
// (connector cron / web recordings). These helpers wrap the desktop Supabase
// client with the same shapes apps/web/lib/tags.ts uses, so both engines and
// both UIs agree on state. Everything is best-effort: signed-out or offline
// silently no-ops, exactly like the rest of sync (tagsSync.ts).

import { supabase } from "@/lib/supabase";
import {
  listAutomations as localListAutomations,
  getMeetingTags as localGetMeetingTags,
  recordAutomationRun as localRecordAutomationRun,
  upsertAutomation as localUpsertAutomation,
  addMeetingTag as localAddMeetingTag,
  type Automation,
  type RunStatus,
} from "@/lib/tags";

/** Cloud automation_runs row (ran_at is a timestamptz string in the cloud). */
export interface CloudAutomationRun {
  id: string;
  meeting_id: string;
  tag_id: string;
  action: string;
  status: RunStatus;
  detail: Record<string, unknown> | null;
  ran_by: "cloud" | "desktop";
  ran_at: string;
}

function newRunId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `run-${Date.now()}-${rand}`;
}

export async function currentUid(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function accessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

// ---- automations table (keyed by tag_id, one per tag) ----

export async function cloudUpsertAutomation(a: Automation): Promise<void> {
  const owner = await currentUid();
  if (!owner) return;
  await supabase
    .from("automations")
    .upsert({
      tag_id: a.tag_id,
      owner_id: owner,
      enabled: a.enabled,
      match: a.match,
      ai_classify: a.ai_classify,
      actions: a.actions,
      updated_at: new Date().toISOString(),
    })
    .then(
      () => {},
      () => {},
    );
}

export async function cloudDeleteAutomation(tagId: string): Promise<void> {
  if (!(await currentUid())) return;
  await supabase
    .from("automations")
    .delete()
    .eq("tag_id", tagId)
    .then(
      () => {},
      () => {},
    );
}

// ---- idempotency ledger ----

/** True = the (meeting, tag, action) row already exists in the cloud. */
export async function cloudHasAutomationRun(
  meetingId: string,
  tagId: string,
  action: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("tag_id", tagId)
    .eq("action", action)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** False = the row already existed (another engine won the race) → skip. */
export async function cloudRecordAutomationRun(run: {
  owner_id: string;
  meeting_id: string;
  tag_id: string;
  action: string;
  status: RunStatus;
  detail?: Record<string, unknown>;
  ran_by: "cloud" | "desktop";
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("automation_runs")
    .upsert(
      {
        id: newRunId(),
        owner_id: run.owner_id,
        meeting_id: run.meeting_id,
        tag_id: run.tag_id,
        action: run.action,
        status: run.status,
        detail: run.detail ?? null,
        ran_by: run.ran_by,
      },
      { onConflict: "meeting_id,tag_id,action", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function cloudUpdateAutomationRunStatus(
  meetingId: string,
  tagId: string,
  action: string,
  status: RunStatus,
): Promise<void> {
  const { error } = await supabase
    .from("automation_runs")
    .update({ status })
    .eq("meeting_id", meetingId)
    .eq("tag_id", tagId)
    .eq("action", action);
  if (error) throw new Error(error.message);
}

/** Cloud runs (source of truth for pending approvals — matches web state). */
export async function cloudListAutomationRuns(
  opts: { meetingId?: string; status?: RunStatus } = {},
): Promise<CloudAutomationRun[]> {
  const owner = await currentUid();
  if (!owner) return [];
  let q = supabase
    .from("automation_runs")
    .select("id,meeting_id,tag_id,action,status,detail,ran_by,ran_at")
    .eq("owner_id", owner)
    .order("ran_at", { ascending: false })
    .limit(500);
  if (opts.meetingId) q = q.eq("meeting_id", opts.meetingId);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as CloudAutomationRun[];
}

/** Additive meeting_tag in the cloud (engine tagging). Best-effort. */
export async function cloudAddMeetingTag(
  meetingId: string,
  tagId: string,
  addedBy: "rule" | "ai",
): Promise<void> {
  const owner = await currentUid();
  if (!owner) return;
  await supabase
    .from("meeting_tags")
    .upsert(
      { meeting_id: meetingId, tag_id: tagId, owner_id: owner, added_by: addedBy },
      { onConflict: "meeting_id,tag_id", ignoreDuplicates: true },
    )
    .then(
      () => {},
      () => {},
    );
}

// ---- pull (rides the tags pull in pullOwnCloudMeetings) ----

/** Pull automation definitions created/edited elsewhere (web or another
 * device) into the local mirror. Cloud is authoritative (the editor writes
 * cloud-first), so this upserts local rows for every cloud automation whose
 * tag exists locally. Never blocks meeting sync. */
export async function pullAutomations(ownerUid: string): Promise<void> {
  try {
    const { data: cloud } = await supabase
      .from("automations")
      .select("tag_id,enabled,match,ai_classify,actions")
      .eq("owner_id", ownerUid);
    if (!cloud?.length) return;
    // Only mirror automations whose tag already exists locally — a missing tag
    // means the tag pull hasn't landed it yet; it'll be adopted next sweep.
    const localAutomations = await localListAutomations().catch(() => []);
    const localTagIds = new Set(localAutomations.map((a) => a.tag_id));
    for (const a of cloud) {
      const automation: Automation = {
        tag_id: a.tag_id,
        enabled: a.enabled,
        match: (a.match ?? {}) as Automation["match"],
        ai_classify: (a.ai_classify ?? { enabled: false }) as Automation["ai_classify"],
        actions: (a.actions ?? {}) as Automation["actions"],
      };
      // upsertAutomation FKs on the tag; skipping unknown tags avoids errors.
      if (!localTagIds.has(a.tag_id)) {
        // Tag may still exist locally even without a prior automation row.
        try {
          await localUpsertAutomation(automation);
        } catch {
          /* tag not local yet */
        }
        continue;
      }
      await localUpsertAutomation(automation).catch(() => {});
    }
  } catch {
    /* offline / migration not applied — never block meeting sync */
  }
}

/** Pull the shared ledger down so RunHistory works offline (union-add). Also
 * applies engine tags recorded by the cloud engine to the local meeting_tags
 * (the tags pull covers most, but a run may predate a tag-assignment row). */
export async function pullAutomationRuns(ownerUid: string): Promise<void> {
  try {
    const { data: runs } = await supabase
      .from("automation_runs")
      .select("meeting_id,tag_id,action,status,detail,ran_by")
      .eq("owner_id", ownerUid)
      .order("ran_at", { ascending: false })
      .limit(500);
    for (const r of runs ?? []) {
      await localRecordAutomationRun({
        meeting_id: r.meeting_id,
        tag_id: r.tag_id,
        action: r.action,
        status: r.status as RunStatus,
        detail: (r.detail as Record<string, unknown> | null) ?? undefined,
        ran_by: r.ran_by as "cloud" | "desktop",
      }).catch(() => {});
      // Reflect an engine tag locally if it isn't already assigned.
      if (r.action === "tag" && r.status === "done") {
        const matchedBy = (r.detail as { matched_by?: string } | null)?.matched_by;
        const addedBy = matchedBy === "ai" ? "ai" : "rule";
        const existing = await localGetMeetingTags(r.meeting_id).catch(() => [] as string[]);
        if (!existing.includes(r.tag_id)) {
          await localAddMeetingTag(r.meeting_id, r.tag_id, addedBy).catch(() => {});
        }
      }
    }
  } catch {
    /* offline / migration not applied — never block meeting sync */
  }
}
