// Unit tests for folder-automation schedule maths: due-ness, period keys,
// catch-up, windows, time zones and DST. Run with `pnpm --filter
// @lalela/desktop test` (Node's built-in runner strips the TS types natively —
// folderRulesCore.ts has no imports). Every test pins an explicit IANA zone,
// so results don't depend on the machine's zone.
import assert from "node:assert/strict";
import test from "node:test";

import {
  actionScope,
  automationItemStatus,
  folderRuleAiModels,
  createRuleGate,
  runVerdict,
  stillDue,
  defaultFolderRuleConfig,
  describeSchedule,
  dueCheck,
  latestOccurrence,
  nextOccurrence,
  parseFolderRuleConfig,
  periodKey,
  selectWindow,
  shiftPeriod,
  wallClock,
  windowStart,
  zonedTimeToUtc,
  type FolderSchedule,
} from "./folderRulesCore.ts";

const iso = (s: string) => Date.parse(s);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const weekly = (tz: string, dow = 1, time = "08:00"): FolderSchedule => ({
  cadence: "weekly",
  time,
  day_of_week: dow,
  day_of_month: 1,
  tz,
});
const daily = (tz: string, time = "08:00"): FolderSchedule => ({
  cadence: "daily",
  time,
  day_of_week: 1,
  day_of_month: 1,
  tz,
});
const monthly = (tz: string, dom: number, time = "09:00"): FolderSchedule => ({
  cadence: "monthly",
  time,
  day_of_week: 1,
  day_of_month: dom,
  tz,
});

test("weekly: latest occurrence is this Monday 08:00 local, or last week's before it", () => {
  const s = weekly("Africa/Johannesburg"); // UTC+2, no DST
  // Wed 2026-10-07 12:00 SAST → Mon 2026-10-05 08:00 SAST = 06:00Z
  assert.equal(latestOccurrence(s, iso("2026-10-07T10:00:00Z")), iso("2026-10-05T06:00:00Z"));
  // Mon 07:59 SAST → still last Monday
  assert.equal(latestOccurrence(s, iso("2026-10-05T05:59:00Z")), iso("2026-09-28T06:00:00Z"));
  // Exactly at the time counts
  assert.equal(latestOccurrence(s, iso("2026-10-05T06:00:00Z")), iso("2026-10-05T06:00:00Z"));
  assert.equal(nextOccurrence(s, iso("2026-10-05T06:00:00Z")), iso("2026-10-12T06:00:00Z"));
  assert.equal(nextOccurrence(s, iso("2026-10-05T05:00:00Z")), iso("2026-10-05T06:00:00Z"));
});

test("the local weekday is used, not the UTC one", () => {
  // Sunday 23:30 in Los Angeles is Monday 06:30Z. A Monday-08:00-LA rule is
  // NOT due yet: its latest occurrence is the previous Monday.
  const s = weekly("America/Los_Angeles");
  const now = iso("2026-10-05T06:30:00Z"); // Sun 4 Oct 23:30 PDT
  assert.equal(wallClock(now, s.tz).weekday, 0);
  assert.equal(latestOccurrence(s, now), iso("2026-09-28T15:00:00Z")); // Mon 28 Sep 08:00 PDT
});

test("DST end (Europe/London): the Monday after fall-back still runs at 08:00 local", () => {
  const s = weekly("Europe/London");
  // BST on Mon 19 Oct (UTC+1), GMT on Mon 26 Oct (clocks went back 25 Oct).
  assert.equal(latestOccurrence(s, iso("2026-10-20T12:00:00Z")), iso("2026-10-19T07:00:00Z"));
  assert.equal(latestOccurrence(s, iso("2026-10-27T12:00:00Z")), iso("2026-10-26T08:00:00Z"));
  assert.equal(nextOccurrence(s, iso("2026-10-20T12:00:00Z")), iso("2026-10-26T08:00:00Z"));
  // Exactly one week of wall clock = 7 days + 1 hour of real time.
  assert.equal(iso("2026-10-26T08:00:00Z") - iso("2026-10-19T07:00:00Z"), 7 * DAY + HOUR);
});

test("DST start (America/New_York): daily 08:00 stays 08:00 local across the jump", () => {
  const s = daily("America/New_York");
  assert.equal(latestOccurrence(s, iso("2026-03-07T20:00:00Z")), iso("2026-03-07T13:00:00Z")); // EST
  assert.equal(latestOccurrence(s, iso("2026-03-08T20:00:00Z")), iso("2026-03-08T12:00:00Z")); // EDT
});

