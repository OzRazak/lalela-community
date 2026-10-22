import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AUXO_ID_ERROR_FALLBACK,
  AUXO_ID_IOS_CALLBACK,
  AuxoIdAttemptAbandoned,
  auxoIdErrorMessage,
  desktopChallenge,
  desktopStartUrl,
  iosStartUrl,
  isSheetCancelled,
  parseIosCallbackUrl,
  runIosSignIn,
  type IosSignInDeps,
  newDesktopState,
  parseDesktopRedirect,
  parseExchangeResponse,
  runDesktopSignIn,
  type DesktopHandoff,
  type DesktopSessionTokens,
  type DesktopSignInDeps,
} from "./auxoIdDesktopCore.ts";

const API = "https://lalela-app.auxodigital.africa";

test("newDesktopState is 43 URL-safe chars and unique", () => {
  const a = newDesktopState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newDesktopState());
});

test("desktopChallenge is base64url SHA-256, matching the server's pkceChallenge", async () => {
  const v = newDesktopState();
  assert.equal(await desktopChallenge(v), createHash("sha256").update(v).digest("base64url"));
});

test("desktopStartUrl targets the web desktop route with port, state and challenge", () => {
  const u = new URL(desktopStartUrl(API, 53682, "s".repeat(43), "c".repeat(43)));
  assert.equal(u.origin, API);
  assert.equal(u.pathname, "/api/auth/auxo-id/desktop");
  assert.equal(u.searchParams.get("port"), "53682");
  assert.equal(u.searchParams.get("state"), "s".repeat(43));
  assert.equal(u.searchParams.get("challenge"), "c".repeat(43));
});

test("parseDesktopRedirect returns the code for a matching state", () => {
  const state = newDesktopState();
  assert.deepEqual(parseDesktopRedirect(`code=sealed123&state=${state}`, state), { code: "sealed123" });
  assert.equal(parseDesktopRedirect(`?code=x&state=${state}`, state).code, "x");
});

test("parseDesktopRedirect rejects a foreign or missing state before anything else", () => {
  const state = newDesktopState();
  assert.throws(() => parseDesktopRedirect(`code=abc&state=other`, state), /state mismatch/);
  assert.throws(() => parseDesktopRedirect(`code=abc`, state), /state mismatch/);
  assert.throws(() => parseDesktopRedirect(`error=denied&state=other`, state), /state mismatch/);
  assert.throws(() => parseDesktopRedirect(`code=abc&state=`, ""), /state mismatch/);
});

test("parseDesktopRedirect surfaces server error codes as friendly copy", () => {
  const state = newDesktopState();
  assert.throws(() => parseDesktopRedirect(`error=denied&state=${state}`, state), {
    message: "Auxo ID sign-in was cancelled.",
  });
  assert.throws(() => parseDesktopRedirect(`error=__proto__&state=${state}`, state), {
    message: AUXO_ID_ERROR_FALLBACK,
  });
  assert.throws(() => parseDesktopRedirect(`state=${state}`, state), { message: AUXO_ID_ERROR_FALLBACK });
});

test("parseExchangeResponse accepts only an ok magic-link token_hash", () => {
  assert.deepEqual(parseExchangeResponse(true, { token_hash: "h", type: "magiclink" }), {
    tokenHash: "h",
    type: "magiclink",
  });
  for (const [ok, body] of [
    [false, { token_hash: "h", type: "magiclink" }],
    [true, { token_hash: "h", type: "signup" }],
    [true, { token_hash: "", type: "magiclink" }],
    [true, { error: "invalid_code" }],
    [true, null],
  ] as const) {
    assert.throws(() => parseExchangeResponse(ok, body), { message: AUXO_ID_ERROR_FALLBACK });
  }
});

test("parseExchangeResponse carries secured only when it is exactly true", () => {
  assert.deepEqual(parseExchangeResponse(true, { token_hash: "h", type: "magiclink", secured: true }), {
    tokenHash: "h",
    type: "magiclink",
    secured: true,
  });
  for (const secured of [false, "true", 1, null, undefined]) {
    assert.deepEqual(parseExchangeResponse(true, { token_hash: "h", type: "magiclink", secured }), {
      tokenHash: "h",
      type: "magiclink",
    });
  }
});

