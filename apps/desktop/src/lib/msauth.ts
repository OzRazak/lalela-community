// Microsoft account connection (Slice 9) — public-client OAuth 2.0
// authorization-code + PKCE against Entra ID, orchestrated entirely in the
// frontend: Microsoft Graph and the v2 token endpoint are called with plain
// fetch (Graph supports CORS for delegated public-client tokens). Rust
// contributes exactly two things: the localhost redirect listener
// (src-tauri/src/msoauth.rs) and Keychain custody of the refresh token
// (src-tauri/src/secrets.rs). There is no client secret anywhere — public
// client ids are not secrets.
//
// Strictly opt-in: nothing here runs unless the user clicks Connect in
// Settings → Connections, and the app behaves identically when disconnected.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_COMMUNITY, MS_CLIENT_ID, MS_INTEGRATION_AVAILABLE } from "@/lib/edition";

/** Entra app (client) id — a public identifier, safe to ship. Comes from the
 *  build-time `VITE_MS_CLIENT_ID` (edition/*.env); empty ⇒ the whole
 *  Microsoft integration is hidden (Community builds without their own app
 *  registration). */
export { MS_CLIENT_ID, MS_INTEGRATION_AVAILABLE };
export const MS_AUTHORITY = "https://login.microsoftonline.com/organizations";
export const MS_SCOPES =
  "offline_access User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All";

/** Keychain slot for the refresh token (macOS Keychain via secrets.rs). */
// Keyed on the bundle identifier so a Community build never shares a slot
// with the official app.
const KEYCHAIN_SERVICE = IS_COMMUNITY ? "io.github.ozrazak.lalela-community" : "digital.auxo.lalela";
const KEYCHAIN_ACCOUNT = "microsoft-refresh-token";

const KEYS = {
  account: "lalela.ms.account",
  importEnabled: "lalela.ms.import.enabled",
  importDays: "lalela.ms.import.days",
  importLastRun: "lalela.ms.import.lastRun",
  importOutcome: "lalela.ms.import.lastOutcome",
  comingUpDays: "lalela.comingup.days",
} as const;

/** Broadcast whenever a coming-up preference changes, so the Meetings rail
 * re-fetches live (localStorage's own `storage` event never fires in the
 * document that made the write). */
export const COMING_UP_CHANGED_EVENT = "lalela:comingup-days-changed";

// --- Connection state -------------------------------------------------------

export interface MsAccount {
  displayName: string;
  mail: string | null;
}

/** The connected account label, persisted at connect time. Null = not connected. */
export function connectedAccount(): MsAccount | null {
  const raw = localStorage.getItem(KEYS.account);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MsAccount;
  } catch {
    return null;
  }
}

export function isMsConnected(): boolean {
  return MS_INTEGRATION_AVAILABLE && connectedAccount() !== null;
}

// --- Preferences (Settings → Connections) -----------------------------------

/** Teams transcript import toggle — default ON once connected (opt-in happens
 * at Connect; this only tunes what the connection does). */
export function getMsImportEnabled(): boolean {
  const v = localStorage.getItem(KEYS.importEnabled);
  return v === null ? true : v === "true";
}
export function setMsImportEnabled(value: boolean): void {
  localStorage.setItem(KEYS.importEnabled, String(value));
}

export function getMsBackfillDays(): number {
  const n = Number(localStorage.getItem(KEYS.importDays));
  return Number.isFinite(n) && n > 0 ? n : 30;
}
export function setMsBackfillDays(days: number): void {
  localStorage.setItem(KEYS.importDays, String(days));
}

export function getMsImportLastRun(): number {
  const n = Number(localStorage.getItem(KEYS.importLastRun));
  return Number.isFinite(n) ? n : 0;
}
export function setMsImportLastRun(ms: number): void {
  localStorage.setItem(KEYS.importLastRun, String(ms));
}

// --- Last import outcome ------------------------------------------------------
// Imports run in the background, so a failure used to be invisible: the run
// stamped `importLastRun` and threw away everything else. Persisting HOW the
// last run ended is what lets Settings say "this stopped working, here's why"
// instead of quietly importing nothing for days.

/**
 * Why an import run failed, coarse enough to drive one sentence of guidance:
 * - `auth` — the Microsoft session is gone (401 / invalid_grant): reconnect.
 * - `forbidden` — Graph refused the transcript read (403): a tenant policy or
 *   consent problem, which the user cannot fix from inside Lalela.
 * - `transient` — network blip, throttling, Graph 5xx: retries on its own.
 */
