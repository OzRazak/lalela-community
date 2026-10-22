// Pure, dependency-free core of Lalela's product analytics (see analytics.ts
// and docs/ANALYTICS.md). Kept import-free so it can be unit-tested with plain
// Node (`node --test src/lib/analyticsCore.test.ts`).
//
// The contract: ONLY the named events below ever leave the app, and each
// carries ONLY the properties listed for it. String properties must match a
// fixed list of values (or a version pattern), so free text — a meeting title,
// a transcript, a file name, a prompt — can never ride along, even by mistake.
// Numbers are counts or buckets; booleans are flags. Anything else is dropped.

/** One allowed property: a closed set of strings, or a primitive kind. */
export type PropSpec = readonly string[] | "boolean" | "count" | "version";

const DURATION = ["<1m", "1-5m", "5-15m", "15-30m", "30-60m", "60m+"] as const;
const COUNT_BUCKET = ["0", "1", "2-5", "6-20", "21-100", "100+"] as const;
const AI_ROUTE = ["local", "apple", "byok", "free", "none"] as const;
const MODEL_FAMILY = [
  "claude",
  "openai",
  "gemini",
  "llama",
  "qwen",
  "mistral",
  "granite",
  "phi",
  "gemma",
  "deepseek",
  "apple",
  "other",
] as const;
const VIEW = ["meetings", "search", "chat", "tasks", "knowledge", "automations", "settings"] as const;
const SEND_DESTINATION = [
  "atlas",
  "atlas_pack",
  "artemis",
  "artemis_lead_flow",
  "arete",
  "other",
] as const;
const IMPORT_CONNECTOR = [
  "audio_file",
  "transcript_file",
  "bulk_folder",
  "teams",
  "otter",
  "fireflies",
  "zoom",
  "google_meet",
  "grain",
  "codex",
  "other",
] as const;
const FILE_FORMAT = ["vtt", "srt", "txt", "md", "docx", "pdf", "json", "html", "csv", "audio", "other"] as const;
const FEATURE = [
  "auto_sort",
  "folder_automations",
  "dictation",
  "atlas_send",
  "copilot",
  "watch",
  "reports",
  "knowledge",
  "people_companies",
  "workflows",
  "voice_memo",
  "command_palette",
  "guide_tour",
] as const;
const FEATURE_ACTION = [
  "opened",
  "used",
  "enabled",
  "disabled",
  "run_started",
  "folders_approved",
  "undone",
  "rule_saved",
  "inserted",
  "cancelled",
] as const;

/** Every event Lalela desktop may send, with its allowed properties. */
export const EVENTS = {
  // Lifecycle
  app_opened: { first_run: "boolean", signed_in: "boolean", updated: "boolean", previous_version: "version" },
  first_launch: {},
  // Account funnel
  signup_prompt_shown: { surface: ["settings_account", "sidebar", "onboarding", "cloud_feature"] },
  account_created: {},
  signed_in: { method: ["password", "signup", "auxo_id"] },
  signed_out: {},
  // Onboarding
  onboarding_started: {},
  onboarding_step: { step: ["mic_settings", "screen_settings"] },
  onboarding_completed: {},
  // Capture
  recording_started: {
    mode: ["meeting", "memo"],
    system_audio: "boolean",
    transcription: ["local", "cloud"],
    engine: ["whisper", "apple", "parakeet", "cloud", "other"],
  },
  recording_stopped: { mode: ["meeting", "memo"], duration: DURATION },
  transcription_completed: {
    engine: ["local", "apple", "cloud"],
    source: ["recording", "import"],
    duration: DURATION,
    success: "boolean",
  },
  first_meeting_captured: { source: ["recording", "import"] },
  meeting_imported: { connector: IMPORT_CONNECTOR, format: FILE_FORMAT, count: COUNT_BUCKET },
  // AI
  summary_generated: { ai_route: AI_ROUTE, model_family: MODEL_FAMILY, success: "boolean", error_kind: ["no_ai", "quota", "abort", "other"] },
  tasks_extracted: { ai_route: AI_ROUTE, count: COUNT_BUCKET },
  chat_message_sent: { with_connections: "boolean", scope: ["meeting", "library"] },
  // Report AI content (Store policy 11.16) — category + surface only, never text.
  // Lists mirror lib/aiReportCore.ts (kept inline: this file stays import-free).
  ai_content_reported: {
    category: ["harmful", "inaccurate", "sexual", "hate", "privacy", "other"],
    surface: [
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
    ],
  },
  // Navigation & search
  nav_view: { view: VIEW },
  search_used: { surface: ["search_view", "command_palette"], results: COUNT_BUCKET },
  // Work
  task_created: { source: ["meeting", "tasks_view"] },
  automation_run: {
    kind: ["tag_rule", "folder_rule"],
    trigger: ["live", "retro", "schedule", "manual"],
    status: ["ok", "done", "empty", "failed", "busy", "skipped"],
    meetings: COUNT_BUCKET,
    executed: COUNT_BUCKET,
    failed: COUNT_BUCKET,
  },
  meeting_exported: { format: ["docx", "pdf", "md", "other"] },
  meeting_sent: { destination: SEND_DESTINATION, trigger: ["manual", "automation"], success: "boolean" },
  share_link_created: { password: "boolean", expires: "boolean" },
  // Health
  sync_outcome: { outcome: ["ok", "denied", "offline", "server"] },
  update_check: { outcome: ["current", "available", "error"] },
  update_installed: {},
  // Discovery of newer features
  feature_used: { feature: FEATURE, action: FEATURE_ACTION },
} as const satisfies Record<string, Record<string, PropSpec>>;

