// Pure, dependency-free core of "Report AI content" (Microsoft Store policy
// 11.16 / Apple generative-AI review): the categories, the closed lists, the
// payload builder, the server-side validator and the mailto fallback.
//
// Kept import-free so it runs under plain `node --test`. The web app carries a
// byte-identical copy at apps/web/lib/aiReportCore.ts (the /api/ai/report route
// validates with it) — keep the two in lockstep (parity rule, DECISIONS
// 2026-07-06).
//
// Privacy contract: a report carries the category, an optional comment, which
// surface it came from, the model id / route, app version and platform — plus
// the AI output text ONLY when the user leaves "Include the AI output" ticked,
// capped at AI_REPORT_OUTPUT_CAP. Never audio, transcripts or voiceprints.

/** Where reports go when the network path fails (also the FAQ contact). */
export const AI_REPORT_SUPPORT_EMAIL = "hello@auxo.digital";

/** Max characters of AI output a report may carry. */
export const AI_REPORT_OUTPUT_CAP = 8000;
/** Max characters of the user's own comment. */
export const AI_REPORT_COMMENT_CAP = 2000;
/** Output characters that fit in a mailto: body (URL length limits). */
export const AI_REPORT_MAILTO_OUTPUT_CAP = 1500;

export const AI_REPORT_CATEGORIES = [
  { id: "harmful", label: "Harmful or offensive" },
  { id: "inaccurate", label: "Inaccurate or misleading" },
  { id: "sexual", label: "Sexual content" },
  { id: "hate", label: "Hate or harassment" },
  { id: "privacy", label: "Privacy concern" },
  { id: "other", label: "Other" },
] as const;
export type AiReportCategory = (typeof AI_REPORT_CATEGORIES)[number]["id"];

/** Every surface that can raise a report (closed list — also an analytics prop). */
export const AI_REPORT_SURFACES = [
  "summary",
  "enhanced_notes",
  "chat",
  "copilot",
  "workflow",
  "automation",
  "auto_sort",
  "report",
  "knowledge",
  "dossier",
  "tasks",
  "import",
  "general",
] as const;
export type AiReportSurface = (typeof AI_REPORT_SURFACES)[number];

export const AI_REPORT_ROUTES = ["local", "apple", "byok", "free", "none", "unknown"] as const;
export type AiReportRoute = (typeof AI_REPORT_ROUTES)[number];

export const AI_REPORT_PLATFORMS = ["macos", "windows", "ios", "android", "linux", "web", "other"] as const;
export type AiReportPlatform = (typeof AI_REPORT_PLATFORMS)[number];

export const AI_REPORT_CLIENTS = ["desktop", "web"] as const;
export type AiReportClient = (typeof AI_REPORT_CLIENTS)[number];

/** What the dialog collects + what the caller knows about the output. */
export interface AiReportInput {
  category: AiReportCategory;
  comment?: string;
  surface: AiReportSurface;
  includeOutput: boolean;
  output?: string | null;
  model?: string | null;
  route?: string | null;
  appVersion?: string | null;
  platform: AiReportPlatform;
  client: AiReportClient;
}

/** The wire shape POSTed to /api/ai/report (no user id: the server derives it
 * from the bearer token, never trusts the body). */
export interface AiReportPayload {
  category: AiReportCategory;
  comment: string | null;
  surface: AiReportSurface;
  output: string | null;
  output_included: boolean;
  output_truncated: boolean;
  model: string | null;
  ai_route: AiReportRoute;
  app_version: string | null;
  platform: AiReportPlatform;
  client: AiReportClient;
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** Replace lone UTF-16 surrogates with U+FFFD so text is always valid Unicode
 * (encodeURIComponent throws URIError on a lone surrogate). */
export function wellFormed(s: string): string {
  // No lookbehind: WKWebView before iOS 16.4 can't parse it (app targets iOS 15).
  return s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) =>
    m.length === 2 ? m : "\uFFFD",
  );
}

/** Cap at `cap` UTF-16 units without splitting a surrogate pair (an emoji
 * straddling the boundary is dropped whole, never halved). */
export function clip(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  let end = cap;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: s.slice(0, end), truncated: true };
}

/** Short free-text field (model id, version): trimmed, bounded, printable. */
function shortField(v: unknown, cap: number): string | null {
  if (typeof v !== "string") return null;
  const t = clip(wellFormed(v).replace(/[\u0000-\u001f\u007f]/g, "").trim(), cap).text;
  return t ? t : null;
}

export function normalizeRoute(route: unknown): AiReportRoute {
  return has(AI_REPORT_ROUTES, route) ? route : "unknown";
}

