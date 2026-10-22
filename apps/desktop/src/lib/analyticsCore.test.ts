// Unit tests for the usage-analytics allowlist + router. Run with
// `pnpm --filter @lalela/desktop test` (Node's built-in runner; Node ≥ 22.18
// strips the TypeScript types natively — analyticsCore.ts has no imports).
import assert from "node:assert/strict";
import test from "node:test";

import {
  countBucket,
  durationBucket,
  EVENTS,
  importFormat,
  isInternalEmail,
  modelFamily,
  routeUsageEvent,
  sanitizeProps,
  type RouteState,
  type RoutableEvent,
} from "./analyticsCore.ts";

const ON: RouteState = {
  usageOn: true,
  crashOn: false,
  installId: "install-1",
  launchId: "launch-1",
  userId: null,
};

function ev(event: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}): RoutableEvent {
  return { event, properties, ...extra };
}

test("unknown events and PostHog defaults are dropped", () => {
  for (const name of ["$pageview", "$autocapture", "$pageleave", "$opt_in", "$set", "random_event"]) {
    assert.equal(routeUsageEvent(ev(name, { token: "t" }), ON), null, name);
  }
});

test("nothing is sent when usage data is off", () => {
  assert.equal(routeUsageEvent(ev("app_opened", { first_run: true }), { ...ON, usageOn: false }), null);
  assert.equal(
    routeUsageEvent(ev("$identify", {}), { ...ON, usageOn: false, userId: "u1" }),
    null,
  );
});

test("free text can never ride along in a string property", () => {
  const out = sanitizeProps("meeting_imported", {
    connector: "Acme board review.vtt",
    format: "vtt",
    title: "Q3 layoffs with Bob",
  });
  assert.deepEqual(out, { format: "vtt" });
});

test("wrong types are dropped; enums, booleans and counts pass", () => {
  assert.deepEqual(
    sanitizeProps("recording_started", {
      mode: "memo",
      system_audio: "yes",
      transcription: "local",
      engine: "whisper",
    }),
    { mode: "memo", transcription: "local", engine: "whisper" },
  );
  assert.deepEqual(sanitizeProps("app_opened", { previous_version: "1.3.7", first_run: false }), {
    previous_version: "1.3.7",
    first_run: false,
  });
  assert.deepEqual(sanitizeProps("app_opened", { previous_version: "/Users/jane/x" }), {});
});

test("router keeps only plumbing, super props and event props", () => {
  const out = routeUsageEvent(
    ev("nav_view", {
      view: "chat",
      token: "phc_x",
      distinct_id: "posthog-generated",
      $current_url: "tauri://localhost/meetings/abc",
      $pathname: "/meetings/abc",
      $referrer: "x",
      $screen_width: 1200,
      $os: "Mac OS X",
      app: "lalela-desktop",
      app_version: "1.3.8",
      platform: "macos",
      plan: "pro",
      meeting_title: "Secret",
    }),
    ON,
  )!;
  assert.deepEqual(Object.keys(out.properties).sort(), [
    "$os",
    "$process_person_profile",
    "app",
    "app_version",
    "distinct_id",
    "plan",
    "platform",
    "token",
    "view",
  ]);
  assert.equal(out.properties.distinct_id, "install-1");
  assert.equal(out.properties.$process_person_profile, false);
});

test("signed-in events use the Supabase user id and build a person profile", () => {
  const out = routeUsageEvent(ev("nav_view", { view: "tasks" }, { $set: { email: "a@b.c" } }), {
    ...ON,
    userId: "user-uuid",
  })!;
  assert.equal(out.properties.distinct_id, "user-uuid");
  assert.equal(out.properties.$process_person_profile, true);
  assert.equal(out.$set, undefined);
});

test("$identify links install → user and only sets is_internal", () => {
  const s = { ...ON, userId: "user-uuid" };
  const out = routeUsageEvent(
    ev("$identify", { token: "t" }, { $set: { is_internal: true, email: "thandi@auxo.digital", name: "Thandi" } }),
    s,
  )!;
  assert.equal(out.properties.distinct_id, "user-uuid");
  assert.equal(out.properties.$anon_distinct_id, "install-1");
  assert.deepEqual(out.$set, { is_internal: true });
  assert.equal(routeUsageEvent(ev("$identify", {}), ON), null, "never identify when signed out");
});

test("every event spec only uses closed lists or primitive kinds", () => {
  for (const [name, spec] of Object.entries(EVENTS)) {
    for (const [k, v] of Object.entries(spec)) {
      assert.ok(
        Array.isArray(v) || v === "boolean" || v === "count" || v === "version",
        `${name}.${k}`,
      );
    }
  }
});

test("buckets and mappers", () => {
  assert.equal(durationBucket(30_000), "<1m");
  assert.equal(durationBucket(10 * 60_000), "5-15m");
  assert.equal(durationBucket(2 * 3600_000), "60m+");
  assert.equal(countBucket(0), "0");
  assert.equal(countBucket(4), "2-5");
  assert.equal(countBucket(500), "100+");
  assert.equal(modelFamily("anthropic/claude-sonnet-4.5"), "claude");
  assert.equal(modelFamily("granite-3.3-2b-instruct-Q4_K_M.gguf"), "granite");
  assert.equal(modelFamily("my-weird-model"), "other");
  assert.equal(importFormat(".VTT"), "vtt");
  assert.equal(importFormat("Board minutes.xlsx"), "other");
  assert.equal(isInternalEmail("thandi@auxo.digital"), true);
  assert.equal(isInternalEmail("someone@gmail.com"), false);
});
