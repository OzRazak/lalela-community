import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  useAuth,
  signIn,
  signUp,
  signOut,
  resetPassword,
  verifySignupCode,
  resendSignupCode,
} from "@/lib/auth";
import {
  AUXO_ID_SAME_ACCOUNT_LINE,
  AUXO_ID_SECURED_NOTICE,
  CODE_STEP_LINK_HINT,
  EMAIL_NOT_CONFIRMED_MESSAGE,
  classifySignInError,
  codeStepPrompt,
  invalidCredentialsMessage,
  normalizeOtp,
  resendSecondsLeft,
} from "@/lib/authFlowCore";
import { trackEvent } from "@/lib/analytics";
import { supabase } from "@/lib/supabase";
import { LALELA_API } from "@/lib/ai";
import { activeBadge, COSMETICS_CHANGED_EVENT } from "@/lib/cosmetics";
import {
  AUXO_ID_DESKTOP_ENABLED,
  AuxoIdAttemptAbandoned,
  cancelAuxoIdSignIn,
  signInWithAuxoId,
} from "@/lib/auxoIdDesktop";
import { IS_IOS } from "@/lib/platform";

/** The cosmetic badge worn beside the account name (Wave E1), or null. Reactive
 * to unlock / wear changes made in Settings → Rewards. Decorative only. */
