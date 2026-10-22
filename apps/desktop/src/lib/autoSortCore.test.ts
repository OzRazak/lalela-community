// Unit tests for the auto-sort prompt builder, parser and routing. Run with
// `pnpm --filter @lalela/desktop test` (Node's built-in runner; Node ≥ 22.18
// strips the TypeScript types natively — autoSortCore.ts has no imports).
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClassifyPrompt,
  buildDiscoveryPrompt,
  ClassifyParseError,
  clusterTitles,
  createKeyedQueue,
  createSingleFlight,
  estimateRun,
  queuedThen,
  matchFolder,
  mergeProposals,
  parseClassifyOutput,
  parseDiscoveryOutput,
  planFolderPush,
  routeDecision,
  sampleTranscript,
  SAMPLE_TOKENS,
  CHARS_PER_TOKEN,
  type SortFolder,
} from "./autoSortCore.ts";

const FOLDERS: SortFolder[] = [
  { id: "p1", name: "Coaching — Michelle", hint: "1:1 coaching sessions with Michelle" },
  { id: "p2", name: "PPS / Pricing engine" },
  { id: "p3", name: "PPS / Claims portal" },
];

test("sampleTranscript passes short transcripts whole", () => {
  const lines = ["Me: hello", "Michelle: hi"];
  assert.equal(sampleTranscript(lines), "Me: hello\nMichelle: hi");
});

test("sampleTranscript caps long transcripts and keeps beginning, middle and end", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `S: line ${i} ${"x".repeat(40)}`);
  const out = sampleTranscript(lines);
  const cap = SAMPLE_TOKENS * CHARS_PER_TOKEN;
  assert.ok(out.length <= cap + 20, `sample ${out.length} over cap ${cap}`);
  assert.ok(out.includes("line 0 "), "has the beginning");
  assert.ok(out.includes("line 1999 "), "has the end");
  assert.ok(out.includes("line 1000 ") || out.includes("line 999 "), "has the middle");
  assert.equal(out.split("[…]").length, 3);
});

test("buildClassifyPrompt lists folders, title, people, summary and sample", () => {
  const { system, user } = buildClassifyPrompt(
    {
      title: "Weekly sync",
      date: "2026-09-01",
      people: ["Michelle", "Oz"],
      summary: "Talked about leadership goals.",
      lines: ["Michelle: How did the week go?"],
    },
    FOLDERS,
  );
  assert.match(system, /ONLY one JSON object/);
  assert.match(system, /titleMismatch/);
  assert.match(user, /- Coaching — Michelle — 1:1 coaching/);
  assert.match(user, /- PPS \/ Pricing engine/);
  assert.match(user, /MEETING TITLE: Weekly sync/);
  assert.match(user, /PEOPLE: Michelle, Oz/);
  assert.match(user, /SUMMARY:\nTalked about leadership goals\./);
  assert.match(user, /Michelle: How did the week go\?/);
});

test("parseClassifyOutput accepts a clean reply", () => {
  const r = parseClassifyOutput(
    '{"folder":"Coaching — Michelle","confidence":0.93,"titleMismatch":false,"reason":"Coaching on leadership goals"}',
    FOLDERS,
  );
  assert.deepEqual(r, {
    folderId: "p1",
    confidence: 0.93,
    titleMismatch: false,
    reason: "Coaching on leadership goals",
  });
});

test("parseClassifyOutput tolerates fences, chatter and percent confidence", () => {
  const r = parseClassifyOutput(
    'Sure! ```json\n{"folder": "pps - pricing engine", "confidence": 85, "titleMismatch": true, "reason": "About {pricing} rules"}\n``` hope that helps',
    FOLDERS,
  );
  assert.equal(r.folderId, "p2");
  assert.equal(r.confidence, 0.85);
  assert.equal(r.titleMismatch, true);
});

test("parseClassifyOutput maps a nested folder's leaf name", () => {
  assert.equal(matchFolder("Claims portal", FOLDERS), "p3");
  assert.equal(matchFolder("p2", FOLDERS), "p2");
  assert.equal(matchFolder("Something else", FOLDERS), null);
});

test("parseClassifyOutput turns an unknown folder into a suggestion", () => {
  const r = parseClassifyOutput('{"folder":"Board meetings","confidence":0.7,"reason":"Board pack"}', FOLDERS);
  assert.equal(r.folderId, null);
  assert.equal(r.suggestedNewFolder, "Board meetings");
});

test("parseClassifyOutput keeps suggestedNewFolder for a null folder", () => {
  const r = parseClassifyOutput(
    '{"folder":null,"confidence":0.4,"titleMismatch":false,"reason":"Investor pitch","suggestedNewFolder":"Fundraising"}',
    FOLDERS,
  );
  assert.equal(r.folderId, null);
  assert.equal(r.suggestedNewFolder, "Fundraising");
});

