// Unit tests for the error-report scrubber. Run from apps/desktop:
//   node --test scripts/errorScrub.test.mts
// (Node >= 22.18 strips TS types natively.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubText, scrubEvent, MAX_MESSAGE_LEN } from "../src/lib/errorScrub.ts";

test("strips macOS home + meeting folder paths, keeps safe basenames", () => {
  const s = scrubText(
    "failed to open /Users/jane/Documents/Lalela/Acme Board Review/2026-07-01 Q3 plan with Bob/summary.md: No such file",
  );
  assert.ok(!s.includes("jane"), s);
  assert.ok(!s.includes("Acme"), s);
  assert.ok(!s.includes("Bob"), s);
  assert.match(s, /<path>\/summary\.md: No such file/);
});

test("strips Windows user paths and drops user-named files", () => {
  const s = scrubText("cannot read C:\\Users\\John Smith\\Music\\Secret merger call.m4a (os error 5)");
  assert.ok(!s.includes("John"), s);
  assert.ok(!s.includes("merger"), s);
  assert.match(s, /<path> \(os error 5\)/);
});

test("keeps code locations in Rust panic lines but redacts quoted content", () => {
  const s = scrubText(
    "[1700000000] panic: byte index 5 is not a char boundary; it is inside 'é' (bytes 4..6) of `Hi Bob, about the layoffs` at src/transcribe.rs:212 (thread worker)",
  );
  assert.ok(!s.includes("layoffs"), s);
  assert.match(s, /src\/transcribe\.rs:212/);
});

test("absolute cargo registry path keeps the .rs basename and line", () => {
  const s = scrubText("panic at /Users/runner/.cargo/registry/src/foo-1.0/src/lib.rs:12:5");
  assert.equal(s, "panic at <path>/lib.rs:12:5");
});

test("URLs lose query strings; file:// URLs are redacted", () => {
  const s = scrubText("GET https://api.example.com/v1/x?token=abc#frag and file:///Users/a/b.txt");
  assert.match(s, /https:\/\/api\.example\.com\/v1\/x(?!\?)/);
  assert.ok(!s.includes("token=abc"), s);
  assert.ok(!s.includes("/Users/a"), s);
});

test("emails, api keys and long quoted strings are redacted", () => {
  const s = scrubText('user bob@acme.com key sk-or-v1-abcdef123456 said "this is a very long quoted sentence here"');
  assert.ok(!s.includes("bob@acme.com"));
  assert.ok(!s.includes("sk-or-v1"));
  assert.ok(!s.includes("very long quoted"));
});

test("ordinary words with slashes survive", () => {
  assert.equal(scrubText("read and/or write failed"), "read and/or write failed");
});

test("messages are truncated", () => {
  const s = scrubText("x".repeat(5000).replace(/x/g, "ab "));
  assert.ok(s.length <= MAX_MESSAGE_LEN + 1);
});

test("scrubEvent drops non-exception events", () => {
  assert.equal(scrubEvent({ event: "$pageview", properties: {} }), null);
  assert.equal(scrubEvent(null), null);
});

test("scrubEvent keeps only allowlisted props and scrubs frames", () => {
  const out = scrubEvent({
    event: "$exception",
    $set: { email: "a@b.c" },
    properties: {
      token: "phc_x",
      distinct_id: "anon",
      $current_url: "tauri://localhost/meetings/Acme",
      $pathname: "/meetings/Acme",
      meeting_title: "Acme merger",
      app_version: "1.3.7",
      $exception_list: [
        {
          type: "TypeError",
          value: "Cannot read /Users/jane/Notes/Acme.md",
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                filename: "tauri://localhost/assets/index-abc.js?v=1",
                function: "render",
                lineno: 1,
                colno: 2,
                context_line: "const title = 'Acme merger'",
                vars: { title: "Acme merger" },
              },
            ],
          },
        },
      ],
    },
  });
  assert.ok(out);
  const p = out!.properties;
  assert.equal(p.$current_url, undefined);
  assert.equal(p.$pathname, undefined);
  assert.equal(p.meeting_title, undefined);
  assert.equal(p.app_version, "1.3.7");
  assert.equal(p.$process_person_profile, false);
  assert.equal(out!.$set, undefined);
  const ex = (p.$exception_list as any[])[0];
  assert.equal(ex.value, "Cannot read <path>");
  const f = ex.stacktrace.frames[0];
  assert.equal(f.filename, "tauri://localhost/assets/index-abc.js");
  assert.equal(f.context_line, undefined);
  assert.equal(f.vars, undefined);
  assert.equal(f.lineno, 1);
  assert.ok(!JSON.stringify(out).includes("Acme"));
});
