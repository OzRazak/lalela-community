// Auto-sort into folders — the PURE half (no Tauri, no React, no imports), so
// `node --test` can run it straight off the .ts file (see autoSortCore.test.ts).
//
//   buildClassifyPrompt  → the per-meeting prompt (bounded transcript sample)
//   parseClassifyOutput  → strict JSON validation of the model's reply
//   routeDecision        → auto-file vs the "To sort" review queue
//   clusterTitles / buildDiscoveryPrompt / parseDiscoveryOutput → first-run
//                           folder proposals
//   estimateRun          → token / cost / time estimate before a batch
//
// The impure runner (AI front door, SQLite ledger, progress store) lives in
// autoSort.ts.

/** A folder the classifier may choose — an approved existing project. */
export interface SortFolder {
  id: string;
  /** Display path, e.g. "PPS / Pricing engine" for a nested folder. */
  name: string;
  /** Optional one-line description from folder setup ("what goes here"). */
  hint?: string;
}

export interface ClassifyInput {
  title: string;
  /** ISO date (yyyy-mm-dd is enough). */
  date: string;
  /** Calendar attendees + transcript speaker labels (deduped by the caller). */
  people: string[];
  summary: string;
  /** Transcript lines, already rendered "Speaker: text". */
  lines: string[];
}

export interface ClassifyResult {
  /** The chosen folder's id, or null when nothing fits. */
  folderId: string | null;
  confidence: number;
  titleMismatch: boolean;
  reason: string;
  suggestedNewFolder?: string;
}

export const CHARS_PER_TOKEN = 4;
/** Transcript sample budget (~2.5k tokens) split across beginning/middle/end. */
export const SAMPLE_TOKENS = 2500;
/** Summary budget on top of the sample (~300 tokens). */
export const SUMMARY_CHARS = 1200;
export const DEFAULT_THRESHOLD = 0.8;

/** Take the beginning, middle and end of a transcript within `maxChars`
 * (a third each), joined by "[…]" markers. Short transcripts pass whole. */
export function sampleTranscript(lines: string[], maxChars = SAMPLE_TOKENS * CHARS_PER_TOKEN): string {
  const all = lines.join("\n");
  if (all.length <= maxChars) return all;
  const part = Math.floor(maxChars / 3);
  const take = (from: number): string => {
    const out: string[] = [];
    let used = 0;
    for (let i = from; i < lines.length; i++) {
      const l = lines[i];
      if (used + l.length + 1 > part) {
        if (out.length === 0) out.push(l.slice(0, part)); // one huge line
        break;
      }
      out.push(l);
      used += l.length + 1;
    }
    return out.join("\n");
  };
  // Index of the line where the middle third should start / the end third.
  let total = 0;
  const offsets = lines.map((l) => {
    const o = total;
    total += l.length + 1;
    return o;
  });
  const idxAt = (charPos: number) => {
    const i = offsets.findIndex((o) => o >= charPos);
    return i < 0 ? lines.length - 1 : i;
  };
  const head = take(0);
  const mid = take(idxAt(total / 2 - part / 2));
  const tail = take(idxAt(Math.max(0, total - part)));
  return [head, mid, tail].join("\n[…]\n");
}

const CLASSIFY_SYSTEM = `You file meeting transcripts into the user's folders.
Pick the ONE folder this meeting belongs in, judged mainly by WHAT IS DISCUSSED.
The title is a hint but is sometimes wrong (recorded under the wrong name): when the content clearly belongs elsewhere, follow the content and set "titleMismatch": true.
If no folder fits, set "folder": null and propose a short "suggestedNewFolder" name.
Confidence is your honest probability (0 to 1) that the folder is right — use < 0.6 when unsure.
Reply with ONLY one JSON object, no prose, no markdown fences:
{"folder": "<exact folder name from the list, or null>", "confidence": 0.0, "titleMismatch": false, "reason": "<= 20 words", "suggestedNewFolder": "<only when folder is null>"}`;

export function buildClassifyPrompt(
  input: ClassifyInput,
  folders: SortFolder[],
): { system: string; user: string } {
  const folderList = folders
    .map((f) => `- ${f.name}${f.hint ? ` — ${f.hint}` : ""}`)
    .join("\n");
  const summary = input.summary.trim().slice(0, SUMMARY_CHARS);
  const people = input.people.filter(Boolean).slice(0, 12).join(", ");
  const user = [
    `FOLDERS:\n${folderList || "(none yet)"}`,
    `MEETING TITLE: ${input.title || "(untitled)"}`,
    `DATE: ${input.date}`,
    people ? `PEOPLE: ${people}` : "",
    summary ? `SUMMARY:\n${summary}` : "",
    `TRANSCRIPT SAMPLE (beginning / middle / end):\n${sampleTranscript(input.lines) || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: CLASSIFY_SYSTEM, user };
}

export class ClassifyParseError extends Error {}

/** Pull the first JSON object out of a model reply (tolerates ``` fences and
 * leading/trailing chatter that small local models add despite instructions). */
export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  if (start < 0) throw new ClassifyParseError("no JSON object in reply");
  // Walk to the matching brace (string-aware) so trailing prose is ignored.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          throw new ClassifyParseError("reply JSON does not parse");
        }
      }
    }
  }
  throw new ClassifyParseError("unterminated JSON object in reply");
}

