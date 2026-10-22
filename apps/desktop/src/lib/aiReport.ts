// Report AI content — the desktop/iOS sending side (see aiReportCore.ts for the
// privacy contract and docs/DECISIONS.md 2026-10-07).
//
// Sends to the hosted /api/ai/report route, which works signed in OR signed
// out (and for local/BYOK users — nothing about reporting depends on the
// free-tier proxy). Any failure — offline, server down, rate-limited — falls
// back to opening a prefilled email to support, so a report is never lost
// silently. The caller tells the user which of the two happened.
import { openUrl } from "@tauri-apps/plugin-opener";
import { LALELA_API } from "./ai";
import { appVersion, lastAiCall, trackEvent } from "./analytics";
import {
  buildAiReportMailto,
  buildAiReportPayload,
  platformFromUserAgent,
  type AiReportCategory,
  type AiReportSurface,
} from "./aiReportCore";
import { supabase } from "@/lib/supabase";

export interface AiReportRequest {
  category: AiReportCategory;
  comment: string;
  surface: AiReportSurface;
  includeOutput: boolean;
  output?: string | null;
  /** Model id that produced the output, when the surface knows it. */
  model?: string | null;
  /** Route (local/apple/byok/free) when known; else the last AI call's. */
  route?: string | null;
}

/** "sent" = stored for review; "email" = opened a prefilled email instead;
 * "failed" = neither worked (the dialog shows the address to write to). */
export type AiReportOutcome = "sent" | "email" | "failed";

export async function submitAiReport(req: AiReportRequest): Promise<AiReportOutcome> {
  const last = lastAiCall();
  const version = await appVersion().catch(() => null);
  const payload = buildAiReportPayload({
    ...req,
    model: req.model ?? last?.model ?? null,
    route: req.route ?? last?.route ?? null,
    appVersion: version,
    platform: platformFromUserAgent(navigator.userAgent, "desktop"),
    client: "desktop",
  });
  // Analytics: category + surface only — never the comment or the output.
  trackEvent("ai_content_reported", { category: payload.category, surface: payload.surface });

  try {
    const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
    const token = data.session?.access_token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${LALELA_API}/api/ai/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) return "sent";
  } catch {
    /* offline / blocked — fall through to email */
  }
  try {
    await openUrl(buildAiReportMailto(payload));
    return "email";
  } catch {
    return "failed";
  }
}
