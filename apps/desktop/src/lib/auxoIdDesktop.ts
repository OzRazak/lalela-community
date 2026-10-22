// "Continue with Auxo ID" on the Mac app — wiring. The flow, parsing and the
// design note live in auxoIdDesktopCore.ts (unit-tested there).
//
// Additive: email+password and the Microsoft connection are untouched. Mac
// (loopback) and iPhone/iPad (in-app ASWebAuthenticationSession, commands in
// src-tauri/src/auxo_id_ios.rs). The loopback commands exist on every desktop
// build, so Windows compiles and simply never shows the button; Android has
// neither and hides it too.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createClient } from "@supabase/supabase-js";
import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase";
import { LALELA_API } from "@/lib/ai";
import { trackEvent } from "@/lib/analytics";
import { IS_IOS, IS_MACOS } from "@/lib/platform";
import { IS_COMMUNITY } from "@/lib/edition";
import { runDesktopSignIn, runIosSignIn, type DesktopSignInDeps } from "@/lib/auxoIdDesktopCore";

export { AuxoIdAttemptAbandoned } from "@/lib/auxoIdDesktopCore";

/** Auxo ID is an Auxo cloud sign-in: never offered in the Community edition. */
export const AUXO_ID_DESKTOP_ENABLED = !IS_COMMUNITY && (IS_MACOS || IS_IOS);

/** iOS only: dismiss the in-app sign-in sheet if it's open (its run then resolves as abandoned). */
export function cancelAuxoIdSignIn(): void {
  if (IS_IOS) void invoke("auxo_id_web_auth_cancel").catch(() => {});
}

/** Called only when the browser could not be opened (mirrors msauth.ts). */
async function dropListener(): Promise<void> {
  await invoke("oauth_loopback_cancel").catch(() => {});
}

/** Exchange + verify + commit — shared by the Mac and iOS flows. */
const redeemDeps: Pick<DesktopSignInDeps, "apiBase" | "postJson" | "verify" | "commit"> = {
  apiBase: LALELA_API,
  postJson: async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  },
  verify: async ({ tokenHash, type }) => {
    // Throwaway client: in-memory, never persisted, own storage key — so
    // verifyOtp can't write the shared session before the attempt is re-checked.
    const mem = new Map<string, string>();
    const scratch = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "lalela-auxo-id-scratch",
        storage: {
          getItem: (k) => mem.get(k) ?? null,
          setItem: (k, v) => void mem.set(k, v),
          removeItem: (k) => void mem.delete(k),
        },
      },
    });
    const { data, error } = await scratch.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) throw new Error(error.message);
    const session = data.session;
    if (!session) throw new Error("Auxo ID sign-in returned no session. Please try again.");
    return { access_token: session.access_token, refresh_token: session.refresh_token };
  },
  commit: async (tokens) => {
    const { error } = await supabase.auth.setSession(tokens);
    if (error) throw new Error(error.message);
  },
};

/**
 * Run the sign-in; `isCurrent` lets the caller abandon it (Cancel). Resolves
 * `secured: true` when the server had to reset the password on a
 * never-confirmed account — the caller tells the user once (Mac and iOS alike).
 */
export async function signInWithAuxoId(isCurrent: () => boolean): Promise<{ secured: boolean }> {
  let result: { secured: boolean };
  if (IS_IOS) {
    result = await runIosSignIn(
      { ...redeemDeps, authenticate: (url) => invoke<string>("auxo_id_web_auth", { url }) },
      isCurrent,
    );
  } else {
    result = await runDesktopSignIn(
      {
        ...redeemDeps,
        listen: () => invoke<number>("oauth_loopback_listen", { portPreference: null }),
        wait: () => invoke<string>("oauth_loopback_wait"),
        cancel: dropListener,
        openUrl: (url) => openUrl(url),
      },
      isCurrent,
    );
  }
  trackEvent("signed_in", { method: "auxo_id" });
  return result;
}
