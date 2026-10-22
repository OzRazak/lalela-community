// Grounded-context builders for the chat surfaces: everything, one folder, or
// one meeting. Each returns a Markdown block the model must answer from.

import {
  searchMeetings,
  listMeetings,
  listMeetingsIn,
  getMeeting,
  getWorkflowOutputs,
  listWorkflows,
  searchTranscripts,
  searchTranscriptsIn,
  transcriptToText,
  formatDate,
  type FullMeeting,
  type MeetingMeta,
  type Segment,
} from "@/lib/lalela";

export const CHAT_SYSTEM_PROMPT =
  "You are Lalela, an assistant that answers questions about the user's meetings. " +
  "Use ONLY the meeting context provided below. When you use a fact, cite the meeting " +
  "by its title (and date). If the answer isn't in the context, say you couldn't find it " +
  "in the meetings rather than guessing. Be concise and use Markdown.";

export const MEETING_CHAT_SYSTEM_PROMPT =
  "You are Lalela, answering questions about ONE meeting. Use ONLY the context provided " +
  "below (transcript, summary, notes and workflow outputs of this meeting). Cite " +
  "timestamps like [3:24] when you reference the transcript. If the answer isn't in the " +
  "context, say so rather than guessing. Be concise and use Markdown.";

/** Live "catch-up" chat during an in-progress recording (Wave A4). The model
 * answers from the transcript captured so far — the meeting is still running, so
 * there's no summary, and a "what did I miss?" is a request to recap the recent
 * discussion. */
export const LIVE_CHAT_SYSTEM_PROMPT =
  "You are Lalela, helping the user DURING a meeting that is still being recorded. " +
  "Use ONLY the live transcript below (it is the conversation so far — no summary exists yet). " +
  "When the user asks what they missed, briefly recap the recent discussion: decisions, open " +
  "questions, action items, and anything addressed to them. If the answer isn't in the " +
  "transcript, say so rather than guessing. Be concise and use Markdown.";

/** Summaries head or transcript head for a set of metas (shared shape). */
async function metasToContext(metas: MeetingMeta[], cap: number): Promise<string> {
  const parts: string[] = [];
  for (const m of metas.slice(0, cap)) {
    const full = await getMeeting(m.id);
    const body = full.summary.trim()
      ? full.summary
      : transcriptToText(full.segments).slice(0, 1500);
    parts.push(`### ${full.title} — ${formatDate(full.created_at)}\n${body}`);
  }
  return parts.join("\n\n");
}

/** Pinpoint retrieval (Slice 3): full-text excerpts matching the question,
 * prepended so the model can cite exact moments, not just summaries. Scope is
 * either one folder (`projectId`) or — in folder chat's "include subfolders"
 * mode — a folder SET (`projectIds`, folder ∪ descendants). When a non-empty set
 * is passed it wins over `projectId`. */
async function retrievedExcerpts(
  question: string,
  projectId: string | null,
  projectIds?: string[],
): Promise<string> {
  const hits = await (projectIds && projectIds.length > 0
    ? searchTranscriptsIn(question, projectIds)
    : searchTranscripts(question, projectId)
  ).catch(() => []);
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `- **${h.title}** (${formatDate(h.created_at)}): …${h.snippet}…`);
  return `RETRIEVED EXCERPTS (verbatim matches for this question):\n${lines.join("\n")}\n\n`;
}

/** All meetings: relevance-searched, falling back to the most recent. */
export async function buildGlobalContext(question: string): Promise<string> {
  let metas = await searchMeetings(question);
  if (metas.length === 0) metas = await listMeetings(null);
  const excerpts = await retrievedExcerpts(question, null);
  return excerpts + (await metasToContext(metas, 6));
}

/** One folder: every meeting filed there (most recent first, capped).
 *
 * In folder chat's "include subfolders" mode the host passes `projectIds` — the
 * folder ∪ its descendant folder ids (see {@link descendantProjectIds}) — and the
 * meeting set + FTS excerpts both draw from that whole subtree in one query each.
 * Omit `projectIds` (or pass an empty set) for the plain single-folder / All
 * scope. The content bounds are unchanged (same 8-meeting cap, same excerpt cap);
 * only the meeting SET widens. */
export async function buildFolderContext(
  projectId: string | null,
  question = "",
  projectIds?: string[],
): Promise<string> {
  const recursive = !!projectIds && projectIds.length > 0;
  const metas = recursive ? await listMeetingsIn(projectIds!) : await listMeetings(projectId);
  const excerpts = question
    ? await retrievedExcerpts(question, projectId, recursive ? projectIds : undefined)
    : "";
  return excerpts + (await metasToContext(metas, 8));
}

/** One meeting: summary + notes + workflow outputs + as much transcript as is
 * reasonable to send. */
export async function buildMeetingContext(meeting: FullMeeting): Promise<string> {
  const parts: string[] = [
    `### ${meeting.title} — ${formatDate(meeting.created_at)}`,
  ];
  if (meeting.summary.trim()) parts.push(`SUMMARY:\n${meeting.summary}`);
  if (meeting.notes.trim()) parts.push(`NOTES:\n${meeting.notes}`);
  // Workflow outputs are already distilled — include them all (best-effort).
  try {
    const workflows = await listWorkflows();
    for (const wf of workflows) {
      const outputs = await getWorkflowOutputs(meeting.id, wf.id);
      for (const o of outputs) {
        if (!o.output.trim()) continue;
        const block = wf.blocks.find((b) => b.id === o.block_id);
        parts.push(`WORKFLOW OUTPUT (${wf.name} — ${block?.name ?? "block"}):\n${o.output}`);
      }
    }
  } catch {
    /* outputs are optional context */
  }
  parts.push(`TRANSCRIPT:\n${transcriptToText(meeting.segments).slice(0, 24000)}`);
  return parts.join("\n\n");
}

/** Live catch-up (Wave A4): the in-progress transcript, same shape as
 * buildMeetingContext's TRANSCRIPT block, but keeping the LAST ~24k chars — the
 * recent discussion is what a mid-meeting "what did I miss?" is about (whereas
 * a finished meeting sends its head). No FTS retrieval: the live segments aren't
 * indexed yet, so `question` is unused. Reads the segments passed at ask time,
 * so the host must hand it the CURRENT segments (e.g. from a ref). */
export function buildLiveContext(segments: Segment[]): string {
  const full = transcriptToText(segments);
  const transcript = full.length > 24000 ? full.slice(-24000) : full;
  return `LIVE TRANSCRIPT (recording in progress):\n${transcript || "(nothing transcribed yet)"}`;
}