/** Normalise a folder name for matching: case, dashes/em-dashes, slashes, spaces. */
export function normFolder(s: string): string {
  return s
    .toLowerCase()
    .replace(/[—–\-/|:·]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve the model's folder string to a folder id (exact name, normalised
 * name, the id itself, or the LAST path segment of a nested folder). */
export function matchFolder(value: string, folders: SortFolder[]): string | null {
  const v = value.trim();
  if (!v) return null;
  const byId = folders.find((f) => f.id === v);
  if (byId) return byId.id;
  const n = normFolder(v);
  const exact = folders.find((f) => normFolder(f.name) === n);
  if (exact) return exact.id;
  const leaf = folders.filter((f) => normFolder(f.name.split(" / ").pop() ?? "") === n);
  return leaf.length === 1 ? leaf[0].id : null;
}

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Validate a classifier reply. Throws ClassifyParseError on anything that is
 * not the documented shape; an unknown folder name becomes folderId null (and
 * is kept as the suggested new folder so the review queue can offer it). */
export function parseClassifyOutput(raw: string, folders: SortFolder[]): ClassifyResult {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ClassifyParseError("reply is not a JSON object");
  }
  const o = obj as Record<string, unknown>;
  const folderRaw = o.folder;
  if (folderRaw !== null && folderRaw !== undefined && typeof folderRaw !== "string") {
    throw new ClassifyParseError("folder must be a string or null");
  }
  const confRaw = typeof o.confidence === "string" ? Number(o.confidence) : o.confidence;
  if (typeof confRaw !== "number" || !Number.isFinite(confRaw)) {
    throw new ClassifyParseError("confidence must be a number");
  }
  // Some models answer in percent ("85"); a slight overshoot ("1.2") clamps.
  let confidence = confRaw >= 2 && confRaw <= 100 ? confRaw / 100 : confRaw;
  confidence = Math.min(1, Math.max(0, confidence));
  const mm = o.titleMismatch;
  if (mm !== undefined && typeof mm !== "boolean") {
    throw new ClassifyParseError("titleMismatch must be a boolean");
  }
  const reasonRaw = typeof o.reason === "string" ? o.reason.trim() : "";
  const reason =
    words(reasonRaw) > 20 ? reasonRaw.split(/\s+/).slice(0, 20).join(" ") + "…" : reasonRaw;

  const folderStr = typeof folderRaw === "string" ? folderRaw.trim() : "";
  const isNull = !folderStr || /^(null|none|n\/a)$/i.test(folderStr);
  const folderId = isNull ? null : matchFolder(folderStr, folders);
  let suggested =
    typeof o.suggestedNewFolder === "string" && o.suggestedNewFolder.trim()
      ? o.suggestedNewFolder.trim().slice(0, 60)
      : undefined;
  // The model named a folder that isn't on the list: treat it as a suggestion.
  if (!isNull && folderId === null && !suggested) suggested = folderStr.slice(0, 60);
  return {
    folderId,
    confidence,
    titleMismatch: mm === true,
    reason,
    ...(suggested && folderId === null ? { suggestedNewFolder: suggested } : {}),
  };
}

export type SortRoute = "auto" | "review";

/** Auto-file only a confident, title-consistent match to an existing folder;
 * everything else goes to the "To sort" queue. */
export function routeDecision(
  r: ClassifyResult,
  threshold: number = DEFAULT_THRESHOLD,
): { route: SortRoute; why: "ok" | "no-folder" | "title-mismatch" | "low-confidence" } {
  if (r.folderId === null) return { route: "review", why: "no-folder" };
  if (r.titleMismatch) return { route: "review", why: "title-mismatch" };
  if (r.confidence < threshold) return { route: "review", why: "low-confidence" };
  return { route: "auto", why: "ok" };
}

// ── Folder discovery (first run) ─────────────────────────────────────────

const STOP = new Set(
  (
    "a an and the of for to with in on at by from vs x re fw fwd my our your " +
    "meeting meetings call calls sync catch up catchup check checkin chat session sessions " +
    "weekly daily monthly quarterly biweekly review update updates discussion intro " +
    "notes recording recorded untitled new team internal external follow followup " +
    "mon tue wed thu fri sat sun monday tuesday wednesday thursday friday " +
    "jan feb mar apr may jun jul aug sep sept oct nov dec am pm teams zoom otter"
  ).split(" "),
);

