// Auto-generation for freshly saved meetings: a descriptive title (always,
// when any AI route is available) and optionally the summary (Settings
// toggle). Everything here is best-effort — failures must never block saving.

import { transcriptToText, type Segment } from "@/lib/lalela";
import { aiGenerate } from "@/lib/ai";
import { getAutogenModel, getModel } from "@/lib/settings";

const TITLE_PROMPT =
  "Name this meeting from its transcript. Reply with ONLY a short, specific title " +
  "(at most 8 words) describing the main topic or outcome — no quotes, no trailing " +
  "punctuation, no markdown, nothing else.";

/** The model auto-generation runs on ("" setting = follow the current model). */
export function autogenModel(): string {
  return getAutogenModel() || getModel();
}

/** Generate a descriptive title from the transcript head, or null (never throws).
 * Background by default: right after a recording nobody asked for AI, so an
 * unanswered cloud-AI consent quietly keeps the placeholder title (no dialog,
 * nothing sent). `interactive` only for a flow the user just started. */
export async function generateMeetingTitle(
  segments: Segment[],
  interactive = false,
): Promise<string | null> {
  if (segments.length === 0) return null;
  // The opening minutes are enough to name a meeting — don't pay for the rest.
  const text = transcriptToText(segments).slice(0, 6000);
  try {
    const raw = await aiGenerate(text, TITLE_PROMPT, autogenModel(), { interactive });
    const title = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0]
      ?.replace(/^["'“”#*\-\s]+|["'“”.\s]+$/g, "")
      .slice(0, 80)
      .trim();
    return title || null;
  } catch {
    return null;
  }
}
