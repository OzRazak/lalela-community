// Email + password account flow — pure helpers (no Supabase, no React) so
// `node --test` can load them. Wiring lives in lib/auth.ts + AccountPanel.tsx.
// The web sign-in panel keeps the same copy in apps/web/lib/authNotices.ts
// (web/desktop parity rule).

/** How a password sign-in failed, as far as the UI cares. */
export type SignInFailure = "invalid_credentials" | "email_not_confirmed" | "other";

/**
 * Classify a Supabase auth error. Prefers the stable `code` (AuthApiError,
 * supabase-js ≥ 2.43), falling back to the long-standing message text for
 * older servers / wrapped errors.
 */
export function classifySignInError(e: unknown): SignInFailure {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const message = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return "invalid_credentials";
  }
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "email_not_confirmed";
  }
  return "other";
}

/**
 * Wrong email/password. Accounts made or touched by "Continue with Auxo ID"
 * may have no usable Lalela password (an unconfirmed account's password is
 * rotated as a pre-hijack guard), so point people at the two ways back in.
 * Omit the Auxo ID clause where that button isn't offered.
 */
export function invalidCredentialsMessage(auxoIdAvailable: boolean): string {
  return auxoIdAvailable
    ? "Wrong email or password. Signed up with Auxo ID? Use Continue with Auxo ID, or Forgot password to set a Lalela password."
    : "Wrong email or password. Use Forgot password to set a Lalela password.";
}

/** Shown when a password sign-in hits an account that was never confirmed. */
export const EMAIL_NOT_CONFIRMED_MESSAGE =
  "This email hasn't been confirmed yet. Enter the code from your sign-up email, or send a new one.";

/** Small line under "Continue with Auxo ID". */
export const AUXO_ID_SAME_ACCOUNT_LINE =
  "Same account as your Lalela email — your Lalela password still works.";

/** Shown once after an Auxo ID sign-in that secured an unconfirmed account. */
export const AUXO_ID_SECURED_NOTICE =
  "You're signed in. Because this email had never been confirmed, we reset the Lalela password on it to keep it safe. Use Continue with Auxo ID, or Forgot password to set a new Lalela password.";

/** Copy for the code step after sign-up (or an unconfirmed sign-in). */
export function codeStepPrompt(email: string): string {
  return `Enter the 6-digit code we emailed to ${email}.`;
}
export const CODE_STEP_LINK_HINT = "You can also click the link in the email.";

/** Seconds between "Resend code" presses (Supabase also rate-limits). */
export const RESEND_COOLDOWN_S = 60;

/**
 * Normalise a typed/pasted email OTP: strips spaces and dashes, then accepts
 * 6–8 digits (Supabase's OTP length is configurable, default 6). Returns
 * null when it can't be a code yet.
 */
export function normalizeOtp(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6,8}$/.test(digits) ? digits : null;
}

/** Whole seconds left before resend is allowed again (0 = allowed). */
export function resendSecondsLeft(lastSentAt: number | null, now: number, cooldownS = RESEND_COOLDOWN_S): number {
  if (lastSentAt == null) return 0;
  const left = Math.ceil((lastSentAt + cooldownS * 1000 - now) / 1000);
  return left > 0 ? left : 0;
}