export interface TitleCluster {
  term: string;
  count: number;
  examples: string[];
}

/** Deterministic title signals: frequent significant words (and adjacent
 * word pairs) across meeting titles, with a few example titles each. Feeds the
 * discovery prompt and is the no-AI fallback proposal list. */
export function clusterTitles(titles: string[], minCount = 3, max = 40): TitleCluster[] {
  const map = new Map<string, { count: number; examples: string[] }>();
  for (const t of titles) {
    const toks = t
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
    const seen = new Set<string>();
    for (let i = 0; i < toks.length; i++) {
      seen.add(toks[i]);
      if (i + 1 < toks.length) seen.add(`${toks[i]} ${toks[i + 1]}`);
    }
    for (const k of seen) {
      const e = map.get(k) ?? { count: 0, examples: [] };
      e.count++;
      if (e.examples.length < 3) e.examples.push(t);
      map.set(k, e);
    }
  }
  const out = [...map.entries()]
    .filter(([, v]) => v.count >= minCount)
    .map(([term, v]) => ({ term, count: v.count, examples: v.examples }))
    // Prefer bigrams when they carry (almost) all of a unigram's weight.
    .sort((a, b) => b.count - a.count || b.term.length - a.term.length);
  const kept: TitleCluster[] = [];
  for (const c of out) {
    if (!c.term.includes(" ")) {
      const pair = kept.find((k) => k.term.includes(" ") && k.term.split(" ").includes(c.term));
      if (pair && pair.count >= c.count * 0.8) continue;
    }
    kept.push(c);
    if (kept.length >= max) break;
  }
  return kept;
}

export interface ProposedFolder {
  name: string;
  hint: string;
  /** Id of an existing folder this proposal IS (reuse, never duplicate). */
  existingId?: string;
}

const DISCOVERY_SYSTEM = `You design a folder structure for someone's meeting library so they can browse past meetings by topic.
Propose 5–30 folders. Reuse the EXISTING folders where they fit (same name). Make folders specific and recurring — e.g. "Coaching — Michelle", "PPS — Pricing engine" — not one-offs. Avoid catch-alls like "Misc" or "Meetings".
Reply with ONLY one JSON object, no prose, no fences:
{"folders": [{"name": "<folder name>", "hint": "<what belongs here, <= 15 words>"}]}`;

/** Discovery prompt over existing folders, title clusters and a content sample. */
export function buildDiscoveryPrompt(
  existing: string[],
  clusters: TitleCluster[],
  samples: { title: string; snippet: string }[],
  maxChars = 16000,
): { system: string; user: string } {
  const parts = [
    `EXISTING FOLDERS:\n${existing.length ? existing.map((e) => `- ${e}`).join("\n") : "(none)"}`,
    `FREQUENT TITLE TERMS (term ×count: example titles):\n${clusters
      .map((c) => `- ${c.term} ×${c.count}: ${c.examples.join(" | ")}`)
      .join("\n")}`,
  ];
  let user = parts.join("\n\n");
  const sampleLines: string[] = [];
  for (const s of samples) {
    const line = `- ${s.title}: ${s.snippet.replace(/\s+/g, " ").slice(0, 220)}`;
    if (user.length + sampleLines.join("\n").length + line.length + 40 > maxChars) break;
    sampleLines.push(line);
  }
  if (sampleLines.length) user += `\n\nSAMPLE MEETINGS (title: content):\n${sampleLines.join("\n")}`;
  return { system: DISCOVERY_SYSTEM, user };
}

/** Parse the discovery reply into proposals, de-duplicated and linked to
 * existing folders by normalised name. Throws ClassifyParseError when invalid. */
export function parseDiscoveryOutput(
  raw: string,
  existing: { id: string; name: string }[],
): ProposedFolder[] {
  const obj = extractJsonObject(raw) as { folders?: unknown };
  if (!obj || !Array.isArray(obj.folders)) throw new ClassifyParseError("folders must be an array");
  const out: ProposedFolder[] = [];
  const seen = new Set<string>();
  for (const f of obj.folders) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 60) : "";
    if (!name) continue;
    const key = normFolder(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const match = existing.find((e) => normFolder(e.name) === key);
    out.push({
      name: match ? match.name : name,
      hint: typeof rec.hint === "string" ? rec.hint.trim().slice(0, 140) : "",
      ...(match ? { existingId: match.id } : {}),
    });
  }
  if (out.length === 0) throw new ClassifyParseError("no usable folders in reply");
  return out;
}

/** Merge proposals: `from` folds into `into` (hints joined). Pure helper for
 * the approval screen. */
