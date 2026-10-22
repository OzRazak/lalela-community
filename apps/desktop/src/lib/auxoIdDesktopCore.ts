// "Continue with Auxo ID" on the Mac app — pure helpers (no Tauri, no Supabase)
// so `node --test` can load them. The flow itself lives in auxoIdDesktop.ts;
// the server half (and the full design) is apps/web/lib/auxoId.ts "Desktop".
//
// The app never talks to Auxo ID directly and ships no client secret:
//   1. bind a one-shot 127.0.0.1 listener (msoauth.rs, shared with Microsoft),
//      make a random state + verifier, open the system browser on
//      /api/auth/auxo-id/desktop?port=&state=&challenge=S256(verifier);
//   2. the web app runs the confidential OIDC flow, then asks the user to
//      confirm on its own origin before redirecting to
//      http://127.0.0.1:<port>/?code=<sealed>&state=<state> (or ?error=);
//   3. the app checks the state, POSTs code + verifier to
//      /api/auth/auxo-id/desktop/exchange for the one-time token_hash, and
//      redeems it with supabase.auth.verifyOtp.
//
// iPhone/iPad: no loopback (iOS suspends the app while a browser is in front).
// Step 1 opens /api/auth/auxo-id/desktop?return=ios&state=&challenge= inside an
// in-app ASWebAuthenticationSession (src-tauri/src/auxo_id_ios.rs), and step 2's
// redirect is lalela://auxo-id?code=…&state=…, which that session intercepts and
// returns to us. Step 3 is identical (runIosSignIn below).

export const AUXO_ID_DESKTOP_PATH = "/api/auth/auxo-id/desktop";
export const AUXO_ID_DESKTOP_EXCHANGE_PATH = "/api/auth/auxo-id/desktop/exchange";
/** Where the web app hands an iOS sign-in back (apps/web/lib/auxoId.ts IOS_RETURN_URL). */
export const AUXO_ID_IOS_CALLBACK = "lalela://auxo-id";

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random URL-safe value (32 bytes → 43 base64url chars): state and verifier. */
export function newDesktopState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** S256 challenge for a verifier (base64url SHA-256), as the web app checks it. */
export async function desktopChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The browser URL that starts the desktop sign-in on the web app at `apiBase`. */
export function desktopStartUrl(apiBase: string, port: number, state: string, challenge: string): string {
  const u = new URL(AUXO_ID_DESKTOP_PATH, apiBase);
  u.searchParams.set("port", String(port));
  u.searchParams.set("state", state);
  u.searchParams.set("challenge", challenge);
  return u.toString();
}

/** The in-app browser URL that starts the iPhone/iPad sign-in (no loopback port). */
export function iosStartUrl(apiBase: string, state: string, challenge: string): string {
  const u = new URL(AUXO_ID_DESKTOP_PATH, apiBase);
  u.searchParams.set("return", "ios");
  u.searchParams.set("state", state);
  u.searchParams.set("challenge", challenge);
  return u.toString();
}

// Same copy as the web sign-in panel (apps/web/lib/auxoIdMessages.ts). A Map,
// not an object literal: the code comes from a URL.
const MESSAGES = new Map<string, string>([
  ["state_mismatch", "That Auxo ID sign-in expired or was opened in another tab. Please try again."],
  ["denied", "Auxo ID sign-in was cancelled."],
  ["email_unverified", "Verify your email in Auxo ID first, then try again."],
  ["no_email", "Your Auxo ID account has no email address."],
  ["account", "We couldn't open your Lalela account. Please try again."],
]);
export const AUXO_ID_ERROR_FALLBACK = "Auxo ID sign-in failed. Please try again.";

export function auxoIdErrorMessage(code: string): string {
  return MESSAGES.get(code) ?? AUXO_ID_ERROR_FALLBACK;
}

export interface DesktopHandoff {
  tokenHash: string;
  type: "magiclink";
  /**
   * The server confirmed a never-confirmed account and rotated its Lalela
   * password (pre-hijack guard). The app tells the user once after sign-in.
   * Present only when true.
   */
  secured?: true;
}

/**
 * Validate the loopback redirect's raw query string against the state this
 * app sent. Throws a user-facing Error on mismatch or an error code; returns
 * the sealed one-time code otherwise. The state is checked FIRST so a foreign
 * redirect can't even surface its error text.
 */
export function parseDesktopRedirect(rawQuery: string, expectedState: string): { code: string } {
  const q = new URLSearchParams(rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery);
  const state = q.get("state");
  if (!expectedState || state !== expectedState) {
    throw new Error("Sign-in state mismatch — please try Continue with Auxo ID again.");
  }
  const error = q.get("error");
  if (error) throw new Error(auxoIdErrorMessage(error));
  const code = q.get("code");
  if (!code) throw new Error(AUXO_ID_ERROR_FALLBACK);
  return { code };
}

