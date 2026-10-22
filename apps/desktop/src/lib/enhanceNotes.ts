// "Enhance my notes" (Granola-parity Wave A3): merge the user's rough,
// typed-during-the-meeting notes with the transcript into ONE polished,
// verifiable version. The user's own lines are reproduced verbatim (they anchor
// the structure); everything the AI adds is drawn only from the transcript and
// carries a [m:ss] citation — which the renderer (CitedMarkdown aiMuted) uses to
// gray-out and attribute the additions. Runs through the one AI front door
// (lib/ai.ts) like every other generation; the user's `notes` are never mutated
// (the result is stored separately as `enhanced_notes`).

import { aiGenerate } from "@/lib/ai";
import { transcriptToText, type Segment } from "@/lib/lalela";
import type { ResponseLength } from "@/lib/settings";

/** Cap on the transcript injected into the prompt — matches the meeting-context
 * cap used by chat and web summaries (24k chars), so small local models keep
 * headroom for the notes + output. */
const TRANSCRIPT_CAP = 24000;

/** The enhancement instruction. The shape is Granola-like AND condensing: each
 * user note line is a verbatim top-level bullet (the ONLY source of anchors —
 * transcript dialogue is never an anchor and speaker prefixes never appear);
 * beneath it come a FEW SYNTHESISED sub-bullets that distill only the
 * substantive supporting points — in the AI's own concise words, each cited
 * [m:ss]. Selectivity + a hard length budget keep the output far shorter than
 * the transcript. A GOOD/BAD example few-shots the anti-replay failure mode. */
export const ENHANCE_NOTES_SYSTEM =
  "You are Lalela's note-enhancer. You are given the user's ROUGH NOTES and the " +
  "meeting TRANSCRIPT. Produce ONE enhanced, Markdown version of the NOTES that " +
  "keeps the user's structure and CONDENSES the meeting into it. You are " +
  "distilling — the output MUST be substantially SHORTER than the transcript, " +
  "never a replay of it.\n\n" +
  "WHAT IS WHAT (read carefully):\n" +
  "- The ROUGH NOTES block is the ONLY source of the user's lines. Every " +
  "top-level bullet is one of the user's own note lines, reproduced VERBATIM " +
  "and in order. If the notes are a single line, the output has EXACTLY ONE " +
  "top-level bullet.\n" +
  "- The TRANSCRIPT is REFERENCE ONLY. It is raw dialogue labelled " +
  "`[m:ss] Speaker:`. NEVER turn a transcript line into a top-level bullet, " +
  "NEVER reproduce dialogue, and NEVER write a speaker prefix — the strings " +
  "'Me:', 'Others:' and 'Speaker' must NOT appear anywhere in your output.\n\n" +
  "HOW TO ENHANCE:\n" +
  "1. Turn each user note line into a TOP-LEVEL bullet, verbatim, in order — the " +
  "anchors. They get NO citation.\n" +
  "2. Under each, add 0–4 INDENTED sub-bullets that DISTILL, in your OWN concise " +
  "words, only the SUBSTANTIVE points from the transcript that support, explain " +
  "or complete THAT note: decisions, action items, facts, numbers, names, " +
  "commitments and real open questions. Synthesise — never quote or lightly " +
  "reword a transcript sentence. A note may warrant NO sub-bullets.\n" +
  "3. BE SELECTIVE — this is the point. SKIP filler, acknowledgements, reactions " +
  "and chit-chat ('Wow', 'Hmm', 'sounds good', 'super easy', pleasantries). If a " +
  "point wouldn't matter next week, leave it out.\n" +
  "4. END every sub-bullet (and every bullet under 'Also discussed') with its " +
  "transcript citation [m:ss] — the moment that point is drawn from.\n" +
  "5. After the notes, add a `**Also discussed**` section ONLY for genuinely " +
  "important points that fit under no note (max ~6 bullets, same synthesis + " +
  "citation rules). Omit it entirely if nothing is that important.\n" +
  "6. LENGTH BUDGET: at most ~10–15 bullets TOTAL for a typical meeting; a short " +
  "or trivial recording warrants only 3–6. When in doubt, cut.\n" +
  "7. Never invent anything not in the transcript. Output Markdown only — no " +
  "preamble, no headings other than 'Also discussed', no closing remarks. Start " +
  "directly with the first user bullet.\n\n" +
  "EXAMPLE — the user's notes are the single line 'I am testing and want feedback':\n" +
  "GOOD (one anchor, a couple of distilled, substantive points):\n" +
  "- I am testing and want feedback\n" +
  "  - Recording quality judged good; transcription ran on-device with no setup [0:25]\n" +
  "  - Agreed to capture a follow-up recording to compare accuracy [3:10]\n" +
  "BAD (NEVER do this — utterance-by-utterance replay with speaker prefixes, longer than the transcript):\n" +
  "- Me: Wow.\n" +
  "  - Satisfied with the recording quality. [0:25]\n" +
  "- Others: It was super easy.\n" +
  "  - Found the setup simple. [0:31]";

/** Assemble the two-part user message. The framing hammers the roles home: the
 * NOTES are the only anchors; the TRANSCRIPT is reference material to mine and
 * distill, never to copy (its speaker labels must not leak into the output). */
export function buildEnhanceInput(notes: string, segments: Segment[]): string {
  const transcript = transcriptToText(segments).slice(0, TRANSCRIPT_CAP);
  return (
    "=== ROUGH NOTES — the ONLY source of top-level bullets. Reproduce each " +
    `line verbatim as an anchor, in order. ===\n${notes.trim()}\n\n` +
    "=== TRANSCRIPT — REFERENCE ONLY. Raw dialogue with [m:ss] Speaker: labels. " +
    "Mine it for substance to distill under the notes; never copy its lines, its " +
    `speakers, or its 'Me:'/'Others:' labels into the output. ===\n${transcript}`
  );
}

/** Run the enhancement through the one AI front door. `projectId` routes the
 * rolling project brief into the prompt (Slice 3); `length` caps the output
 * (Wave A1). Returns the polished Markdown. */
export function enhanceNotes(
  notes: string,
  segments: Segment[],
  model: string,
  opts: { projectId?: string | null; length?: ResponseLength; interactive?: boolean },
): Promise<string> {
  return aiGenerate(buildEnhanceInput(notes, segments), ENHANCE_NOTES_SYSTEM, model, opts);
}