export function mergeProposals(list: ProposedFolder[], from: number, into: number): ProposedFolder[] {
  if (from === into || !list[from] || !list[into]) return list;
  const target = list[into];
  const src = list[from];
  const hint = [target.hint, src.hint].filter(Boolean).join("; ").slice(0, 200);
  const merged: ProposedFolder = {
    ...target,
    hint,
    existingId: target.existingId ?? src.existingId,
  };
  return list.map((p, i) => (i === into ? merged : p)).filter((_, i) => i !== from);
}

// ── Cost / time estimate ─────────────────────────────────────────────────

/** Approx. OpenRouter USD per million tokens [input, output] (2026-09). Rough
 * on purpose — the UI labels it an estimate. Unknown cloud model → null. */
export const PRICE_PER_MTOK: Record<string, [number, number]> = {
  // Haiku 5.5: $0.10/$0.50 for prompts <=100k tokens ($0.50/$2.50 above); its
  // tokenizer counts ~30% more tokens than 4.5. Keep the 4.5 row for legacy picks.
  "anthropic/claude-haiku-5.5": [0.1, 0.5],
  "anthropic/claude-haiku-4.5": [1, 5],
  "openai/gpt-4o-mini": [0.15, 0.6],
  "google/gemini-2.5-flash": [0.3, 2.5],
  "anthropic/claude-sonnet-5.5": [2, 10],
  "anthropic/claude-sonnet-5": [2, 10], // legacy pick, mapped to 5.5 on read
  "google/gemini-2.5-pro": [1.25, 10],
  "openai/gpt-5.1": [1.25, 10],
  "anthropic/claude-opus-5.5": [4, 20],
};

/** Per-meeting tokens: sample + summary + folder list + instructions + the
 * workspace card the front door injects (~1k) — and ~80 tokens out. */
export function tokensPerMeeting(folderCount: number): { input: number; output: number } {
  const input =
    SAMPLE_TOKENS + SUMMARY_CHARS / CHARS_PER_TOKEN + folderCount * 20 + 250 + 1000;
  return { input: Math.round(input), output: 80 };
}

export interface RunEstimate {
  meetings: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when free (local/Apple) or the price is unknown. */
  usd: number | null;
  /** Seconds at the given per-call time (incl. throttle). */
  seconds: number;
}

export function estimateRun(
  meetings: number,
  folderCount: number,
  model: string,
  route: "local" | "apple" | "byok" | "free" | "none",
  secondsPerCall: number,
): RunEstimate {
  const per = tokensPerMeeting(folderCount);
  const inputTokens = per.input * meetings;
  const outputTokens = per.output * meetings;
  const price = PRICE_PER_MTOK[model];
  const paid = route === "byok" || route === "free";
  const usd =
    paid && price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : null;
  return { meetings, inputTokens, outputTokens, usd, seconds: meetings * secondsPerCall };
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}


// ── Concurrency guards (used by autoSort.ts; pure so they're unit-tested) ──

/** Per-key serial queue: calls for the same key run one after another, in
 * call order; different keys don't wait on each other. Used to serialise the
 * cloud folder writes for one meeting. */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

/** Should a queued cloud folder write still go out? Only if the meeting's
 * LOCAL folder is still the value being written — otherwise a later local
 * choice (hand move, undo) has superseded it and owns the cloud write.
 * `localNow === undefined` = the meeting no longer exists locally. */
export function planFolderPush(
  value: string | null,
  localNow: string | null | undefined,
): "write" | "skip" {
  if (localNow === undefined) return "skip";
  return localNow === value ? "write" : "skip";
}

/** Single-flight: the first call claims the slot SYNCHRONOUSLY (before any
 * await), so a double-click can't start two runs; concurrent calls get the
 * in-flight promise. The slot frees when the run settles. */
export function createSingleFlight() {
  let inFlight: Promise<void> | null = null;
  return {
    run(fn: () => Promise<void>): Promise<void> {
      if (inFlight) return inFlight;
      const p: Promise<void> = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (inFlight === p) inFlight = null;
        });
      inFlight = p;
      return p;
    },
    busy(): boolean {
      return inFlight !== null;
    },
  };
}

/** Run `critical` on the per-key queue, then `after` OUTSIDE it: the queue
 * slot frees as soon as `critical` settles, so slow follow-up work (image /
 * notes upload) never blocks later queued writes for the same key. Resolves
 * once both are done; a `critical` failure skips `after` and rejects. */
export async function queuedThen<T>(
  queue: <R>(key: string, fn: () => Promise<R>) => Promise<R>,
  key: string,
  critical: () => Promise<T>,
  after: () => Promise<void>,
): Promise<T> {
  const r = await queue(key, critical);
  await after();
  return r;
}