test("a time skipped by spring-forward runs once, shifted forward by the gap", () => {
  const s = daily("America/New_York", "02:30"); // 02:30 doesn't exist on 8 Mar 2026
  const occ = latestOccurrence(s, iso("2026-03-08T18:00:00Z"));
  assert.equal(occ, iso("2026-03-08T07:30:00Z")); // 03:30 EDT
  assert.equal(periodKey(s, occ), "daily:2026-03-08");
  // The day before and after are normal 02:30s.
  assert.equal(latestOccurrence(s, iso("2026-03-07T18:00:00Z")), iso("2026-03-07T07:30:00Z"));
  assert.equal(latestOccurrence(s, iso("2026-03-09T18:00:00Z")), iso("2026-03-09T06:30:00Z"));
  // London's gap (01:00 → 02:00 on 29 Mar) shifts 01:30 to 02:30 BST.
  assert.equal(zonedTimeToUtc(2026, 3, 29, 1, 30, "Europe/London"), iso("2026-03-29T01:30:00Z"));
});

test("a time repeated by fall-back resolves to a single instant and a single period", () => {
  const s = daily("America/New_York", "01:30"); // 01:30 happens twice on 1 Nov 2026
  const now = iso("2026-11-01T18:00:00Z");
  const occ = latestOccurrence(s, now);
  assert.ok(
    occ === iso("2026-11-01T05:30:00Z") || occ === iso("2026-11-01T06:30:00Z"),
    `unexpected instant ${new Date(occ).toISOString()}`,
  );
  assert.equal(periodKey(s, occ), "daily:2026-11-01");
  // Both real instants fall in the same period, so the ledger runs it once.
  const rule = { enabled: true, last_period: "daily:2026-11-01", updated_at: 0 };
  assert.equal(dueCheck(rule, s, iso("2026-11-01T06:45:00Z")).due, false);
  const ld = daily("Europe/London", "01:30"); // 01:30 twice on 25 Oct 2026
  assert.equal(periodKey(ld, latestOccurrence(ld, iso("2026-10-25T12:00:00Z"))), "daily:2026-10-25");
});

test("monthly: clamps to the last day of short months", () => {
  const s = monthly("Africa/Johannesburg", 31);
  // 30 Sep is the last day of September.
  assert.equal(latestOccurrence(s, iso("2026-10-05T10:00:00Z")), iso("2026-09-30T07:00:00Z"));
  assert.equal(nextOccurrence(s, iso("2026-10-05T10:00:00Z")), iso("2026-10-31T07:00:00Z"));
  // February in a non-leap year.
  assert.equal(nextOccurrence(s, iso("2027-02-01T00:00:00Z")), iso("2027-02-28T07:00:00Z"));
  const first = monthly("Africa/Johannesburg", 1);
  assert.equal(latestOccurrence(first, iso("2026-10-01T06:00:00Z")), iso("2026-09-01T07:00:00Z"));
  assert.equal(latestOccurrence(first, iso("2026-10-01T07:00:00Z")), iso("2026-10-01T07:00:00Z"));
  // Year rollover.
  assert.equal(latestOccurrence(first, iso("2027-01-01T06:00:00Z")), iso("2026-12-01T07:00:00Z"));
});

test("dueCheck: due once per period, and a period already run is not due", () => {
  const s = weekly("Africa/Johannesburg");
  const fresh = { enabled: true, last_period: null, updated_at: iso("2026-09-01T00:00:00Z") };
  const now = iso("2026-10-05T07:00:00Z"); // Mon 09:00 SAST
  const d = dueCheck(fresh, s, now);
  assert.equal(d.due, true);
  assert.equal(d.periodKey, "weekly:2026-10-05");
  assert.equal(d.occurrence, iso("2026-10-05T06:00:00Z"));
  assert.equal(dueCheck({ ...fresh, last_period: d.periodKey }, s, now).due, false);
  assert.equal(dueCheck({ ...fresh, enabled: false }, s, now).due, false);
});

test("dueCheck: catch-up after weeks offline runs once, for the latest period", () => {
  const s = weekly("Africa/Johannesburg");
  const rule = { enabled: true, last_period: "weekly:2026-09-07", updated_at: iso("2026-09-01T00:00:00Z") };
  // App reopened on Wed 7 Oct after missing 14, 21, 28 Sep and 5 Oct.
  const now = iso("2026-10-07T08:00:00Z");
  const d = dueCheck(rule, s, now);
  assert.equal(d.due, true);
  assert.equal(d.periodKey, "weekly:2026-10-05");
  // After that run, nothing else is due until next Monday.
  const after = { ...rule, last_period: d.periodKey };
  assert.equal(dueCheck(after, s, now + HOUR).due, false);
  assert.equal(dueCheck(after, s, iso("2026-10-12T06:00:00Z")).due, true);
});

