// WebVTT parser for meeting transcripts (Teams/Zoom).
//
// KEEP IN SYNC with apps/web/lib/connectors/vtt.ts — this is a port of the
// web connector's parser (same `<v Speaker>` voice-tag handling, same
// same-speaker merge) so desktop-direct and web-connector Teams imports
// produce equivalent segments. One deliberate fix over the web copy: the cue
// START time is taken from the first timestamp token (the web version's
// `split(" ")[1]` always read an empty string for t0 — worth backporting).

import type { Segment } from "@/lib/lalela";

function tsToMs(ts: string): number {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return 0;
  const [, h, min, s, frac] = m;
  return (
    (Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s)) * 1000 +
    Number((frac ?? "0").padEnd(3, "0"))
  );
}

export function parseVtt(vtt: string): Segment[] {
  const segments: Segment[] = [];
  let lastSpeaker = "Speaker";
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const cueIdx = lines.findIndex((l) => l.includes("-->"));
    if (cueIdx === -1) continue;
    // "00:00:03.600 --> 00:00:07.220 align:start" → first token of each side.
    const [t0, t1] = lines[cueIdx]
      .split("-->")
      .map((p) => tsToMs(p.trim().split(/\s+/)[0] ?? ""));
    const textLines = lines.slice(cueIdx + 1);
    if (textLines.length === 0) continue;
    const raw = textLines.join(" ").trim();
    const voice = raw.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
    const speaker = voice ? voice[1].trim() : lastSpeaker;
    const text = (voice ? voice[2] : raw).replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    lastSpeaker = speaker;
    const prev = segments[segments.length - 1];
    // Merge consecutive cues from the same speaker into readable segments.
    if (prev && prev.speaker === speaker && t0 - prev.t1_ms < 3000) {
      prev.text = `${prev.text} ${text}`;
      prev.t1_ms = t1;
    } else {
      segments.push({ t0_ms: t0, t1_ms: t1, text, speaker });
    }
  }
  return segments;
}
