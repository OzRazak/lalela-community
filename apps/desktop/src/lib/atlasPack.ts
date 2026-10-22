// Lalela → Atlas "actions pack" (desktop side). Atlas turns a READY meeting
// (transcript + non-empty summary) into proposed actions — email drafts,
// tasks, calendar holds — that the user approves in Atlas.
//
// The payload itself is built server-side by the hosted route
// /api/actions-pack/send (apps/web/lib/atlasPack.ts, unit-tested) from the
// cloud mirror of the meeting, with the user's own stored Atlas key. So the
// desktop's job is to make the meeting READY and make sure the cloud copy is
// current before asking the route to send:
//   1. wait for any summary generation the meeting view already started;
//   2. if there's still no summary, generate one in the background with the
//      SAME generator + settings the meeting view's auto-summary uses (the
//      detached summaryGen store, so an open meeting view shows "Generating…");
//   3. push the meeting to the cloud (awaited, not fire-and-forget);
//   4. POST to the route. Dedupe lives there (crm_pushes, provider
//      "atlas_pack", keyed by meeting + contentHash) → 409 = already sent.
// Privacy: the transcript only travels when includeTranscript is set (per rule
// / per click). Voiceprints never leave the device — they're not in the
// meeting row that's pushed.

import { trackEvent } from "./analytics";
import {
  getMeeting,
  listActionItems,
  transcriptToText,
  updateMeeting,
  type ActionItem,
  type FullMeeting,
} from "@/lib/lalela";
import { supabase } from "@/lib/supabase";
import {
  planActionItemSync,
  type CloudActionItemContent,
  type LocalActionItem,
} from "@/lib/atlasPackSync";
import { aiGenerate, LALELA_API, NoAiError } from "@/lib/ai";
import { AiConsentError } from "@/lib/aiConsent";
import { accessToken, currentUid } from "@/lib/automationsSync";
import { pushMeeting } from "@/lib/sync";
import { getPrompts, getResponseLength, getSelectedPromptId } from "@/lib/settings";
import { autogenModel, generateMeetingTitle } from "@/lib/autogen";
import { awaitSummaryGen, startSummaryGen } from "@/lib/summaryGen";

export interface AtlasPackSendResult {
  ok?: boolean;
  alreadySent?: boolean;
  pushedAt?: string;
  packId?: string | null;
  status?: string;
  duplicate?: boolean;
  transcriptIncluded?: boolean;
  transcriptTruncated?: boolean;
  summaryGenerated?: boolean;
  /** Sent, but Lalela's dedupe ledger write failed (kept on the run detail). */
  warning?: string;
}

const hasTranscript = (m: FullMeeting) => m.segments.some((s) => !!s.text?.trim());

/** Make the meeting "ready" for Atlas (summary generated if missing) and push
 * the current version to the cloud. Throws a user-facing Error otherwise. */
