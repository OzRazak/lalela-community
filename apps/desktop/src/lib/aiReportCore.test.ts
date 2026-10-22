// Unit tests for the Report-AI-content core. Run with
// `node --test src/lib/aiReportCore.test.ts` (aiReportCore.ts has no imports).
import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_REPORT_CATEGORIES,
  AI_REPORT_SURFACES,
  AI_REPORT_COMMENT_CAP,
  AI_REPORT_MAILTO_OUTPUT_CAP,
  AI_REPORT_OUTPUT_CAP,
  AI_REPORT_SUPPORT_EMAIL,
  buildAiReportMailto,
  buildAiReportPayload,
  platformFromUserAgent,
  validateAiReportPayload,
  type AiReportInput,
} from "./aiReportCore.ts";

const base: AiReportInput = {
  category: "harmful",
  comment: "  this is wrong  ",
  surface: "summary",
  includeOutput: true,
  output: "Some AI text",
  model: "claude-haiku-4-5",
  route: "free",
  appVersion: "1.3.10",
  platform: "windows",
  client: "desktop",
};

test("payload carries the output only when opted in", () => {
  const on = buildAiReportPayload(base);
  assert.equal(on.output, "Some AI text");
  assert.equal(on.output_included, true);
  assert.equal(on.comment, "this is wrong");
  const off = buildAiReportPayload({ ...base, includeOutput: false });
  assert.equal(off.output, null);
  assert.equal(off.output_included, false);
  assert.equal(off.output_truncated, false);
});

test("payload caps output and comment", () => {
  const p = buildAiReportPayload({
    ...base,
    output: "x".repeat(AI_REPORT_OUTPUT_CAP + 50),
    comment: "y".repeat(AI_REPORT_COMMENT_CAP + 5),
  });
  assert.equal(p.output?.length, AI_REPORT_OUTPUT_CAP);
  assert.equal(p.output_truncated, true);
  assert.equal(p.comment?.length, AI_REPORT_COMMENT_CAP);
});

test("payload normalizes unknown routes and empty fields", () => {
  const p = buildAiReportPayload({ ...base, route: "weird", model: "  ", comment: "", output: "  " });
  assert.equal(p.ai_route, "unknown");
  assert.equal(p.model, null);
  assert.equal(p.comment, null);
  assert.equal(p.output, null);
  assert.equal(p.output_included, false);
});

test("payload never carries a user id", () => {
  assert.equal("user_id" in buildAiReportPayload(base), false);
});

test("validator accepts a built payload round-trip", () => {
  const p = buildAiReportPayload(base);
  const v = validateAiReportPayload(JSON.parse(JSON.stringify(p)));
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.value, p);
});

test("validator rejects bad enums, types and oversize text", () => {
  const p = buildAiReportPayload(base);
  assert.equal(validateAiReportPayload(null).ok, false);
  assert.equal(validateAiReportPayload([]).ok, false);
  assert.equal(validateAiReportPayload({ ...p, category: "spam" }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, surface: "elsewhere" }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, platform: "beos" }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, client: "cli" }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, comment: 5 }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, output: { a: 1 } }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, output: "z".repeat(AI_REPORT_OUTPUT_CAP + 1) }).ok, false);
  assert.equal(validateAiReportPayload({ ...p, comment: "z".repeat(AI_REPORT_COMMENT_CAP + 1) }).ok, false);
});

test("validator ignores a smuggled user_id and strips control chars", () => {
  const v = validateAiReportPayload({ ...buildAiReportPayload(base), user_id: "x", model: "a\u0000b" });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal("user_id" in v.value, false);
    assert.equal(v.value.model, "ab");
  }
});

test("mailto fallback targets support and shortens the output", () => {
  const p = buildAiReportPayload({ ...base, output: "o".repeat(5000) });
  const url = buildAiReportMailto(p);
  assert.ok(url.startsWith(`mailto:${AI_REPORT_SUPPORT_EMAIL}?subject=`));
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(body.includes("Category: Harmful or offensive"));
  assert.ok(body.includes("[…shortened]"));
  assert.ok(!body.includes("o".repeat(AI_REPORT_MAILTO_OUTPUT_CAP + 1)));
  const none = decodeURIComponent(buildAiReportMailto(buildAiReportPayload({ ...base, includeOutput: false })).split("&body=")[1]);
  assert.ok(!none.includes("AI output:"));
});

test("analytics taxonomy mirrors the report categories and surfaces", async () => {
  const { EVENTS } = await import("./analyticsCore.ts");
  assert.deepEqual([...EVENTS.ai_content_reported.category], AI_REPORT_CATEGORIES.map((c) => c.id));
  assert.deepEqual([...EVENTS.ai_content_reported.surface], [...AI_REPORT_SURFACES]);
});

test("caps never split a surrogate pair (emoji straddling each cap)", () => {
  const emoji = "\u{1F600}";
  // Output cap: emoji starts at index cap-1, so a naive slice would halve it.
  const p = buildAiReportPayload({ ...base, output: "a".repeat(AI_REPORT_OUTPUT_CAP - 1) + emoji + "tail" });
  assert.equal(p.output_truncated, true);
  assert.equal(p.output, "a".repeat(AI_REPORT_OUTPUT_CAP - 1));
  assert.doesNotThrow(() => encodeURIComponent(p.output!));
  // Comment cap.
  const c = buildAiReportPayload({ ...base, comment: "b".repeat(AI_REPORT_COMMENT_CAP - 1) + emoji + "x" });
  assert.equal(c.comment, "b".repeat(AI_REPORT_COMMENT_CAP - 1));
  // An emoji that fits wholly before the cap is kept.
  const k = buildAiReportPayload({ ...base, output: "a".repeat(AI_REPORT_OUTPUT_CAP - 2) + emoji + "zz" });
  assert.ok(k.output!.endsWith(emoji));
  assert.equal(k.output!.length, AI_REPORT_OUTPUT_CAP);
});

test("mailto never throws at the mailto output cap or on lone surrogates", () => {
  const emoji = "\u{1F600}";
  const p = buildAiReportPayload({ ...base, output: "a".repeat(AI_REPORT_MAILTO_OUTPUT_CAP - 1) + emoji + "more" });
  let url = "";
  assert.doesNotThrow(() => (url = buildAiReportMailto(p)));
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(body.includes("a".repeat(AI_REPORT_MAILTO_OUTPUT_CAP - 1)));
  assert.ok(!body.includes("\uFFFD"));
  // A lone surrogate smuggled into a payload is replaced, not thrown on.
  const bad = { ...p, comment: "x\uD83D", output: "\uDE00y" };
  assert.doesNotThrow(() => buildAiReportMailto(bad));
  const v = validateAiReportPayload({ ...p, comment: "x\uD83D" });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.value.comment, "x\uFFFD");
});

test("platform detection", () => {
  assert.equal(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "desktop"), "windows");
  assert.equal(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "desktop"), "macos");
  assert.equal(platformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "desktop"), "ios");
  assert.equal(platformFromUserAgent("anything", "web"), "web");
});
