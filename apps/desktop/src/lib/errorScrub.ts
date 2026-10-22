// Pure, dependency-free scrubbing for the opt-in error reporter
// (see errorReporting.ts). Kept import-free so it can be unit-tested with
// plain Node (`node --test scripts/errorScrub.test.mts`).
//
// Goal: an error report may carry the error TYPE, a scrubbed MESSAGE, stack
// frames (code locations), and the app version / platform / arch — and nothing
// else. Meeting content (titles, names, transcripts, notes, file names under a
// user's save folder) must never survive. We err on the side of over-redaction.

/** Longest message we send, after scrubbing. */
export const MAX_MESSAGE_LEN = 500;
/** Most stack frames we send per exception. */
export const MAX_FRAMES = 50;

/** Event properties allowed through. Everything else is dropped — including
 *  URLs/pathnames (the webview route can carry meeting ids), referrers,
 *  session/window ids, and any `$set` person data. */
export const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  // PostHog plumbing needed to ingest an exception.
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$insert_id",
  "$process_person_profile",
  "$exception_list",
  "$exception_level",
  // Coarse environment (no identifiers).
  "$os",
  "$os_version",
  "$browser",
  "$browser_version",
  "$device_type",
  // Our own tags.
  "app",
  "app_version",
  "platform",
  "arch",
  "source",
  "ai_route",
]);

// Basenames that are safe to keep when a path is redacted: code files (so a
// stack location still reads `recording.rs`), model weights, and Lalela's own
// fixed file names. Anything else — a user-named folder or file — goes.
const SAFE_BASENAME =
  /^(?:[\w.-]+\.(?:rs|ts|tsx|js|mjs|cjs|jsx|swift|m|mm|c|cc|cpp|h|kt|java|gguf|ggml|bin|onnx|mlmodelc)|summary\.md|transcript\.md|notes\.md|lalela\.db|crash\.log(?:\.1)?|lalela-llm\.log|sysaudio\.log)$/i;

const URL_RE = /\b(?:https?|tauri|asset|ipc|file):\/\/[^\s'"`<>)]+/gi;
// An absolute path: POSIX (/a/b), home-relative (~/a), Windows (C:\a or C:/a)
// or UNC (\\host\share). Must be preceded by start/space/quote/bracket/'=' so
// ordinary words like "and/or" are left alone. Segments may contain spaces
// (meeting folders often do) — a greedy match only ever over-redacts.
const PATH_RE =
  /(^|[\s'"`(\[=])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)(?:[^\\/\n\r'"`<>|]*[\\/])+[^\\/\n\r'"`<>|:,;()\]]*)/g;
const HOME_RE = /(\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\\/\s'"`]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// API-key-ish tokens (OpenRouter sk-or-…, JWTs, long hex/base64 runs).
const SECRET_RE = /\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{40,})\b/g;
// Rust panics quote the offending string in backticks (e.g. "byte index 5 is
// not a char boundary … of `<transcript text>`") — never send quoted content.
const BACKTICK_RE = /`[^`]*`/g;
// Long double/single-quoted literals are likely user content.
const QUOTED_RE = /"[^"\n]{24,}"|'[^'\n]{24,}'/g;

function redactPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  // Keep a trailing ":line[:col]" location on a code file.
  const m = base.match(/^(.*?)((?::\d+){1,2})?$/);
  const name = m?.[1] ?? base;
  const loc = m?.[2] ?? "";
  return SAFE_BASENAME.test(name) ? `<path>/${name}${loc}` : "<path>";
}

function scrubUrl(u: string): string {
  if (/^file:/i.test(u)) return "<path>";
  // Drop query + fragment (tokens, ids); keep origin + path for source maps.
  return u.replace(/[?#].*$/, "");
}

/** Scrub free text (an error message, a panic line, a frame filename). */
export function scrubText(input: unknown, max = MAX_MESSAGE_LEN): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  s = s.replace(BACKTICK_RE, "`<redacted>`");
  s = s.replace(QUOTED_RE, (q) => `${q[0]}<redacted>${q[0]}`);
  // Protect URLs from the path pass, scrubbing them separately.
  const urls: string[] = [];
  s = s.replace(URL_RE, (u) => {
    urls.push(scrubUrl(u));
    return `\u0000${urls.length - 1}\u0000`;
  });
  s = s.replace(PATH_RE, (_m, pre: string, path: string) => {
    const trailing = path.match(/\s*$/)?.[0] ?? "";
    return pre + redactPath(path.trimEnd()) + trailing;
  });
  s = s.replace(HOME_RE, "$1<user>");
  s = s.replace(EMAIL_RE, "<email>");
  s = s.replace(SECRET_RE, "<redacted>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "");
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

interface FrameLike {
  filename?: unknown;
  abs_path?: unknown;
  function?: unknown;
  module?: unknown;
  [k: string]: unknown;
}
interface ExceptionLike {
  type?: unknown;
  value?: unknown;
  mechanism?: unknown;
  stacktrace?: { frames?: FrameLike[]; type?: unknown };
}

function scrubFrame(f: FrameLike): FrameLike {
  const out: FrameLike = {};
  // Keep only location fields; drop source context and local vars entirely.
  for (const k of ["platform", "lineno", "colno", "in_app", "chunk_id"]) {
    if (f[k] !== undefined) out[k] = f[k];
  }
  if (f.filename !== undefined) out.filename = scrubText(f.filename, 300);
  if (f.abs_path !== undefined) out.abs_path = scrubText(f.abs_path, 300);
  if (f.function !== undefined) out.function = scrubText(f.function, 200);
  if (f.module !== undefined) out.module = scrubText(f.module, 200);
  return out;
}

function scrubException(e: ExceptionLike): ExceptionLike {
  const out: ExceptionLike = {
    type: scrubText(e.type ?? "Error", 100),
    value: scrubText(e.value ?? ""),
  };
  if (e.mechanism && typeof e.mechanism === "object") out.mechanism = e.mechanism;
  const frames = e.stacktrace?.frames;
  if (Array.isArray(frames)) {
    out.stacktrace = {
      type: e.stacktrace?.type ?? "raw",
      frames: frames.slice(-MAX_FRAMES).map(scrubFrame),
    };
  }
  return out;
}

/** Minimal shape of a PostHog capture result we touch. */
export interface ScrubbableEvent {
  event: string;
  properties: Record<string, unknown>;
  $set?: unknown;
  $set_once?: unknown;
  $unset?: unknown;
  [k: string]: unknown;
}

/** PostHog `before_send` body: pass ONLY `$exception` events, with properties
 *  cut to the allowlist and every string scrubbed. Returns null to drop. */
export function scrubEvent<T extends ScrubbableEvent>(ev: T | null): T | null {
  if (!ev || ev.event !== "$exception") return null;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev.properties ?? {})) {
    if (!ALLOWED_PROPERTIES.has(k)) continue;
    if (k === "$exception_list") {
      props[k] = Array.isArray(v) ? (v as ExceptionLike[]).slice(0, 5).map(scrubException) : [];
    } else if (typeof v === "string") {
      props[k] = scrubText(v, 200);
    } else {
      props[k] = v;
    }
  }
  props.$process_person_profile = false;
  const out = { ...ev, properties: props };
  delete out.$set;
  delete out.$set_once;
  delete out.$unset;
  return out;
}
