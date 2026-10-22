// Third-party (cloud) AI consent gate — storage + the "ask the user" plumbing.
// Pure decision logic lives in aiConsentCore.ts (tested); the dialog is
// components/CloudAiConsent.tsx. The ONE call site is the AI front door
// (lib/ai.ts → `await ensureCloudAiConsent(route, { interactive })` right after
// the route is resolved), so every surface — summaries, chat, tasks, Copilot,
// automations, auto-sort — is covered.
//
// Scope: every native build — iOS/iPadOS, Android (App Review 5.1.2(i), Google
// Play user-data policy) and, since 1.3.11, macOS + Windows (direct and
// Microsoft Store). See docs/DECISIONS.md 2026-10-08.
//
// Background vs user-initiated: only a generation the user just started passes
// `interactive: true` and may show the dialog. Everything automatic (auto-title,
// auto-summary, automations, folder rules, scheduled reports, dossiers,
// knowledge, auto-sort of new meetings) is "background": while the user has not
// answered yet it is skipped quietly (AiConsentError reason "undecided") and
// nothing is sent. User-started engine runs ask up front via
// `preflightCloudAiConsent` (lib/ai.ts), then run as background.

import {
  AiConsentError,
  consentDecision,
  parseConsent,
  type CloudAiConsent,
} from "./aiConsentCore";

export { AiConsentError, isAiConsentError } from "./aiConsentCore";

const KEY = "lalela.ai.cloudConsent";
export const CLOUD_AI_CONSENT_EVENT = "lalela:cloud-ai-consent-changed";

/** Whether this build enforces the gate — every native build (mobile and
 * desktop). Kept as a constant so the UI can still branch on it. */
export const CLOUD_AI_CONSENT_REQUIRED: boolean = true;

export function getCloudAiConsent(): CloudAiConsent {
  return parseConsent(localStorage.getItem(KEY));
}

export function setCloudAiConsent(granted: boolean): void {
  localStorage.setItem(KEY, granted ? "granted" : "denied");
  window.dispatchEvent(new Event(CLOUD_AI_CONSENT_EVENT));
}

// ---- asking -----------------------------------------------------------------

type Prompter = () => Promise<boolean>;
let prompter: Prompter | null = null;
let pending: Promise<boolean> | null = null;

/** The dialog host registers itself here (mounted once, in main.tsx). Returns the
 * unregister function. */
export function registerCloudAiConsentPrompt(p: Prompter): () => void {
  prompter = p;
  return () => {
    if (prompter === p) prompter = null;
  };
}

/**
 * Resolve when a generation on `route` may proceed; throw AiConsentError when
 * it may not. Only `interactive` (user-started) generations can show the
 * dialog; background ones fail closed and quietly while the user hasn't
 * answered. Never asks twice at once: concurrent user-started generations
 * share one dialog. With no dialog host mounted (a secondary window) it fails
 * closed — nothing is sent without permission.
 */
export async function ensureCloudAiConsent(
  route: string,
  opts: { interactive?: boolean } = {},
): Promise<void> {
  const d = consentDecision(
    route,
    CLOUD_AI_CONSENT_REQUIRED,
    getCloudAiConsent(),
    opts.interactive ? "interactive" : "background",
  );
  if (d === "allow") return;
  if (d === "block") throw new AiConsentError("denied");
  if (d === "skip" || !prompter) throw new AiConsentError("undecided");
  pending ??= prompter().finally(() => {
    pending = null;
  });
  const ok = await pending;
  setCloudAiConsent(ok);
  if (!ok) throw new AiConsentError();
}