export type EventName = keyof typeof EVENTS;

type PropValue<S> = S extends readonly (infer V)[]
  ? V
  : S extends "boolean"
    ? boolean
    : S extends "count"
      ? number
      : S extends "version"
        ? string
        : never;

/** Typed props for an event: every listed property is optional. */
export type EventProps<E extends EventName> = {
  -readonly [K in keyof (typeof EVENTS)[E]]?: PropValue<(typeof EVENTS)[E][K]>;
};

/** Super properties registered on every usage event (see analytics.ts). */
export const SUPER_PROPS: Readonly<Record<string, PropSpec>> = {
  app: ["lalela-desktop"],
  app_version: "version",
  platform: ["macos", "windows", "ios", "android", "linux", "unknown"],
  arch: ["aarch64", "x86_64", "arm", "x86", "unknown"],
  distribution: ["direct", "store"],
  signed_in: "boolean",
  plan: ["free", "pro", "team", "unknown"],
};

/** PostHog plumbing kept on usage events. No URL, pathname, referrer, screen
 *  size, timezone or person data. */
const PLUMBING = new Set([
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$insert_id",
  "$session_id",
  "$os",
  "$os_version",
  "$browser",
  "$browser_version",
  "$device_type",
]);

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][\w.]{1,20})?$/;

/** Keep one value only if it matches its spec. */
export function cleanValue(spec: PropSpec, v: unknown): unknown {
  if (Array.isArray(spec)) return typeof v === "string" && spec.includes(v) ? v : undefined;
  switch (spec) {
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "count":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
    case "version":
      return typeof v === "string" && VERSION_RE.test(v) ? v : undefined;
  }
  return undefined;
}

/** Cut an event's own properties down to its spec. Unknown events → null. */
export function sanitizeProps(event: string, props: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(EVENTS, event)) return null;
  const spec = EVENTS[event as EventName] as Record<string, PropSpec>;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = cleanValue(s, props?.[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function isUsageEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENTS, name);
}

/** The identity + consent state the router needs. */
export interface RouteState {
  usageOn: boolean;
  crashOn: boolean;
  /** Persistent anonymous id for this install (usage events). */
  installId: string;
  /** Random id for this launch (crash reports — never linked). */
  launchId: string;
  /** Supabase user id when signed in (never email). */
  userId: string | null;
}

/** Minimal shape of a PostHog capture result we touch. */
export interface RoutableEvent {
  event: string;
  properties: Record<string, unknown>;
  $set?: unknown;
  $set_once?: unknown;
  $unset?: unknown;
  [k: string]: unknown;
}

/**
 * Usage-event half of PostHog's `before_send`. Returns null to drop.
 * - named usage events: allowlisted props + super props + plumbing; the
 *   distinct id is the user id when signed in, else the install id.
 * - `$identify`: only while signed in; links installId → userId and may set
 *   ONE person property, `is_internal` (boolean).
 * - everything else (pageviews, autocapture, `$opt_in`, `$set`, …) is dropped
 *   here; `$exception` is handled by errorScrub.ts.
 */
