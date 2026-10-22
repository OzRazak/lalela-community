// Pure core of the third-party (cloud) AI consent gate — no DOM, no storage,
// so it runs under `node --test`. See lib/aiConsent.ts for the wiring and
// docs/DECISIONS.md 2026-10-07 (mobile) + 2026-10-08 (desktop, background
// skip) for why.
//
// App Review Guideline 5.1.2(i) (as updated Nov 2025): "You must clearly
// disclose where personal data will be shared with third parties, including
// with third-party AI, and obtain explicit permission before doing so."
// Lalela's cloud AI lanes send meeting content off the device to third-party
// model providers:
//   "free" → Lalela's /api/ai proxy → OpenRouter → the model's provider
//   "byok" → OpenRouter directly with the user's own key → the provider
// The on-device lanes ("local" GGUF sidecar, "apple" Foundation Models) never
// leave the device and never need consent.

/** Stored answer. `null` = never asked. */
export type CloudAiConsent = "granted" | "denied" | null;

/** The routes that send content to a third-party AI provider. */
export const CLOUD_AI_ROUTES: readonly string[] = ["free", "byok"];

export function isCloudAiRoute(route: string): boolean {
  return CLOUD_AI_ROUTES.includes(route);
}

/** What the gate should do for one generation.
 * - "allow": send it.
 * - "ask":   show the dialog (only ever for a user-initiated generation).
 * - "block": the user said no — refuse.
 * - "skip":  never asked, and this is a BACKGROUND generation (auto-title,
 *            auto-summary, automations, scheduled reports, …) — refuse quietly
 *            without popping a dialog out of nowhere. Nothing is sent. */
export type ConsentDecision = "allow" | "ask" | "block" | "skip";

/** Who started the generation. Only "interactive" (the user just clicked
 * something that needs AI) may show the dialog. */
export type ConsentMode = "interactive" | "background";

/**
 * @param route     the resolved AI route (`aiRoute()` in lib/ai.ts)
 * @param required  whether this build enforces the gate (every native build
 *                  since 1.3.11: iOS/iPadOS, Android, macOS, Windows)
 * @param consent   the stored answer
 * @param mode      user-initiated or background (see {@link ConsentMode})
 */
export function consentDecision(
  route: string,
  required: boolean,
  consent: CloudAiConsent,
  mode: ConsentMode = "interactive",
): ConsentDecision {
  if (!required || !isCloudAiRoute(route)) return "allow";
  if (consent === "granted") return "allow";
  if (consent === "denied") return "block";
  return mode === "interactive" ? "ask" : "skip";
}

/** Parse the raw localStorage value; anything unknown counts as "never asked". */
export function parseConsent(raw: string | null): CloudAiConsent {
  return raw === "granted" || raw === "denied" ? raw : null;
}

/** Thrown in place of a generation the user has not allowed. Callers already
 * surface `e.message` for NoAiError/QuotaError; this reads the same way.
 * `reason` "undecided" = a background generation skipped because the user has
 * not been asked yet (background callers treat any AiConsentError as a quiet
 * skip). */
export class AiConsentError extends Error {
  readonly reason: "denied" | "undecided";
  constructor(reason: "denied" | "undecided" = "denied") {
    super(
      reason === "undecided"
        ? "Cloud AI needs your permission first. Allow it in Settings → Recording → Privacy & consent, or pick an on-device model."
        : "Cloud AI is off. To use it, allow it in Settings → Recording → Privacy & consent, or pick an on-device model.",
    );
    this.name = "AiConsentError";
    this.reason = reason;
  }
}

/** True for a generation the consent gate refused (denied or not yet asked). */
export function isAiConsentError(e: unknown): e is AiConsentError {
  return e instanceof AiConsentError;
}