test("dueCheck: a rule saved after this period's time waits for the next one", () => {
  const s = weekly("Africa/Johannesburg");
  // Saved Wednesday; Monday's occurrence predates it.
  const rule = { enabled: true, last_period: null, updated_at: iso("2026-10-07T08:00:00Z") };
  assert.equal(dueCheck(rule, s, iso("2026-10-07T09:00:00Z")).due, false);
  assert.equal(dueCheck(rule, s, iso("2026-10-12T06:00:01Z")).due, true);
});

test("windows: since last run, first run = one period back, or the whole folder", () => {
  const cfg = defaultFolderRuleConfig("Europe/London");
  const runAt = iso("2026-10-26T08:00:00Z"); // Mon after fall-back
  // First run: one wall-clock week back (BST Monday 08:00 = 07:00Z).
  assert.equal(windowStart(cfg, null, runAt), iso("2026-10-19T07:00:00Z"));
  assert.equal(windowStart(cfg, 123, runAt), 123);
  assert.equal(windowStart({ ...cfg, window: "all" }, 123, runAt), null);
  const ms = [
    { id: "a", filed_at: 200 },
    { id: "b", filed_at: 100 },
    { id: "c", filed_at: 50 },
  ];
  assert.deepEqual(
    selectWindow(ms, 100).map((m) => m.id),
    ["a"],
  );
  assert.equal(selectWindow(ms, null).length, 3);
});

test("shiftPeriod: monthly clamps, daily/weekly keep local time across DST", () => {
  const m = monthly("Africa/Johannesburg", 31);
  assert.equal(shiftPeriod(m, iso("2026-03-31T07:00:00Z"), -1), iso("2026-02-28T07:00:00Z"));
  const d = daily("Europe/London");
  assert.equal(shiftPeriod(d, iso("2026-10-26T08:00:00Z"), -1), iso("2026-10-25T08:00:00Z"));
  assert.equal(shiftPeriod(d, iso("2026-10-25T08:00:00Z"), -1), iso("2026-10-24T07:00:00Z"));
});

test("parseFolderRuleConfig: defaults, clamping and unknown sends dropped", () => {
  const c = parseFolderRuleConfig("not json", "Europe/London");
  assert.equal(c.schedule.cadence, "weekly");
  assert.equal(c.schedule.tz, "Europe/London");
  assert.equal(c.window, "since_last_run");
  const c2 = parseFolderRuleConfig(
    JSON.stringify({
      schedule: { cadence: "monthly", time: "7:5x", day_of_week: 9, day_of_month: 40, tz: "Not/AZone" },
      window: "all",
      sends: [{ destination: "atlas_pack", includeTranscript: true }, { destination: "artemis" }],
      automation_tag_ids: ["t1", 3, ""],
    }),
    "UTC",
  );
  assert.equal(c2.schedule.cadence, "monthly");
  assert.equal(c2.schedule.time, "08:00");
  assert.equal(c2.schedule.day_of_week, 6);
  assert.equal(c2.schedule.day_of_month, 31);
  assert.equal(c2.schedule.tz, "UTC");
  assert.equal(c2.window, "all");
  assert.deepEqual(c2.sends, [{ destination: "atlas_pack", includeTranscript: true }]);
  assert.deepEqual(c2.automation_tag_ids, ["t1"]);
});

test("actionScope: unfinished meetings from earlier runs are carried past the window", () => {
  // Newest first, as the store returns them.
  const all = [
    { id: "new", filed_at: 300 },
    { id: "failed-last-week", filed_at: 200 },
    { id: "done-last-week", filed_at: 150 },
    { id: "pending-old", filed_at: 100 },
  ];
  const windowed = selectWindow(all, 250); // only "new"
  assert.deepEqual(
    actionScope(windowed, all, ["pending-old", "failed-last-week", "moved-out-of-folder"]).map((m) => m.id),
    ["new", "failed-last-week", "pending-old"],
  );
  // Nothing unfinished → exactly the window.
  assert.deepEqual(actionScope(windowed, all, []), windowed);
  // A carried id that is already in the window isn't duplicated.
  assert.equal(actionScope(windowed, all, ["new"]).length, 1);
});