export function routeUsageEvent<T extends RoutableEvent>(ev: T | null, s: RouteState): T | null {
  if (!ev || !s.usageOn) return null;
  const src = ev.properties ?? {};
  if (ev.event === "$identify") {
    if (!s.userId) return null;
    const props: Record<string, unknown> = {};
    for (const k of PLUMBING) if (src[k] !== undefined) props[k] = src[k];
    props.distinct_id = s.userId;
    props.$anon_distinct_id = s.installId;
    const set = (ev.$set ?? src.$set) as Record<string, unknown> | undefined;
    const out: RoutableEvent = { ...ev, properties: props };
    delete out.$set_once;
    delete out.$unset;
    if (set && typeof set.is_internal === "boolean") {
      out.$set = { is_internal: set.is_internal };
      props.$set = { is_internal: set.is_internal };
    } else {
      delete out.$set;
    }
    return out as T;
  }
  const own = sanitizeProps(ev.event, src);
  if (!own) return null;
  const props: Record<string, unknown> = {};
  for (const k of PLUMBING) if (src[k] !== undefined) props[k] = typeof src[k] === "string" ? String(src[k]).slice(0, 100) : src[k];
  for (const [k, spec] of Object.entries(SUPER_PROPS)) {
    const v = cleanValue(spec, src[k]);
    if (v !== undefined) props[k] = v;
  }
  Object.assign(props, own);
  props.distinct_id = s.userId ?? s.installId;
  props.$process_person_profile = s.userId !== null;
  const out: RoutableEvent = { ...ev, properties: props };
  delete out.$set;
  delete out.$set_once;
  delete out.$unset;
  return out as T;
}

// ---- Buckets & mappers (so callers never pass raw numbers/ids) ----

export function durationBucket(ms: number): (typeof DURATION)[number] {
  const m = ms / 60_000;
  if (!(m >= 1)) return "<1m";
  if (m < 5) return "1-5m";
  if (m < 15) return "5-15m";
  if (m < 30) return "15-30m";
  if (m < 60) return "30-60m";
  return "60m+";
}

export function countBucket(n: number): (typeof COUNT_BUCKET)[number] {
  if (!(n > 0)) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  return "100+";
}

/** Coarse model family from a model id — the id itself is never sent. */
export function modelFamily(model: string | null | undefined): (typeof MODEL_FAMILY)[number] {
  const m = (model ?? "").toLowerCase();
  if (/^apple|apple[-_:]/.test(m)) return "apple";
  if (/claude|anthropic/.test(m)) return "claude";
  if (/gpt|openai|\bo[134]\b|o[134]-/.test(m)) return "openai";
  if (/gemini/.test(m)) return "gemini";
  if (/gemma/.test(m)) return "gemma";
  if (/llama/.test(m)) return "llama";
  if (/qwen/.test(m)) return "qwen";
  if (/mistral|mixtral/.test(m)) return "mistral";
  if (/granite/.test(m)) return "granite";
  if (/phi/.test(m)) return "phi";
  if (/deepseek/.test(m)) return "deepseek";
  return "other";
}

/** Imported transcript format → closed list (the file name is never sent). */
export function importFormat(format: string | null | undefined): (typeof FILE_FORMAT)[number] {
  const f = (format ?? "").toLowerCase().replace(/^\./, "");
  return (FILE_FORMAT as readonly string[]).includes(f) ? (f as (typeof FILE_FORMAT)[number]) : "other";
}

/** Error class → coarse kind for failed generations. */
export function aiErrorKind(e: unknown): "no_ai" | "quota" | "abort" | "other" {
  const name = e instanceof Error ? e.name : "";
  if (name === "NoAiError") return "no_ai";
  if (name === "QuotaError") return "quota";
  if (name === "AbortError") return "abort";
  return "other";
}

/** Team accounts are flagged so dashboards can filter them out. Only the
 *  boolean leaves the app — never the email. */
export function isInternalEmail(email: string | null | undefined): boolean {
  return /@(auxo\.digital|auxodigital\.africa)$/i.test((email ?? "").trim());
}

/** A random id (crypto when available). */
export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