test("auxoIdErrorMessage maps known codes and falls back otherwise", () => {
  assert.equal(auxoIdErrorMessage("email_unverified"), "Verify your email in Auxo ID first, then try again.");
  assert.equal(auxoIdErrorMessage("constructor"), AUXO_ID_ERROR_FALLBACK);
});

// --- Orchestration --------------------------------------------------------

/** Fake deps: the "browser" echoes the state from the start URL back. */
function fakeDeps() {
  let resolveWait!: (q: string) => void;
  const calls: string[] = [];
  const redeemed: DesktopHandoff[] = [];
  const committed: DesktopSessionTokens[] = [];
  let startUrl = "";
  let posted: { code?: string; verifier?: string } = {};
  const deps: DesktopSignInDeps = {
    apiBase: API,
    listen: async () => (calls.push("listen"), 53682),
    wait: () => (calls.push("wait"), new Promise<string>((r) => (resolveWait = r))),
    cancel: async () => void calls.push("cancel"),
    openUrl: async (url) => void ((startUrl = url), calls.push("open")),
    postJson: async (url, body) => {
      calls.push(`post ${new URL(url).pathname}`);
      posted = body as typeof posted;
      return { ok: true, body: { token_hash: "hash123", type: "magiclink" } };
    },
    verify: async (h) => {
      redeemed.push(h);
      return { access_token: "at", refresh_token: "rt" };
    },
    commit: async (t) => void committed.push(t),
  };
  const browserReturns = () => {
    const state = new URL(startUrl).searchParams.get("state");
    resolveWait(`code=sealed&state=${state}`);
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { deps, calls, redeemed, committed, browserReturns, tick, posted: () => posted, startUrl: () => startUrl };
}

test("runDesktopSignIn: happy path exchanges code + verifier and redeems once", async () => {
  const f = fakeDeps();
  const run = runDesktopSignIn(f.deps, () => true);
  while (!f.calls.includes("open")) await f.tick();
  f.browserReturns();
  assert.deepEqual(await run, { secured: false });
  assert.deepEqual(f.redeemed, [{ tokenHash: "hash123", type: "magiclink" }]);
  assert.deepEqual(f.committed, [{ access_token: "at", refresh_token: "rt" }]);
  assert.deepEqual(f.calls, ["listen", "wait", "open", "post /api/auth/auxo-id/desktop/exchange"]);
  // The verifier sent to /exchange matches the challenge sent to /desktop.
  const challenge = new URL(f.startUrl()).searchParams.get("challenge");
  assert.equal(await desktopChallenge(f.posted().verifier!), challenge);
  assert.equal(f.posted().code, "sealed");
});

test("runDesktopSignIn: reports secured from the exchange response", async () => {
  const f = fakeDeps();
  f.deps.postJson = async () => ({ ok: true, body: { token_hash: "hash123", type: "magiclink", secured: true } });
  const run = runDesktopSignIn(f.deps, () => true);
  while (!f.calls.includes("open")) await f.tick();
  f.browserReturns();
  assert.deepEqual(await run, { secured: true });
});

test("runDesktopSignIn: a cancelled attempt never redeems, even if the browser completes later", async () => {
  const f = fakeDeps();
  let current = true;
  const run = runDesktopSignIn(f.deps, () => current);
  while (!f.calls.includes("open")) await f.tick();
  current = false; // user pressed Cancel (then maybe signed in with a password)
  f.browserReturns(); // late redirect from the abandoned browser tab
  await assert.rejects(run, AuxoIdAttemptAbandoned);
  assert.deepEqual(f.redeemed, []);
  assert.equal(f.calls.some((c) => c.startsWith("post")), false);
});

test("runDesktopSignIn: cancelling during the exchange still blocks the redeem", async () => {
  const f = fakeDeps();
  let current = true;
  const post = f.deps.postJson;
  f.deps.postJson = async (url, body) => {
    const r = await post(url, body);
    current = false; // Cancel lands while the exchange is in flight
    return r;
  };
  const run = runDesktopSignIn(f.deps, () => current);
  while (!f.calls.includes("open")) await f.tick();
  f.browserReturns();
  await assert.rejects(run, AuxoIdAttemptAbandoned);
  assert.deepEqual(f.redeemed, []);
});

test("runDesktopSignIn: a browser that fails to open cancels the listener", async () => {
  const f = fakeDeps();
  f.deps.openUrl = async () => {
    throw new Error("no browser");
  };
  await assert.rejects(runDesktopSignIn(f.deps, () => true), /no browser/);
  assert.ok(f.calls.includes("cancel"));
  assert.deepEqual(f.redeemed, []);
});

test("runDesktopSignIn: a cancel that lands during verifyOtp never installs the session", async () => {
  const f = fakeDeps();
  let current = true;
  const verify = f.deps.verify;
  f.deps.verify = async (h) => {
    const t = await verify(h);
    current = false; // Cancel / password sign-in while verifyOtp is in flight
    return t;
  };
  const run = runDesktopSignIn(f.deps, () => current);
  while (!f.calls.includes("open")) await f.tick();
  f.browserReturns();
  await assert.rejects(run, AuxoIdAttemptAbandoned);
  assert.equal(f.redeemed.length, 1, "verify ran on the throwaway client");
  assert.deepEqual(f.committed, [], "shared session untouched");
});

// --- iPhone / iPad (in-app ASWebAuthenticationSession) ----------------------

const ST = "s".repeat(43);

test("iosStartUrl asks the web desktop route for return=ios, with no port", () => {
  const u = new URL(iosStartUrl(API, ST, "c".repeat(43)));
  assert.equal(u.origin, API);
  assert.equal(u.pathname, "/api/auth/auxo-id/desktop");
  assert.equal(u.searchParams.get("return"), "ios");
  assert.equal(u.searchParams.get("port"), null);
  assert.equal(u.searchParams.get("state"), ST);
  assert.equal(u.searchParams.get("challenge"), "c".repeat(43));
});

test("parseIosCallbackUrl accepts exactly lalela://auxo-id with a matching state", () => {
  assert.equal(AUXO_ID_IOS_CALLBACK, "lalela://auxo-id");
  assert.deepEqual(parseIosCallbackUrl(`lalela://auxo-id?code=abc&state=${ST}`, ST), { code: "abc" });
  assert.deepEqual(parseIosCallbackUrl(`lalela://auxo-id/?state=${ST}&code=abc`, ST), { code: "abc" });
  assert.deepEqual(parseIosCallbackUrl(`lalela://auxo-id?code=abc&state=${ST}#frag`, ST), { code: "abc" });
});

test("parseIosCallbackUrl rejects other schemes, hosts and paths before reading the query", () => {
  for (const url of [
    `https://auxo-id?code=abc&state=${ST}`,
    `lalela://evil?code=abc&state=${ST}`,
    `lalela://auxo-id.evil?code=abc&state=${ST}`,
    `lalela://auxo-id/other?code=abc&state=${ST}`,
    `lalelax://auxo-id?code=abc&state=${ST}`,
    `xlalela://auxo-id?code=abc&state=${ST}`,
    `LALELA://auxo-id?code=abc&state=${ST}`,
    "lalela://auxo-id",
    "",
  ]) {
    assert.throws(() => parseIosCallbackUrl(url, ST), (e: Error) => e.message === AUXO_ID_ERROR_FALLBACK, url);
  }
});

test("parseIosCallbackUrl checks state first, then surfaces server errors", () => {
  assert.throws(() => parseIosCallbackUrl(`lalela://auxo-id?code=abc&state=${"x".repeat(43)}`, ST), /state mismatch/);
  assert.throws(() => parseIosCallbackUrl(`lalela://auxo-id?error=denied&state=${"x".repeat(43)}`, ST), /state mismatch/);
  assert.throws(() => parseIosCallbackUrl(`lalela://auxo-id?error=denied&state=${ST}`, ST), /cancelled/);
  assert.throws(() => parseIosCallbackUrl(`lalela://auxo-id?state=${ST}`, ST), (e: Error) => e.message === AUXO_ID_ERROR_FALLBACK);
});

test("isSheetCancelled matches only the native cancel code", () => {
  assert.equal(isSheetCancelled("cancelled"), true);
  assert.equal(isSheetCancelled(new Error("cancelled")), true);
  assert.equal(isSheetCancelled("failed: boom"), false);
  assert.equal(isSheetCancelled("busy"), false);
  assert.equal(isSheetCancelled(undefined), false);
});

function fakeIosDeps(sheet: (url: string) => Promise<string>) {
  const redeemed: DesktopHandoff[] = [];
  const committed: DesktopSessionTokens[] = [];
  let startUrl = "";
  let posted: { code?: string; verifier?: string } = {};
  const deps: IosSignInDeps = {
    apiBase: API,
    authenticate: async (url) => {
      startUrl = url;
      return sheet(url);
    },
    postJson: async (_url, body) => {
      posted = body as typeof posted;
      return { ok: true, body: { token_hash: "hash123", type: "magiclink" } };
    },
    verify: async (h) => {
      redeemed.push(h);
      return { access_token: "at", refresh_token: "rt" };
    },
    commit: async (t) => void committed.push(t),
  };
  return { deps, redeemed, committed, startUrl: () => startUrl, posted: () => posted };
}

const echoState = async (url: string) =>
  `lalela://auxo-id?code=sealed&state=${new URL(url).searchParams.get("state")}`;

test("runIosSignIn: happy path exchanges code + verifier and installs the session", async () => {
  const f = fakeIosDeps(echoState);
  await runIosSignIn(f.deps, () => true);
  assert.deepEqual(f.committed, [{ access_token: "at", refresh_token: "rt" }]);
  assert.equal(f.posted().code, "sealed");
  const challenge = new URL(f.startUrl()).searchParams.get("challenge");
  assert.equal(await desktopChallenge(f.posted().verifier!), challenge);
});

test("runIosSignIn: closing the sheet is a silent abandon, never a redeem", async () => {
  const f = fakeIosDeps(async () => {
    throw "cancelled";
  });
  await assert.rejects(runIosSignIn(f.deps, () => true), AuxoIdAttemptAbandoned);
  assert.deepEqual(f.redeemed, []);
});

test("runIosSignIn: a native failure shows the generic message", async () => {
  const f = fakeIosDeps(async () => {
    throw "failed: something internal";
  });
  await assert.rejects(runIosSignIn(f.deps, () => true), (e: Error) => e.message === AUXO_ID_ERROR_FALLBACK);
});

test("runIosSignIn: a foreign state or a cancel during the round trip never redeems", async () => {
  const foreign = fakeIosDeps(async () => `lalela://auxo-id?code=sealed&state=${"x".repeat(43)}`);
  await assert.rejects(runIosSignIn(foreign.deps, () => true), /state mismatch/);
  assert.deepEqual(foreign.redeemed, []);

  let current = true;
  const late = fakeIosDeps(async (url) => {
    current = false; // app-side Cancel while the sheet was up
    return echoState(url);
  });
  await assert.rejects(runIosSignIn(late.deps, () => current), AuxoIdAttemptAbandoned);
  assert.deepEqual(late.redeemed, []);
  assert.deepEqual(late.committed, []);
});

test("runIosSignIn: the exchange's secured flag reaches the caller (same notice as the Mac)", async () => {
  const f = fakeIosDeps(echoState);
  assert.deepEqual(await runIosSignIn(f.deps, () => true), { secured: false });
  const s = fakeIosDeps(echoState);
  s.deps.postJson = async () => ({ ok: true, body: { token_hash: "hash123", type: "magiclink", secured: true } });
  assert.deepEqual(await runIosSignIn(s.deps, () => true), { secured: true });
  assert.equal(s.committed.length, 1);
});