test("createRuleGate: a second run of the same rule is refused until the first leaves", () => {
  const gate = createRuleGate();
  assert.equal(gate.tryEnter("r1"), true);
  assert.equal(gate.busy("r1"), true);
  // Run now during a scheduled run (or a double click) → refused.
  assert.equal(gate.tryEnter("r1"), false);
  // Other rules are independent.
  assert.equal(gate.tryEnter("r2"), true);
  gate.leave("r1");
  assert.equal(gate.busy("r1"), false);
  assert.equal(gate.tryEnter("r1"), true);
});

test("automations: a meeting the automation couldn't evaluate is failed (carried), not success", () => {
  assert.equal(automationItemStatus({ errors: 0 }), "done");
  assert.equal(automationItemStatus({ errors: 1 }), "failed");
  // Every meeting errored and nothing else succeeded → the run fails, so the
  // baseline doesn't advance (and the item ledger carries them anyway).
  assert.equal(runVerdict({ digestFailed: false, ok: 0, failed: 5 }), "failed");
  // Partial: some meetings settled → done; the failed ones are carried forward.
  assert.equal(runVerdict({ digestFailed: false, ok: 2, failed: 3 }), "done");
  assert.equal(runVerdict({ digestFailed: true, ok: 9, failed: 0 }), "failed");
  assert.equal(runVerdict({ digestFailed: false, ok: 0, failed: 0 }), "done");
});

test("stillDue: the sweep re-checks the stored rule before claiming", () => {
  const tz = "Africa/Johannesburg";
  const cfg = JSON.stringify({ schedule: weekly(tz) });
  const now = iso("2026-10-05T07:00:00Z"); // Mon 09:00 SAST, due for weekly:2026-10-05
  const stored = { enabled: true, last_period: null, updated_at: iso("2026-09-01T00:00:00Z"), config: cfg };
  const plan = "weekly:2026-10-05";
  assert.ok(stillDue(stored, plan, now, tz));
  // Deleted while an earlier rule was running.
  assert.equal(stillDue(undefined, plan, now, tz), null);
  // Paused meanwhile.
  assert.equal(stillDue({ ...stored, enabled: false }, plan, now, tz), null);
  // Already run for this period (another window / an earlier tick).
  assert.equal(stillDue({ ...stored, last_period: plan }, plan, now, tz), null);
  // Edited after this period's time (the edit floor), or moved to another day.
  assert.equal(stillDue({ ...stored, updated_at: now - 1000 }, plan, now, tz), null);
  const tuesday = JSON.stringify({ schedule: weekly(tz, 2) });
  assert.equal(stillDue({ ...stored, config: tuesday }, plan, now, tz), null);
});

test("describeSchedule", () => {
  assert.equal(describeSchedule(weekly("UTC")), "Every Monday at 08:00");
  assert.equal(describeSchedule(daily("UTC", "17:30")), "Every day at 17:30");
  assert.equal(describeSchedule(monthly("UTC", 1)), "Monthly on day 1 at 09:00");
  assert.equal(describeSchedule(monthly("UTC", 31)), "Monthly on day 31 (or the last day) at 09:00");
});

test("automation items waiting for cloud-AI consent are pending (no attempt), errors still fail", () => {
  assert.equal(automationItemStatus({ errors: 0, deferred: 1 }), "pending");
  assert.equal(automationItemStatus({ errors: 1, deferred: 1 }), "failed");
  assert.equal(automationItemStatus({ errors: 0, deferred: 0 }), "done");
});

test("folder rule models: digest/tasks model, automations' models, Atlas-pack autogen", () => {
  const d = { defaultModel: "local:qwen", autogenModel: "google/gemini" };
  const base = {
    digest: { enabled: false, prompt: "", model: "" },
    extract_tasks: false,
    automation_tag_ids: [] as string[],
    sends: [] as { destination: "atlas_pack" | "atlas" | "artemis_lead_flow" }[],
  };
  assert.deepEqual(folderRuleAiModels(base, ["openai/x"], d), []);
  // Only Atlas-pack sends: the autogen model still counts (it writes the summary).
  assert.deepEqual(folderRuleAiModels({ ...base, sends: [{ destination: "atlas_pack" }] }, [], d), [
    "google/gemini",
  ]);
  assert.deepEqual(
    folderRuleAiModels(
      { ...base, digest: { enabled: true, prompt: "Digest", model: "anthropic/claude" }, extract_tasks: true },
      [],
      d,
    ),
    ["anthropic/claude"],
  );
  assert.deepEqual(
    folderRuleAiModels({ ...base, extract_tasks: true, automation_tag_ids: ["t"] }, ["openai/x"], d).sort(),
    ["local:qwen", "openai/x"],
  );
});
