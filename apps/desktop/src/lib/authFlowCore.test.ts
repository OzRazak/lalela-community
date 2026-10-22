import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySignInError,
  codeStepPrompt,
  invalidCredentialsMessage,
  normalizeOtp,
  resendSecondsLeft,
} from "./authFlowCore.ts";

test("classifySignInError prefers the Supabase error code", () => {
  assert.equal(classifySignInError({ code: "invalid_credentials", message: "x" }), "invalid_credentials");
  assert.equal(classifySignInError({ code: "email_not_confirmed", message: "x" }), "email_not_confirmed");
  assert.equal(classifySignInError({ code: "over_request_rate_limit", message: "slow down" }), "other");
});

test("classifySignInError falls back to the message text", () => {
  assert.equal(classifySignInError(new Error("Invalid login credentials")), "invalid_credentials");
  assert.equal(classifySignInError(new Error("Email not confirmed")), "email_not_confirmed");
  assert.equal(classifySignInError(new Error("Network down")), "other");
  for (const junk of [null, undefined, "str", 42, {}]) assert.equal(classifySignInError(junk), "other");
});

test("invalidCredentialsMessage omits the Auxo ID clause where the button is absent", () => {
  assert.match(invalidCredentialsMessage(true), /Signed up with Auxo ID\? Use Continue with Auxo ID/);
  assert.doesNotMatch(invalidCredentialsMessage(false), /Auxo ID/);
  assert.match(invalidCredentialsMessage(false), /^Wrong email or password\..*Forgot password/);
});

test("normalizeOtp accepts 6-8 digits, tolerating spaces and dashes", () => {
  assert.equal(normalizeOtp("123456"), "123456");
  assert.equal(normalizeOtp(" 123 456 "), "123456");
  assert.equal(normalizeOtp("123-456"), "123456");
  assert.equal(normalizeOtp("12345678"), "12345678");
  for (const bad of ["", "12345", "123456789", "12345a", "abcdef"]) assert.equal(normalizeOtp(bad), null, bad);
});

test("resendSecondsLeft counts down the cooldown", () => {
  assert.equal(resendSecondsLeft(null, 1000), 0);
  assert.equal(resendSecondsLeft(0, 0, 60), 60);
  assert.equal(resendSecondsLeft(0, 59_001, 60), 1);
  assert.equal(resendSecondsLeft(0, 60_000, 60), 0);
  assert.equal(resendSecondsLeft(0, 90_000, 60), 0);
});

test("codeStepPrompt names the address", () => {
  assert.equal(codeStepPrompt("a@b.co"), "Enter the 6-digit code we emailed to a@b.co.");
});
