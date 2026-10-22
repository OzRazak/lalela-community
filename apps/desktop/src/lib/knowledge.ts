// Knowledge-layer orchestration (Intelligence Layer, Slice 3): the rolling
// per-project brief and the LLM-compiled wiki. Both run FRONTEND-side through
// the aiGenerate front door (so BYOK / free tier / local all work) and both
// are fire-and-forget enhancements — a failure never blocks the summary the
// user actually asked for.

import {
  getMeeting,
  listMeetings,
  listActionItems,
  setProjectBrief,
  upsertWikiPages,
  transcriptToText,
  formatDate,
  type FullMeeting,
  type WikiPageInput,
} from "@/lib/lalela";
import { aiGenerate } from "@/lib/ai";

const BRIEF_SYSTEM = `You maintain a rolling project brief for a meeting notetaker. From the meeting summaries and open action items provided, write a compact Markdown brief with exactly these sections:

## State
2-4 sentences on where the project stands now.

## Decisions
Bullet list of decisions made so far (most recent first). Cite the meeting title in parentheses.

## Open actions
Bullet list of open/unfinished actions with owners where known.

Only use facts present in the input. No preamble, no code fences.`;

/** How many recent meetings feed the brief (token budget, oldest dropped). */
const BRIEF_MEETINGS = 10;

/** Recompute a project's brief.md from its recent summaries + open actions.
 * Best-effort: returns false when skipped (no AI source, nothing to say). */
export async function recompileProjectBrief(projectId: string): Promise<boolean> {
  try {
    const metas = await listMeetings(projectId);
    const withContent: string[] = [];
    for (const m of metas.slice(0, BRIEF_MEETINGS)) {
      const full = await getMeeting(m.id);
      if (!full.summary.trim()) continue;
      withContent.push(`### ${full.title} — ${formatDate(full.created_at)}\n${full.summary}`);
    }
    if (withContent.length === 0) return false;

    const actions = (await listActionItems())
      .filter((a) => a.project_id === projectId && a.status !== "done")
      .map((a) => `- ${a.title}${a.assignee_name ? ` (${a.assignee_name})` : ""}`)
      .join("\n");

    const input =
      `MEETING SUMMARIES (newest first):\n\n${withContent.join("\n\n")}` +
      (actions ? `\n\nOPEN ACTION ITEMS:\n${actions}` : "");
    const brief = await aiGenerate(input, BRIEF_SYSTEM);
    if (!brief.trim()) return false;
    await setProjectBrief(projectId, brief.trim());
    return true;
  } catch {
    return false; // no AI source / offline / etc — the brief just stays stale
  }
}

const WIKI_SYSTEM = `You maintain a knowledge wiki compiled from meeting transcripts. From the meeting provided, extract wiki pages for durable entities: people discussed (kind "person"), projects/engagements (kind "project"), and recurring topics (kind "topic"). Skip small talk and one-off details.

Respond with ONLY a JSON object, no code fences:
{"pages":[{"kind":"person|project|topic","title":"...","summary_line":"one line","tags":["..."],"content_md":"markdown body with the durable facts","facts":[{"quote":"verbatim supporting quote from the transcript","t_ms":123000}]}]}

Rules: every page MUST have at least one fact whose quote appears verbatim (or near-verbatim) in the input; t_ms is the [m:ss] timestamp converted to milliseconds when available, else null. 0-4 pages per meeting; empty pages array if nothing durable was discussed. Never invent facts.`;

/** Tolerant JSON extraction: models sometimes wrap output in fences/prose. */
export function extractPagesJson(raw: string): WikiPageInput[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { pages?: unknown };
    if (!Array.isArray(parsed.pages)) return [];
    return parsed.pages.filter(
      (p): p is WikiPageInput =>
        !!p &&
        typeof (p as WikiPageInput).title === "string" &&
        typeof (p as WikiPageInput).content_md === "string" &&
        Array.isArray((p as WikiPageInput).facts) &&
        (p as WikiPageInput).facts.length > 0,
    );
  } catch {
    return [];
  }
}

/** Compile wiki pages from one meeting (call after a summary generation —
 * the user already opted into an LLM call there). Best-effort. */
export async function compileWikiForMeeting(meeting: FullMeeting): Promise<number> {
  try {
    const transcript = transcriptToText(meeting.segments).slice(0, 24_000);
    const input =
      `MEETING: ${meeting.title} — ${formatDate(meeting.created_at)}\n\n` +
      (meeting.summary.trim() ? `SUMMARY:\n${meeting.summary}\n\n` : "") +
      `TRANSCRIPT:\n${transcript}`;
    const raw = await aiGenerate(input, WIKI_SYSTEM);
    const pages = extractPagesJson(raw);
    if (pages.length === 0) return 0;
    return await upsertWikiPages(meeting.id, pages);
  } catch {
    return 0;
  }
}

/** Run both knowledge updates after a summary lands. Fire-and-forget. */
export function updateKnowledgeAfterSummary(meeting: FullMeeting): void {
  void compileWikiForMeeting(meeting);
  if (meeting.project_id) void recompileProjectBrief(meeting.project_id);
}
