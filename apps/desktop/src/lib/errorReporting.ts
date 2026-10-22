// Opt-in, content-free crash & error reporting (PostHog Error Tracking, EU).
//
// Privacy contract (see docs/DECISIONS.md "Opt-in, content-free error
// reporting via PostHog"):
//   * Nothing is sent unless the person has turned on Settings ▸ Privacy ▸
//     "Send anonymous crash & error reports" (OFF by default). The PostHog
//     client is shared with usage analytics (lib/posthog.ts); its before_send
//     router only lets `$exception` through while this toggle is on, and
//     gives every report a per-launch random id that is never linked to an
//     account or to usage data.
//   * Exceptions ONLY — no autocapture, pageviews, session recording, surveys,
//     feature flags, remote scripts or person profiles; in-memory random id.
//   * Every event passes `scrubEvent` (errorScrub.ts): only `$exception`
//     events survive, properties are cut to an allowlist, and messages/stack
//     frames lose home dirs, meeting-folder paths, quoted content, emails and
//     keys. Recordings, transcripts, notes, titles, names and file contents
//     are never sent.
//   * Turning the toggle off stops sending immediately (opt-out + a gate in
//     before_send), with no restart.
import { invoke } from "@tauri-apps/api/core";
import { scrubText } from "./errorScrub";
import { ERROR_REPORTS_EVENT, getErrorReportsEnabled } from "./settings";
import { onLlmComplete } from "./lalela";
import { getPosthog, posthogBuildConfig, syncPosthogConsent, type PosthogBuildConfig } from "./posthog";
import { ensureSuperProps } from "./analytics";

export type ErrorReportingBuildConfig = PosthogBuildConfig;

/** The build-time PostHog config, or null when this build cannot send
 *  (dev builds without an explicit key, or VITE_POSTHOG_KEY=off). */
export function errorReportingBuildConfig(): ErrorReportingBuildConfig | null {
  return posthogBuildConfig();
}

/** True only when this build CAN report and the person has opted in. */
export function errorReportsActive(): boolean {
  return errorReportingBuildConfig() !== null && getErrorReportsEnabled();
}

const CRASH_CURSOR_KEY = "lalela.errorReports.crashCursor";

let installed = false;
let unlistenDownloads: (() => void) | null = null;

async function load() {
  const ph = await getPosthog();
  if (ph) await ensureSuperProps(ph);
  return ph;
}

function toError(err: unknown, fallbackName = "Error"): Error {
  if (err instanceof Error) return err;
  const e = new Error(scrubText(typeof err === "string" ? err : String(err)));
  e.name = fallbackName;
  return e;
}

/** Report a (handled or unhandled) error. No-op unless opted in + keyed.
 *  Only pass errors — never prompts, outputs or meeting data as context. */
export function reportError(
  err: unknown,
  ctx: { source: string; ai_route?: string; name?: string } = { source: "handled" },
): void {
  if (!errorReportsActive()) return;
  const e = toError(err, ctx.name);
  void load().then((ph) => {
    if (!ph || !errorReportsActive()) return;
    try {
      ph.captureException(e, {
        source: ctx.source,
        ...(ctx.ai_route ? { ai_route: ctx.ai_route } : {}),
      });
    } catch {
      /* never throw from the reporter */
    }
  });
}

const EXPECTED_AI_ERRORS = new Set(["AbortError", "NoAiError", "QuotaError"]);

/** Report a failed on-device generation (local GGUF sidecar / Apple model).
 *  User cancels, "no AI configured" and quota errors are expected, not bugs. */
export function reportAiFailure(err: unknown, route: string): void {
  if (route !== "local" && route !== "apple") return;
  if (err instanceof Error && EXPECTED_AI_ERRORS.has(err.name)) return;
  reportError(err, { source: "ai_generate", ai_route: route, name: "AiGenerateError" });
}

/** Forward Rust panics recorded in crash.log since the last forwarded one.
 *  The first time reports are on, the cursor starts at "now": crashes from
 *  before the person opted in are never sent. */
async function forwardCrashes(): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const stored = localStorage.getItem(CRASH_CURSOR_KEY);
  if (stored === null) {
    localStorage.setItem(CRASH_CURSOR_KEY, String(nowSecs));
    return;
  }
  let entries: { ts: number; line: string }[] = [];
  try {
    entries = await invoke("crash_reports_since", { after: Number(stored) || 0 });
  } catch {
    return;
  }
  let cursor = Number(stored) || 0;
  for (const { ts, line } of entries) {
    if (!errorReportsActive()) break;
    const msg = line.replace(/^\[\d+\]\s*panic:\s*/, "");
    const e = new Error(scrubText(msg));
    e.name = "RustPanic";
    e.stack = `RustPanic: ${e.message}`; // no JS frames — the location is in the message
    reportError(e, { source: "rust_panic" });
    cursor = Math.max(cursor, ts);
  }
  localStorage.setItem(CRASH_CURSOR_KEY, String(cursor));
}

async function sync(): Promise<void> {
  syncPosthogConsent();
  if (!errorReportsActive()) {
    unlistenDownloads?.();
    unlistenDownloads = null;
    return;
  }
  const ph = await load();
  if (!ph || !errorReportsActive()) return;
  if (!unlistenDownloads) {
    try {
      unlistenDownloads = await onLlmComplete((p) => {
        if (p.ok || !p.error || /cancel/i.test(p.error)) return;
        reportError(new Error(`${p.file}: ${p.error}`), {
          source: "model_download",
          name: "ModelDownloadError",
        });
      });
    } catch {
      /* non-Tauri */
    }
  }
  await forwardCrashes();
}

/** Install global handlers once at startup. Cheap and inert when off. */
export function initErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (ev) => {
    reportError(ev.error ?? ev.message, { source: "window_error" });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    reportError(ev.reason, { source: "unhandled_rejection", name: "UnhandledRejection" });
  });
  window.addEventListener(ERROR_REPORTS_EVENT, () => void sync());
  void sync();
}