export type MsImportErrorClass = "auth" | "forbidden" | "transient";

/** How the last Teams transcript import run ended. */
export interface MsImportOutcome {
  ok: boolean;
  /** When the run finished (epoch ms). */
  at: number;
  /** Distinct online meetings the run looked at. */
  scanned: number;
  /** Of `scanned`: meetings whose transcript list we actually read. */
  resolved: number;
  /** Of `scanned`: meetings Graph had no online meeting for (nothing to read). */
  unresolved: number;
  /** Of `scanned`: meetings Graph refused us at some step (403/5xx). */
  refused: number;
  imported: number;
  errorClass: MsImportErrorClass | null;
  /** Graph's machine-readable code, e.g. `GraphAccessToTranscriptsDisabled`. */
  code: string | null;
  /** Raw error text, kept for diagnosis (never the primary UI copy). */
  message: string | null;
}

export function getMsImportOutcome(): MsImportOutcome | null {
  const raw = localStorage.getItem(KEYS.importOutcome);
  if (!raw) return null;
  try {
    // Outcomes persisted before the per-step counters existed do not carry
    // them; default to 0 so Settings never renders `undefined`.
    const parsed = JSON.parse(raw) as MsImportOutcome;
    return {
      ...parsed,
      resolved: parsed.resolved ?? 0,
      unresolved: parsed.unresolved ?? 0,
      refused: parsed.refused ?? 0,
    };
  } catch {
    return null;
  }
}

export function setMsImportOutcome(outcome: MsImportOutcome): void {
  localStorage.setItem(KEYS.importOutcome, JSON.stringify(outcome));
}

/**
 * One actionable sentence for a failed run — what the user (or their admin)
 * has to do. The two tenant-policy codes get their own lines because they are
 * the failures Lalela can never recover from on its own, and because they look
 * identical from inside the app (403) while needing different admin switches.
 */
export function msImportFailureHint(outcome: MsImportOutcome): string {
  if (outcome.code === "GraphAccessToTranscriptsDisabled") {
    return (
      "Your Microsoft tenant is blocking transcript API access — an admin must enable " +
      "Transcript API access in the Teams admin center."
    );
  }
  if (outcome.code === "SpeakerAttributionNotAllowed") {
    return (
      "Your Microsoft tenant allows Lalela to see that transcripts exist but not to read " +
      "them: speaker-attributed transcript content is switched off. An admin must allow " +
      "speaker-attributed transcripts in the Teams admin center."
    );
  }
  switch (outcome.errorClass) {
    case "auth":
      return "Your Microsoft sign-in has expired. Disconnect and connect again to resume imports.";
    case "forbidden":
      return (
        "Microsoft refused access to your Teams transcripts. This usually needs a tenant " +
        "admin to grant Lalela permission to read meeting transcripts."
      );
    default:
      return "Couldn't reach Microsoft. Lalela will try again the next time it checks.";
  }
}

/** How far ahead the Meetings "Coming up" rail looks, in days. Default 1 (the
 * next 24h — Oz's C2 follow-up: a week was too much). Allowed: 1 / 3 / 7 / 14. */
export const COMING_UP_DAY_OPTIONS = [1, 3, 7, 14] as const;
export function getComingUpDays(): number {
  const n = Number(localStorage.getItem(KEYS.comingUpDays));
  return (COMING_UP_DAY_OPTIONS as readonly number[]).includes(n) ? n : 1;
}
export function setComingUpDays(days: number): void {
  localStorage.setItem(KEYS.comingUpDays, String(days));
  window.dispatchEvent(new CustomEvent(COMING_UP_CHANGED_EVENT));
}

// --- PKCE (crypto.subtle) ----------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

// --- Token plumbing ----------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Translate the AADSTS soup into something actionable. The redirect-URI
 * family means the Entra app registration is missing its desktop platform —
 * an ops step, not a user mistake. */