const IOS_CALLBACK_RE = /^lalela:\/\/auxo-id\/?\?([^#]*)(?:#.*)?$/;

/**
 * Validate the iOS hand-back URL (lalela://auxo-id?code=…&state=…, or ?error=)
 * against the state this app sent. Anything that isn't exactly that scheme +
 * host is rejected before its query is read; then the same checks as the Mac
 * loopback apply (state first).
 */
export function parseIosCallbackUrl(url: string, expectedState: string): { code: string } {
  const m = typeof url === "string" ? IOS_CALLBACK_RE.exec(url) : null;
  if (!m) throw new Error(AUXO_ID_ERROR_FALLBACK);
  return parseDesktopRedirect(m[1], expectedState);
}

/** Validate /desktop/exchange's JSON body; only a magic-link token_hash is accepted. */
export function parseExchangeResponse(ok: boolean, body: unknown): DesktopHandoff {
  const b = body as { token_hash?: unknown; type?: unknown; secured?: unknown } | null;
  if (!ok || !b || typeof b.token_hash !== "string" || !b.token_hash || b.type !== "magiclink") {
    throw new Error(AUXO_ID_ERROR_FALLBACK);
  }
  return b.secured === true
    ? { tokenHash: b.token_hash, type: "magiclink", secured: true }
    : { tokenHash: b.token_hash, type: "magiclink" };
}

/** Thrown when the attempt was cancelled/superseded; callers show nothing. */
export class AuxoIdAttemptAbandoned extends Error {
  constructor() {
    super("Auxo ID sign-in was cancelled.");
    this.name = "AuxoIdAttemptAbandoned";
  }
}

/** Side effects of the flow, injected so the orchestration is unit-testable. */
export interface DesktopSignInDeps {
  apiBase: string;
  /** Bind the loopback listener; returns its port. */
  listen(): Promise<number>;
  /** Await the loopback redirect's raw query string. */
  wait(): Promise<string>;
  /** Drop the listener and end a pending wait. */
  cancel(): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** POST JSON to the exchange route; returns ok + parsed body (or null). */
  postJson(url: string, body: unknown): Promise<{ ok: boolean; body: unknown }>;
  /**
   * Redeem the token_hash on a THROWAWAY Supabase client (no persistence, no
   * shared storage) and return the resulting tokens. Must not touch the app's
   * shared session — the caller re-checks the attempt before committing.
   */
  verify(h: DesktopHandoff): Promise<DesktopSessionTokens>;
  /** Install the tokens on the app's shared Supabase client (setSession). */
  commit(tokens: DesktopSessionTokens): Promise<void>;
}

export interface DesktopSessionTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * The whole desktop sign-in. `isCurrent` is checked after every await and
 * IMMEDIATELY before `commit` (verify never touches the shared session), so a cancelled or superseded attempt can never
 * replace the session (e.g. one the user signed into with a password after
 * pressing Cancel).
 */
export async function runDesktopSignIn(
  deps: DesktopSignInDeps,
  isCurrent: () => boolean,
): Promise<{ secured: boolean }> {
  const guard = () => {
    if (!isCurrent()) throw new AuxoIdAttemptAbandoned();
  };
  const port = await deps.listen();
  guard();
  const state = newDesktopState();
  const verifier = newDesktopState();
  const challenge = await desktopChallenge(verifier);
  guard();

  // Start waiting BEFORE opening the browser so the redirect can't race us.
  const redirect = deps.wait();
  try {
    await deps.openUrl(desktopStartUrl(deps.apiBase, port, state, challenge));
  } catch (e) {
    redirect.catch(() => {});
    await deps.cancel();
    throw e;
  }

  const raw = await redirect;
  guard();
  const { code } = parseDesktopRedirect(raw, state);
  return redeemAndCommit(deps, code, verifier, guard);
}

/** Shared tail: exchange the sealed code, verify on a throwaway client, commit. */
async function redeemAndCommit(
  deps: Pick<DesktopSignInDeps, "apiBase" | "postJson" | "verify" | "commit">,
  code: string,
  verifier: string,
  guard: () => void,
): Promise<{ secured: boolean }> {
  const res = await deps.postJson(new URL(AUXO_ID_DESKTOP_EXCHANGE_PATH, deps.apiBase).toString(), {
    code,
    verifier,
  });
  const handoff = parseExchangeResponse(res.ok, res.body);
  guard();
  // verifyOtp runs on a throwaway client, so a Cancel (or a password sign-in)
  // that lands while it is in flight leaves the shared session untouched.
  const tokens = await deps.verify(handoff);
  guard(); // last check before the shared Supabase session is replaced
  await deps.commit(tokens);
  return { secured: handoff.secured === true };
}

/** Side effects of the iPhone/iPad flow (see auxoIdDesktop.ts). */
export interface IosSignInDeps extends Pick<DesktopSignInDeps, "apiBase" | "postJson" | "verify" | "commit"> {
  /**
   * Open `url` in the in-app ASWebAuthenticationSession and resolve with the
   * lalela:// callback URL. Rejects with "cancelled" when the user closes the
   * sheet (or the app cancels it); any other rejection is a real failure.
   */
  authenticate(url: string): Promise<string>;
}

/** True for the native sheet's "user closed it" rejection (string or Error). */
export function isSheetCancelled(e: unknown): boolean {
  const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return msg === "cancelled";
}

/**
 * The whole iPhone/iPad sign-in: same state + verifier + exchange as the Mac,
 * but the hand-back arrives as the in-app sheet's callback URL. Closing the
 * sheet throws AuxoIdAttemptAbandoned (no error shown), like Cancel on the Mac.
 * Resolves `secured` exactly like runDesktopSignIn (same exchange response).
 */
export async function runIosSignIn(
  deps: IosSignInDeps,
  isCurrent: () => boolean,
): Promise<{ secured: boolean }> {
  const guard = () => {
    if (!isCurrent()) throw new AuxoIdAttemptAbandoned();
  };
  const state = newDesktopState();
  const verifier = newDesktopState();
  const challenge = await desktopChallenge(verifier);
  guard();
  let callback: string;
  try {
    callback = await deps.authenticate(iosStartUrl(deps.apiBase, state, challenge));
  } catch (e) {
    if (isSheetCancelled(e)) throw new AuxoIdAttemptAbandoned();
    throw new Error(AUXO_ID_ERROR_FALLBACK);
  }
  guard();
  const { code } = parseIosCallbackUrl(callback, state);
  return redeemAndCommit(deps, code, verifier, guard);
}