export async function ensureReadyForAtlas(
  meetingId: string,
  /** The Send-to-Atlas dialog (user-started) may ask for cloud-AI consent;
   * automation sends stay background (skipped quietly if unanswered). */
  interactive = false,
): Promise<{ meeting: FullMeeting; summaryGenerated: boolean }> {
  const uid = await currentUid();
  if (!uid) throw new Error("Sign in to send meetings to Atlas.");

  // A generation the meeting view started (auto-summary / Generate) — wait for
  // it (and its persist) rather than racing it.
  await awaitSummaryGen(meetingId);
  let m = await getMeeting(meetingId);
  if (!hasTranscript(m)) throw new Error("This meeting has no transcript yet — nothing to send to Atlas.");

  let summaryGenerated = false;
  if (!m.summary.trim()) {
    const base = m;
    const prompts = getPrompts();
    const prompt = prompts.find((p) => p.id === getSelectedPromptId()) ?? prompts[0];
    let noAi = false;
    let consentErr: AiConsentError | null = null;
    // Same generator + settings as the meeting view's auto-summary. A no-op if
    // the view started one in the meantime — awaitSummaryGen covers both.
    void startSummaryGen(base.id, {
      run: async () => {
        const isPlaceholderTitle = /^Meeting · /.test(base.title);
        const title = isPlaceholderTitle
          ? await generateMeetingTitle(base.segments, interactive)
          : null;
        const summary = await aiGenerate(transcriptToText(base.segments), prompt.text, autogenModel(), {
          length: getResponseLength(),
          interactive,
        });
        if (title) pendingTitle.set(base.id, title);
        return summary;
      },
      onSuccess: async (summary) => {
        const generatedTitle = pendingTitle.get(base.id);
        pendingTitle.delete(base.id);
        // Reload first: generation can take minutes, and title/notes/folder
        // edits made meanwhile must survive. Only the summary is ours to
        // write; the AI title only replaces a still-untouched placeholder.
        const cur = await getMeeting(base.id);
        const title = generatedTitle && cur.title === base.title ? generatedTitle : cur.title;
        await updateMeeting(cur.id, title, cur.notes, summary, cur.project_id);
      },
      onError: (e) => {
        pendingTitle.delete(base.id);
        if (e instanceof NoAiError) noAi = true;
        if (e instanceof AiConsentError) consentErr = e;
      },
    });
    const state = await awaitSummaryGen(base.id);
    m = await getMeeting(meetingId);
    if (!m.summary.trim()) {
      if (noAi) {
        throw new Error("No AI model is set up to write the summary Atlas needs — add one in Settings.");
      }
      // Cloud-AI consent refused / unanswered: rethrow it as-is so automation
      // and folder-rule callers can keep the send retryable. Also catches a
      // generation another surface started (its error is only a message).
      if (consentErr) throw consentErr;
      for (const reason of ["undecided", "denied"] as const) {
        const ce = new AiConsentError(reason);
        if (state.error === ce.message) throw ce;
      }
      throw new Error(
        `Couldn't generate the summary Atlas needs${state.error ? `: ${state.error}` : "."}`,
      );
    }
    summaryGenerated = true;
  }

  try {
    await pushMeeting(uid, m);
  } catch (e) {
    throw new Error(
      `Couldn't sync this meeting to your Lalela cloud before sending to Atlas: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  // pushMeeting doesn't carry action items, and the per-item push on approve is
  // best-effort (offline approvals/edits never reach the cloud). The route reads
  // the cloud rows, so mirror this meeting's approved/in-flight items now —
  // strictly: a failure aborts rather than sending a stale pack.
  await syncActionItemsForAtlas(uid, m);
  return { meeting: m, summaryGenerated };
}

/** Mirror this meeting's non-suggested local action items to the cloud without
 * ever regressing workflow state: missing rows are inserted, existing rows get
 * content columns only (status/assignee stay cloud-authoritative — assignees
 * move tasks cloud-side). Errors are NOT swallowed. Plan: atlasPackSync.ts. */
async function syncActionItemsForAtlas(uid: string, m: FullMeeting): Promise<void> {
  const fail = (what: string, e: unknown) =>
    new Error(
      `Couldn't sync this meeting's action items to your Lalela cloud — nothing was sent to Atlas (${what}: ${
        e instanceof Error ? e.message : String(e)
      }).`,
    );
  let items: ActionItem[];
  try {
    items = (await listActionItems(m.id)).filter((a) => a.status !== "suggested");
  } catch (e) {
    throw fail("read local", e);
  }
  if (items.length === 0) return;
  const { data: cloud, error: readErr } = await supabase
    .from("action_items")
    .select("id,title,due,meeting_title,project_id")
    .eq("meeting_id", m.id);
  if (readErr) throw fail("read cloud", readErr);
  const local: LocalActionItem[] = items.map((i) => ({
    id: i.id,
    meeting_id: i.meeting_id,
    project_id: i.project_id,
    title: i.title,
    assignee_name: i.assignee_name,
    assignee_uid: i.assignee_uid,
    status: i.status,
    due: i.due,
    meeting_title: i.meeting_title,
  }));
  const plan = planActionItemSync(uid, local, (cloud ?? []) as CloudActionItemContent[]);
  if (plan.inserts.length) {
    // ON CONFLICT DO NOTHING: a row that appeared since the read is left as-is.
    const { error } = await supabase
      .from("action_items")
      .upsert(plan.inserts, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw fail("insert", error);
  }
  for (const u of plan.contentUpdates) {
    const { error } = await supabase.from("action_items").update(u.patch).eq("id", u.id);
    if (error) throw fail("update", error);
  }
}

const pendingTitle = new Map<string, string>();

/** Make the meeting ready, then send it to Atlas via the hosted route.
 * Returns `{ alreadySent: true }` on 409 (this exact content was sent before
 * and `resend` was false). Throws a user-facing Error on failure. */
export async function sendAtlasPack(
  meetingId: string,
  opts: { includeTranscript?: boolean; resend?: boolean; interactive?: boolean } = {},
): Promise<AtlasPackSendResult> {
  const token = await accessToken();
  if (!token) throw new Error("Sign in to send meetings to Atlas.");
  const { summaryGenerated } = await ensureReadyForAtlas(meetingId, opts.interactive === true);
  let res: Response;
  try {
    res = await fetch(`${LALELA_API}/api/actions-pack/send`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        meetingId,
        includeTranscript: opts.includeTranscript === true,
        resend: opts.resend === true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
  } catch {
    throw new Error("Couldn't reach Lalela's servers — check your connection and try again later.");
  }
  const j = (await res.json().catch(() => ({}))) as AtlasPackSendResult & { error?: string };
  if (res.status === 409) return { alreadySent: true, pushedAt: j.pushedAt, summaryGenerated };
  if (!res.ok) throw new Error(j.error ?? `Send to Atlas failed (${res.status}).`);
  trackEvent("feature_used", { feature: "atlas_send", action: "used" });
  return { ...j, summaryGenerated };
}