/** Build the payload the client sends. Drops the output unless opted in. */
export function buildAiReportPayload(input: AiReportInput): AiReportPayload {
  const comment = wellFormed(input.comment ?? "").trim();
  const rawOutput = input.includeOutput ? wellFormed(input.output ?? "").trim() : "";
  const out = clip(rawOutput, AI_REPORT_OUTPUT_CAP);
  return {
    category: input.category,
    comment: comment ? clip(comment, AI_REPORT_COMMENT_CAP).text : null,
    surface: input.surface,
    output: out.text ? out.text : null,
    output_included: Boolean(out.text),
    output_truncated: out.truncated,
    model: shortField(input.model, 120),
    ai_route: normalizeRoute(input.route),
    app_version: shortField(input.appVersion, 40),
    platform: input.platform,
    client: input.client,
  };
}

export type AiReportValidation = { ok: true; value: AiReportPayload } | { ok: false; error: string };

/** Server-side validation of an untrusted body. Rejects unknown enums and
 * oversize text (instead of silently truncating someone else's payload). */
export function validateAiReportPayload(body: unknown): AiReportValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Bad request." };
  const b = body as Record<string, unknown>;
  if (!has(AI_REPORT_CATEGORIES.map((c) => c.id), b.category)) return { ok: false, error: "Unknown category." };
  if (!has(AI_REPORT_SURFACES, b.surface)) return { ok: false, error: "Unknown surface." };
  if (!has(AI_REPORT_PLATFORMS, b.platform)) return { ok: false, error: "Unknown platform." };
  if (!has(AI_REPORT_CLIENTS, b.client)) return { ok: false, error: "Unknown client." };
  if (b.comment != null && typeof b.comment !== "string") return { ok: false, error: "Bad comment." };
  if (b.output != null && typeof b.output !== "string") return { ok: false, error: "Bad output." };
  const comment = typeof b.comment === "string" ? wellFormed(b.comment).trim() : "";
  const output = typeof b.output === "string" ? wellFormed(b.output).trim() : "";
  if (comment.length > AI_REPORT_COMMENT_CAP) return { ok: false, error: "Comment is too long." };
  if (output.length > AI_REPORT_OUTPUT_CAP) return { ok: false, error: "Output is too long." };
  return {
    ok: true,
    value: {
      category: b.category as AiReportCategory,
      comment: comment || null,
      surface: b.surface as AiReportSurface,
      output: output || null,
      output_included: Boolean(output),
      output_truncated: output ? b.output_truncated === true : false,
      model: shortField(b.model, 120),
      ai_route: normalizeRoute(b.ai_route),
      app_version: shortField(b.app_version, 40),
      platform: b.platform as AiReportPlatform,
      client: b.client as AiReportClient,
    },
  };
}

export function categoryLabel(id: AiReportCategory): string {
  return AI_REPORT_CATEGORIES.find((c) => c.id === id)?.label ?? "Other";
}

/** A prefilled mailto: link so a report is never lost when the network fails.
 * The output is shortened further to keep the URL within mail-client limits. */
export function buildAiReportMailto(p: AiReportPayload): string {
  const lines = [
    "I'd like to report AI-generated content in Lalela.",
    "",
    `Category: ${categoryLabel(p.category)}`,
    `Where: ${p.surface}`,
    `Model: ${p.model ?? "unknown"} (${p.ai_route})`,
    `App: ${p.client} ${p.app_version ?? ""} on ${p.platform}`.replace(/\s+/g, " ").trim(),
  ];
  if (p.comment) lines.push("", "Comment:", p.comment);
  if (p.output) {
    const o = clip(p.output, AI_REPORT_MAILTO_OUTPUT_CAP);
    lines.push("", "AI output:", o.text + (o.truncated || p.output_truncated ? "\n[…shortened]" : ""));
  }
  const subject = `Lalela AI content report: ${categoryLabel(p.category)}`;
  // Never throws: wellFormed() removes lone surrogates, and the catch is a
  // last resort so the offline fallback always yields a usable link.
  const enc = (t: string) => {
    try {
      return encodeURIComponent(wellFormed(t));
    } catch {
      return encodeURIComponent(t.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
    }
  };
  return `mailto:${AI_REPORT_SUPPORT_EMAIL}?subject=${enc(subject)}&body=${enc(lines.join("\n"))}`;
}

/** Map navigator.userAgent to the closed platform list. */
export function platformFromUserAgent(ua: string, client: AiReportClient): AiReportPlatform {
  if (client === "web") return "web";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}
