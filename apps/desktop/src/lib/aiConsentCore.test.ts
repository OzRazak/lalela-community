import assert from "node:assert/strict";
import test from "node:test";

import {
  AiConsentError,
  consentDecision,
  isAiConsentError,
  isCloudAiRoute,
  parseConsent,
} from "./aiConsentCore.ts";

test("only the free proxy and BYOK lanes are third-party AI", () => {
  assert.equal(isCloudAiRoute("free"), true);
  assert.equal(isCloudAiRoute("byok"), true);
  for (const r of ["local", "apple", "none", ""]) assert.equal(isCloudAiRoute(r), false);
});

test("on-device lanes never ask, even when required and refused", () => {
  for (const r of ["local", "apple"]) {
    assert.equal(consentDecision(r, true, null), "allow");
    assert.equal(consentDecision(r, true, "denied"), "allow");
  }
});

test("builds that don't enforce the gate allow everything", () => {
  assert.equal(consentDecision("free", false, null), "allow");
  assert.equal(consentDecision("byok", false, "denied"), "allow");
});

test("enforced: never asked → ask, granted → allow, denied → block", () => {
  for (const r of ["free", "byok"]) {
    assert.equal(consentDecision(r, true, null), "ask");
    assert.equal(consentDecision(r, true, "granted"), "allow");
    assert.equal(consentDecision(r, true, "denied"), "block");
  }
});

test("unknown stored values count as never asked", () => {
  assert.equal(parseConsent(null), null);
  assert.equal(parseConsent("yes"), null);
  assert.equal(parseConsent("granted"), "granted");
  assert.equal(parseConsent("denied"), "denied");
});

test("the refusal error tells the user how to turn it back on", () => {
  const e = new AiConsentError();
  assert.equal(e.name, "AiConsentError");
  assert.match(e.message, /Settings/);
  assert.match(e.message, /on-device/);
});

test("background generations never ask: unanswered → skip, answers still apply", () => {
  for (const r of ["free", "byok"]) {
    assert.equal(consentDecision(r, true, null, "background"), "skip");
    assert.equal(consentDecision(r, true, "granted", "background"), "allow");
    assert.equal(consentDecision(r, true, "denied", "background"), "block");
  }
});

test("user-started generations ask while unanswered (the default mode)", () => {
  for (const r of ["free", "byok"]) {
    assert.equal(consentDecision(r, true, null, "interactive"), "ask");
    assert.equal(consentDecision(r, true, null), "ask");
  }
});

test("on-device lanes never need consent in the background either", () => {
  for (const r of ["local", "apple"]) {
    for (const c of [null, "denied", "granted"] as const) {
      assert.equal(consentDecision(r, true, c, "background"), "allow");
    }
  }
});

test("BYOK is third-party AI: gated exactly like the free proxy", () => {
  for (const c of [null, "denied", "granted"] as const) {
    for (const m of ["interactive", "background"] as const) {
      assert.equal(consentDecision("byok", true, c, m), consentDecision("free", true, c, m));
    }
  }
});

test("the skip error is a consent error with a reason, and says how to allow it", () => {
  const skip = new AiConsentError("undecided");
  assert.equal(skip.reason, "undecided");
  assert.equal(isAiConsentError(skip), true);
  assert.match(skip.message, /permission/);
  assert.match(skip.message, /Settings/);
  assert.equal(new AiConsentError().reason, "denied");
  assert.equal(isAiConsentError(new Error("x")), false);
});

test("consent copy never names one platform's hardware", () => {
  for (const e of [new AiConsentError(), new AiConsentError("undecided")]) {
    assert.doesNotMatch(e.message, /iPhone|iPad|\bMac\b|Windows|\bPC\b/);
  }
});