function friendlyAuthError(raw: string): string {
  if (/AADSTS(50011|500113|7000218|9002326)/.test(raw)) {
    return (
      "Microsoft rejected the sign-in redirect. The Entra app registration for Lalela " +
      'needs the "Mobile and desktop applications" platform with an http://localhost ' +
      'redirect URI and "Allow public client flows" enabled. (' +
      raw.slice(0, 300) +
      ")"
    );
  }
  return raw;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  // Via Rust, not fetch(): the webview forces `Origin: tauri://localhost`,
  // which Entra rejects for native clients (AADSTS9002326).
  const res = await invoke<{ status: number; body: string }>("ms_token_request", {
    url: `${MS_AUTHORITY}/oauth2/v2.0/token`,
    body: new URLSearchParams(params).toString(),
  });
  let json = {} as TokenResponse;
  try {
    json = JSON.parse(res.body) as TokenResponse;
  } catch {
    /* non-JSON error body — handled below */
  }
  if (res.status < 200 || res.status >= 300 || !json.access_token) {
    throw new Error(
      friendlyAuthError(
        json.error_description || json.error || `Microsoft token request failed (${res.status})`,
      ),
    );
  }
  return json;
}

// In-memory access token; the refresh token lives in the Keychain only.
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;

async function storeTokens(t: TokenResponse): Promise<void> {
  accessToken = t.access_token;
  accessTokenExpiresAt = Date.now() + (t.expires_in ?? 3600) * 1000;
  // Entra rotates refresh tokens — always persist the newest one.
  if (t.refresh_token) {
    await invoke("secret_set", {
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      value: t.refresh_token,
    });
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await invoke<string | null>("secret_get", {
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_ACCOUNT,
  }).catch(() => null);
  if (!refreshToken) return null;
  const tokens = await tokenRequest({
    client_id: MS_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MS_SCOPES,
  });
  await storeTokens(tokens);
  return tokens.access_token;
}

/**
 * A valid delegated access token, auto-refreshed from the Keychain refresh
 * token (single-flight — concurrent callers share one refresh). Null when no
 * account is connected. `force` skips the in-memory cache (401 retry path).
 */
export async function getAccessToken(force = false): Promise<string | null> {
  if (!force && accessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// --- Connect / disconnect ----------------------------------------------------

/**
 * The full connect flow: loopback listener → PKCE → default browser →
 * redirect → code-for-tokens exchange → refresh token into the Keychain →
 * Graph /me for the account label (persisted in localStorage).
 */
export async function connect(): Promise<MsAccount> {
  const port = await invoke<number>("oauth_loopback_listen", { portPreference: null });
  const redirectUri = `http://localhost:${port}`;
  const { verifier, challenge } = await pkcePair();
  const stateNonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  const url = new URL(`${MS_AUTHORITY}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", MS_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MS_SCOPES);
  url.searchParams.set("state", stateNonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  // Start waiting BEFORE opening the browser so the redirect can't race us.
  const redirect = invoke<string>("oauth_loopback_wait");
  try {
    await openUrl(url.toString());
  } catch (e) {
    await invoke("oauth_loopback_cancel").catch(() => {});
    throw e;
  }

  const query = new URLSearchParams(await redirect);
  const error = query.get("error");
  if (error) {
    throw new Error(friendlyAuthError(query.get("error_description") || error));
  }
  if (query.get("state") !== stateNonce) {
    throw new Error("Sign-in state mismatch — please try connecting again.");
  }
  const code = query.get("code");
  if (!code) throw new Error("The sign-in redirect carried no authorization code.");

  const tokens = await tokenRequest({
    client_id: MS_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: MS_SCOPES,
  });
  await storeTokens(tokens);

  // Resolve who connected (also proves the token works) and persist the label.
  const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!meRes.ok) throw new Error(`Connected, but reading your profile failed (${meRes.status}).`);
  const me = (await meRes.json()) as {
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const account: MsAccount = {
    displayName: me.displayName || me.userPrincipalName || "Microsoft account",
    mail: me.mail || me.userPrincipalName || null,
  };
  localStorage.setItem(KEYS.account, JSON.stringify(account));
  return account;
}

/** Forget everything: Keychain refresh token, in-memory tokens, account label. */
export async function disconnect(): Promise<void> {
  accessToken = null;
  accessTokenExpiresAt = 0;
  await invoke("secret_delete", {
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_ACCOUNT,
  }).catch(() => {});
  localStorage.removeItem(KEYS.account);
  localStorage.removeItem(KEYS.importLastRun);
  localStorage.removeItem(KEYS.importOutcome);
}