test("parseClassifyOutput caps the reason at 20 words and clamps confidence", () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const r = parseClassifyOutput(`{"folder":"p1","confidence":1.7,"reason":"${long}"}`, FOLDERS);
  assert.equal(r.reason.split(" ").length, 20);
  assert.ok(r.reason.endsWith("…"));
  assert.equal(r.confidence, 1);
});

test("parseClassifyOutput rejects malformed replies", () => {
  assert.throws(() => parseClassifyOutput("I think coaching", FOLDERS), ClassifyParseError);
  assert.throws(() => parseClassifyOutput('{"folder":"p1"}', FOLDERS), ClassifyParseError);
  assert.throws(
    () => parseClassifyOutput('{"folder":3,"confidence":0.9}', FOLDERS),
    ClassifyParseError,
  );
  assert.throws(
    () => parseClassifyOutput('{"folder":"p1","confidence":0.9,"titleMismatch":"yes"}', FOLDERS),
    ClassifyParseError,
  );
  assert.throws(() => parseClassifyOutput('{"folder":"p1",', FOLDERS), ClassifyParseError);
});

test("routeDecision: confident + consistent → auto", () => {
  const base = { folderId: "p1", confidence: 0.9, titleMismatch: false, reason: "" };
  assert.deepEqual(routeDecision(base, 0.8), { route: "auto", why: "ok" });
  assert.deepEqual(routeDecision({ ...base, confidence: 0.8 }, 0.8), { route: "auto", why: "ok" });
});

test("routeDecision: below threshold, title mismatch or no folder → review", () => {
  const base = { folderId: "p1", confidence: 0.9, titleMismatch: false, reason: "" };
  assert.equal(routeDecision({ ...base, confidence: 0.79 }, 0.8).why, "low-confidence");
  assert.equal(routeDecision({ ...base, titleMismatch: true }, 0.8).why, "title-mismatch");
  assert.equal(routeDecision({ ...base, confidence: 0.99, titleMismatch: true }, 0.5).route, "review");
  assert.equal(routeDecision({ ...base, folderId: null }, 0.1).why, "no-folder");
  // A higher threshold in settings sends more to review.
  assert.equal(routeDecision(base, 0.95).route, "review");
});

test("clusterTitles finds recurring topics and prefers the pair", () => {
  const titles = [
    "Coaching with Michelle",
    "Michelle coaching session",
    "Coaching — Michelle (week 3)",
    "PPS pricing engine standup",
    "PPS pricing engine design",
    "PPS pricing engine review",
    "Lunch",
  ];
  const c = clusterTitles(titles);
  const terms = c.map((x) => x.term);
  assert.ok(terms.includes("michelle"));
  assert.ok(terms.includes("pps pricing") || terms.includes("pricing engine"));
  assert.ok(!terms.includes("meeting"));
  assert.ok(!terms.includes("lunch"));
});

test("discovery prompt + parser reuse existing folders and dedupe", () => {
  const { user } = buildDiscoveryPrompt(
    ["Coaching — Michelle"],
    [{ term: "pps", count: 40, examples: ["PPS sync"] }],
    [{ title: "PPS sync", snippet: "pricing engine rollout" }],
  );
  assert.match(user, /EXISTING FOLDERS:\n- Coaching — Michelle/);
  assert.match(user, /pps ×40/);
  assert.match(user, /PPS sync: pricing engine rollout/);
  const out = parseDiscoveryOutput(
    '{"folders":[{"name":"coaching - michelle","hint":"Coaching"},{"name":"PPS — Pricing engine","hint":"Pricing"},{"name":"PPS - pricing engine"},{"name":""}]}',
    [{ id: "p1", name: "Coaching — Michelle" }],
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: "Coaching — Michelle", hint: "Coaching", existingId: "p1" });
  assert.equal(out[1].existingId, undefined);
  assert.throws(() => parseDiscoveryOutput('{"folders":[]}', []), ClassifyParseError);
});

test("mergeProposals folds one proposal into another", () => {
  const merged = mergeProposals(
    [
      { name: "PPS", hint: "PPS work" },
      { name: "PPS projects", hint: "Projects", existingId: "p9" },
    ],
    1,
    0,
  );
  assert.deepEqual(merged, [{ name: "PPS", hint: "PPS work; Projects", existingId: "p9" }]);
});

test("estimateRun prices paid routes and leaves local free", () => {
  const paid = estimateRun(1000, 20, "anthropic/claude-haiku-4.5", "byok", 3);
  assert.ok(paid.usd !== null && paid.usd > 1 && paid.usd < 10, `usd ${paid.usd}`);
  assert.equal(paid.seconds, 3000);
  assert.equal(estimateRun(1000, 20, "local:x.gguf", "local", 10).usd, null);
});

