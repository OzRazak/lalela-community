import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { trackEvent } from "@/lib/analytics";

/** Reactive auth state. Sign-in is optional — Lalela works fully local without it. */
export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user: session?.user ?? null, loading };
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // Rethrow the AuthError itself: its `code` (invalid_credentials,
  // email_not_confirmed) drives the hints in AccountPanel (authFlowCore.ts).
  if (error) throw error;
  trackEvent("signed_in", { method: "password" });
}

/**
 * Finish a sign-up with the code from the confirmation email (Supabase email
 * OTP, 6–8 digits). Confirms the address and signs in. The email's link keeps
 * working too — it just lands on the web app instead.
 */
export async function verifySignupCode(email: string, code: string) {
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "signup" });
  if (error) throw new Error(error.message);
  trackEvent("signed_in", { method: "signup" });
}

/** Send the sign-up confirmation email (code + link) again. */
export async function resendSignupCode(email: string) {
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) throw new Error(error.message);
}

/** Returns true when the account was created; false when the address already
 * has an account. Supabase signals the latter with a faux user that has no
 * identities (instead of an error, to avoid leaking who is registered). */
export async function signUp(email: string, password: string, displayName: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName || email } },
  });
  if (error) throw new Error(error.message);
  const created = (data.user?.identities?.length ?? 0) > 0;
  if (created) trackEvent("account_created");
  return created;
}

export async function signOut() {
  trackEvent("signed_out"); // before the id rotates
  await supabase.auth.signOut();
}

export async function resetPassword(email: string) {
  // Recovery links open in a browser, so they land on the web app's /reset
  // page (which sets the new password for this same Supabase account).
  // Without redirectTo, Supabase falls back to its Site URL setting — which
  // once pointed at localhost:3000 and stranded the reset flow.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: "https://lalela-app.auxodigital.africa/reset",
  });
  if (error) throw new Error(error.message);
}

export type { User };
