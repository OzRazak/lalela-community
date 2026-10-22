// Action-item extraction: transcript → structured items via a strict-JSON
// prompt, with assignee names fuzzy-matched to project members (cloud
// profiles) when available.

import { aiRouteLabel, countBucket, lastAiCall, trackEvent } from "./analytics";
import { transcriptToText, type NewActionItem, type Segment } from "@/lib/lalela";
import { aiGenerate } from "@/lib/ai";
import { listMembers, type Member } from "@/lib/sync";

const EXTRACT_PROMPT =
  "Extract every action item from this meeting transcript. Reply with ONLY a JSON array " +
  '(no markdown fence, no prose). Each element: {"title": string (imperative, specific, ' +
  'max ~15 words), "assignee": string|null (the person responsible, using the name said ' +
  'in the meeting; null if nobody was named), "due": string|null (the deadline as spoken, ' +
  'e.g. "Friday", "end of Q3"; null if none)}. Only include real commitments from the ' +
  "transcript — do not invent items. If there are none, reply [].";

/** Strip an accidental markdown fence and parse the model's JSON array. */
function parseItems(raw: string): NewActionItem[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("The model returned no JSON array.");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Array<{
    title?: unknown;
    assignee?: unknown;
    due?: unknown;
  }>;
  return parsed
    .filter((x) => typeof x?.title === "string" && (x.title as string).trim())
    .map((x) => ({
      title: (x.title as string).trim(),
      assignee_name: typeof x.assignee === "string" && x.assignee.trim() ? x.assignee.trim() : null,
      assignee_uid: null,
      due: typeof x.due === "string" && x.due.trim() ? x.due.trim() : null,
    }));
}

/** Best-effort project-member lookup; [] when unfiled, signed out or offline. */
export async function membersForProject(projectId: string | null): Promise<Member[]> {
  if (!projectId) return [];
  try {
    return await listMembers(projectId);
  } catch {
    return [];
  }
}

/** Match an extracted name to a member: exact display-name / email-local-part
 * match first, then first-name match if it's unambiguous. */
export function matchAssignee(name: string | null, members: Member[]): Member | null {
  if (!name || members.length === 0) return null;
  const norm = name.trim().toLowerCase();
  const nameOf = (m: Member) => (m.display_name ?? "").trim().toLowerCase();
  const localOf = (m: Member) => (m.email ?? "").split("@")[0].toLowerCase();

  const exact = members.filter((m) => nameOf(m) === norm || localOf(m) === norm);
  if (exact.length === 1) return exact[0];

  const first = norm.split(/\s+/)[0];
  const byFirst = members.filter(
    (m) => nameOf(m).split(/\s+/)[0] === first || localOf(m) === first,
  );
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Extract action items from a transcript with `model`, matching assignees
 * against `members`. Throws on model/parse errors (the caller shows them). */
export async function extractActionItems(
  segments: Segment[],
  model: string,
  members: Member[],
  /** User-started (the Tasks panel button) — may show the cloud-AI consent
   * dialog. Folder rules leave it off (background). */
  interactive = false,
): Promise<NewActionItem[]> {
  const text = transcriptToText(segments);
  const raw = await aiGenerate(text, EXTRACT_PROMPT, model, { interactive });
  const items = parseItems(raw);
  trackEvent("tasks_extracted", {
    ai_route: aiRouteLabel(lastAiCall()?.route),
    count: countBucket(items.length),
  });
  return items.map((item) => {
    const match = matchAssignee(item.assignee_name, members);
    return match ? { ...item, assignee_uid: match.user_id } : item;
  });
}