test("createKeyedQueue serialises per key, in call order, and survives failures", async () => {
  const q = createKeyedQueue();
  const log: string[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const a1 = q("m1", async () => {
    await delay(20);
    log.push("m1:auto");
  });
  const a2 = q("m1", async () => {
    log.push("m1:manual");
    throw new Error("boom");
  });
  const a3 = q("m1", async () => {
    log.push("m1:undo");
  });
  const b1 = q("m2", async () => {
    log.push("m2");
  });
  await Promise.allSettled([a1, a2, a3, b1]);
  assert.deepEqual(
    log.filter((l) => l.startsWith("m1")),
    ["m1:auto", "m1:manual", "m1:undo"],
  );
  assert.ok(log.indexOf("m2") < log.indexOf("m1:auto"), "other keys don't wait");
  await assert.rejects(a2);
});

test("planFolderPush: the last local choice wins", () => {
  assert.equal(planFolderPush("pA", "pA"), "write");
  assert.equal(planFolderPush(null, null), "write");
  // A stale auto-file after a hand move to B: skipped.
  assert.equal(planFolderPush("pA", "pB"), "skip");
  // A stale auto-file after an undo (local is Unfiled again): skipped.
  assert.equal(planFolderPush("pA", null), "skip");
  // Meeting deleted locally: skipped.
  assert.equal(planFolderPush("pA", undefined), "skip");
});

test("createSingleFlight: a double start runs the batch once", async () => {
  const gate = createSingleFlight();
  let runs = 0;
  let release!: () => void;
  const body = () =>
    new Promise<void>((r) => {
      runs++;
      release = r;
    });
  const p1 = gate.run(body);
  const p2 = gate.run(body); // same tick, before any await in the caller
  assert.equal(p1, p2);
  assert.equal(gate.busy(), true);
  await new Promise((r) => setTimeout(r, 0));
  release();
  await p1;
  assert.equal(runs, 1);
  assert.equal(gate.busy(), false);
  // A body that resolves immediately still frees the slot.
  await gate.run(async () => {});
  assert.equal(gate.busy(), false);
  await gate.run(async () => {
    runs++;
  });
  assert.equal(runs, 2);
});

test("auto-file vs a later hand move to Unfiled: the hand move wins in the cloud", async () => {
  // Simulates autoSort.pushFolderChange + sync.pushMeeting sharing one queue.
  const q = createKeyedQueue();
  let local: string | null = "pA"; // auto-filed locally into A
  let cloud: string | null = null;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Auto-file write: passes its local check, THEN stalls before the CAS write
  // (the review's race window).
  let checked!: () => void;
  const passedCheck = new Promise<void>((r) => (checked = r));
  const auto = q("m1", async () => {
    if (planFolderPush("pA", local) === "skip") return;
    checked();
    await delay(20);
    if (cloud === null) cloud = "pA";
  });
  await passedCheck;
  // The user moves it to Unfiled while the auto write is still in flight.
  local = null;
  const manual = q("m1", async () => {
    cloud = local; // full pushMeeting carries the local folder
  });
  await Promise.all([auto, manual]);
  assert.equal(cloud, null);

  // And if the hand move happens after the auto write landed, it still wins.
  local = "pA";
  cloud = null;
  const auto2 = q("m2", async () => {
    if (planFolderPush("pA", local) === "skip") return;
    if (cloud === null) cloud = "pA";
  });
  await auto2;
  local = null;
  await q("m2", async () => {
    cloud = local;
  });
  assert.equal(cloud, null);
});

test("queuedThen: a stalled image upload doesn't block a later folder move", async () => {
  const q = createKeyedQueue();
  const log: string[] = [];
  let cloud: string | null = "pA";
  let unstall!: () => void;
  const stalled = new Promise<void>((r) => (unstall = r));
  // pushMeeting #1: row upsert (queued), then an image upload that hangs.
  const push1 = queuedThen(
    q,
    "m1",
    async () => {
      cloud = "pA";
      log.push("row1");
    },
    async () => {
      await stalled;
      log.push("images1");
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  // A later hand move (row write on the same queue) completes immediately.
  await q("m1", async () => {
    cloud = null;
    log.push("move");
  });
  assert.equal(cloud, null);
  assert.deepEqual(log, ["row1", "move"]);
  unstall();
  await push1;
  assert.deepEqual(log, ["row1", "move", "images1"]);
  // A failed row write skips the follow-up and rejects.
  let ran = false;
  await assert.rejects(
    queuedThen(
      q,
      "m1",
      async () => {
        throw new Error("fk");
      },
      async () => {
        ran = true;
      },
    ),
  );
  assert.equal(ran, false);
});