function useActiveBadge() {
  const [badge, setBadge] = useState(activeBadge);
  useEffect(() => {
    const refresh = () => setBadge(activeBadge());
    window.addEventListener(COSMETICS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(COSMETICS_CHANGED_EVENT, refresh);
  }, []);
  return badge;
}

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

// "code": enter the emailed sign-up code (after Create account, or after a
// password sign-in into a never-confirmed account).
type Mode = "signin" | "signup" | "reset" | "code";

export function AccountPanel() {
  const { user } = useAuth();
  const badge = useActiveBadge();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Code step: the typed code and when the last email went out (resend cooldown).
  const [code, setCode] = useState("");
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // One-time notice shown in the signed-in view (Auxo ID secured the account).
  const [notice, setNotice] = useState<string | null>(null);
  // "Continue with Auxo ID" (Mac + iPhone/iPad): true while the sign-in is pending.
  // `auxoAttempt` lets Cancel abandon a pending attempt — its late result is ignored.
  const [auxoPending, setAuxoPending] = useState(false);
  const auxoAttempt = useRef(0);
  // Tick once a second while the resend cooldown runs.
  const resendLeft = resendSecondsLeft(lastSentAt, now);
  useEffect(() => {
    if (mode !== "code" || resendLeft === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mode, resendLeft]);
  // Account funnel: the sign-up / sign-in prompt was seen (signed out only).
  useEffect(() => {
    if (!user) trackEvent("signup_prompt_shown", { surface: "settings_account" });
  }, [user]);
  // Delete-account danger zone (signed-in view).
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Permanently delete the signed-in account + all its cloud data, then sign
  // out. Hits the hosted web API with the user's Supabase JWT — same base URL
  // and token path as every other call to our backend (lib/ai.ts). The server
  // identifies the user from the token alone, so nothing is sent in the body.
  const deleteAccount = async () => {
    setDeleteErr(null);
    setDeleting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("You appear to be signed out. Sign in again and retry.");
      const res = await fetch(`${LALELA_API}/api/account/delete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Account deletion failed (${res.status}).`);
      }
      // Set the shared success message BEFORE signing out — the sign-out flips
      // this panel to the signed-out form, which renders `msg`.
      setMsg("Your account and all its cloud data have been permanently deleted.");
      setConfirming(false);
      setConfirmText("");
      await signOut();
    } catch (e) {
      setDeleteErr(String(e instanceof Error ? e.message : e));
    } finally {
      setDeleting(false);
    }
  };

  if (user) {
    const canDelete = confirmText.trim().toUpperCase() === "DELETE";
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <div className="flex items-center gap-1.5 font-medium">
              {badge && (
                <span title={`${badge.label} badge`} aria-label={`${badge.label} badge`}>
                  {badge.glyph}
                </span>
              )}
              <span>{user.email}</span>
            </div>
            <div className="text-muted-foreground">Signed in · meetings sync to the cloud</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>

        {notice && (
          <div className="rounded-[var(--radius)] border border-border bg-card p-3 text-sm">
            <p>{notice}</p>
            <button
              className="mt-2 text-xs text-muted-foreground hover:underline"
              onClick={() => setNotice(null)}
            >
              Got it
            </button>
          </div>
        )}

        <div className="rounded-[var(--radius)] border border-danger/40 bg-danger/5 p-3">
          <div className="text-sm font-medium text-danger">Delete account</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Permanently deletes your account and everything synced to the cloud —
            meetings, folders, tags, workflows, connected notetakers and shared
            access. This cannot be undone. Meeting files kept locally on this
            device are not removed.
          </p>

          {!confirming ? (
            <Button
              variant="danger"
              size="sm"
              className="mt-3"
              onClick={() => {
                setConfirming(true);
                setDeleteErr(null);
              }}
            >
              Delete account
            </Button>
          ) : (
            <div className="mt-3 space-y-2">
              <label className="block text-xs text-muted-foreground">
                Type <span className="font-semibold text-danger">DELETE</span> to confirm this is
                permanent.
              </label>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className={inputClass}
              />
              {deleteErr && <p className="text-sm text-danger">{deleteErr}</p>}
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!canDelete || deleting}
                  onClick={deleteAccount}
                >
                  {deleting ? "Deleting…" : "Permanently delete account"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={deleting}
                  onClick={() => {
                    setConfirming(false);
                    setConfirmText("");
                    setDeleteErr(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Switch to the code step for `email` (the confirmation email just went out).
  const enterCodeStep = (sentNow: boolean) => {
    setCode("");
    setMode("code");
    if (sentNow) {
      const t = Date.now();
      setLastSentAt(t);
      setNow(t);
    }
  };

  const submit = async () => {
    // A password sign-in supersedes any pending Auxo ID attempt.
    if (auxoPending) cancelAuxoId();
    setErr(null);
    setMsg(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        try {
          await signIn(email, password);
        } catch (e) {
          const kind = classifySignInError(e);
          if (kind === "invalid_credentials") {
            setErr(invalidCredentialsMessage(AUXO_ID_DESKTOP_ENABLED));
            return;
          }
          if (kind === "email_not_confirmed") {
            enterCodeStep(false);
            setErr(EMAIL_NOT_CONFIRMED_MESSAGE);
            return;
          }
          throw e;
        }
      } else if (mode === "signup") {
        const created = await signUp(email, password, name);
        if (created) {
          enterCodeStep(true);
        } else {
          setErr('This email already has an account — sign in below, or use "Forgot password?".');
          setMode("signin");
        }
      } else if (mode === "code") {
        const token = normalizeOtp(code);
        if (!token) {
          setErr("Enter the code from the email (6 digits).");
          return;
        }
        await verifySignupCode(email, token);
      } else {
        await resetPassword(email);
        setMsg("If that email exists, a reset link is on its way.");
        setMode("signin");
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await resendSignupCode(email);
      const t = Date.now();
      setLastSentAt(t);
      setNow(t);
      setMsg("New code sent. Check your inbox (and spam).");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const continueWithAuxoId = async () => {
    const attempt = ++auxoAttempt.current;
    setErr(null);
    setMsg(null);
    setNotice(null);
    setAuxoPending(true);
    try {
      const { secured } = await signInWithAuxoId(() => attempt === auxoAttempt.current);
      if (secured && attempt === auxoAttempt.current) setNotice(AUXO_ID_SECURED_NOTICE);
    } catch (e) {
      if (attempt === auxoAttempt.current && !(e instanceof AuxoIdAttemptAbandoned)) {
        setErr(String(e instanceof Error ? e.message : e));
      }
    } finally {
      if (attempt === auxoAttempt.current) setAuxoPending(false);
    }
  };

  // Invalidate the attempt: signInWithAuxoId re-checks it before installing a
  // session, so a late browser completion is discarded. The loopback listener
  // is left to its ~5-minute timeout — it is shared with the Microsoft
  // connection, so it is not torn down from here. On iPhone/iPad this also
  // dismisses the in-app sign-in sheet if it is still open.
  const cancelAuxoId = () => {
    auxoAttempt.current++;
    setAuxoPending(false);
    cancelAuxoIdSignIn();
  };

  if (mode === "code") {
    return (
      <div className="space-y-2">
        <p className="text-sm">{codeStepPrompt(email)}</p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="123456"
          className={`${inputClass} tracking-[0.3em]`}
        />
        <p className="text-xs text-muted-foreground">{CODE_STEP_LINK_HINT}</p>

        {err && <p className="text-sm text-danger">{err}</p>}
        {msg && <p className="text-sm text-success">{msg}</p>}

        <Button className="w-full" onClick={submit} disabled={busy}>
          Confirm and sign in
        </Button>

        <div className="flex justify-between pt-1 text-xs text-muted-foreground">
          <button
            className="hover:underline"
            onClick={() => {
              setErr(null);
              setMsg(null);
              setMode("signin");
            }}
          >
            Back to sign in
          </button>
          <button className="hover:underline disabled:opacity-50" onClick={resend} disabled={busy || resendLeft > 0}>
            {resendLeft > 0 ? `Resend code (${resendLeft}s)` : "Resend code"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {mode === "signup" && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className={inputClass}
        />
      )}
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className={inputClass}
      />
      {mode !== "reset" && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={inputClass}
        />
      )}

      {err && <p className="text-sm text-danger">{err}</p>}
      {msg && <p className="text-sm text-success">{msg}</p>}

      <Button className="w-full" onClick={submit} disabled={busy || auxoPending}>
        {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
      </Button>

      {AUXO_ID_DESKTOP_ENABLED && mode !== "reset" && (
        <>
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          {auxoPending ? (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {IS_IOS
                  ? "Finish signing in with Auxo ID in the sign-in window."
                  : "Finish signing in with Auxo ID in your browser, then come back here."}
              </p>
              <Button variant="outline" size="sm" className="w-full" onClick={cancelAuxoId}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Button variant="outline" className="w-full" onClick={continueWithAuxoId} disabled={busy}>
                Continue with Auxo ID
              </Button>
              <p className="text-center text-xs text-muted-foreground">{AUXO_ID_SAME_ACCOUNT_LINE}</p>
            </div>
          )}
        </>
      )}

      <div className="flex justify-between pt-1 text-xs text-muted-foreground">
        {mode !== "signin" ? (
          <button className="hover:underline" onClick={() => setMode("signin")}>
            Have an account? Sign in
          </button>
        ) : (
          <button className="hover:underline" onClick={() => setMode("signup")}>
            Create account
          </button>
        )}
        {mode !== "reset" && (
          <button className="hover:underline" onClick={() => setMode("reset")}>
            Forgot password?
          </button>
        )}
      </div>
    </div>
  );
}
