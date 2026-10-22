// Strict retro-run mode (folder automations): failures that the lenient engine
// swallows must surface as per-meeting errors. Run with
// `pnpm --filter @lalela/desktop test` (automationsCore.ts has no imports).
import assert from "node:assert/strict";
import test from "node:test";

import {
  automationAiModels,
  classifyMatch,
  createKeyedLock,
  deferKey,
  lookupErrors,
  parseDeferred,
  splitDeferKey,
} from "./automationsCore.ts";

const failing = () => Promise.reject(new Error("AI provider unreachable"));

test("AI-classify failure: lenient = no match (unchanged), strict = error", async () => {
  assert.equal(await classifyMatch(failing, false), false);
  await assert.rejects(classifyMatch(failing, true), /unreachable/);
  // A real answer is passed through in both modes.
  assert.equal(await classifyMatch(() => Promise.resolve(true), true), true);
  assert.equal(await classifyMatch(() => Promise.resolve(false), true), false);
  assert.equal(await classifyMatch(() => Promise.resolve(true), false), true);
});

test("automation lookup failure: lenient = silent no-op (unchanged), strict = every meeting errors", () => {
  // listAutomations() threw.
  assert.equal(lookupErrors({ ok: false }, 4, false), 0);
  assert.equal(lookupErrors({ ok: false }, 4, true), 4);
  // Lookup worked but the automation is gone (deleted).
  assert.equal(lookupErrors({ ok: true, automation: undefined }, 3, false), 0);
  assert.equal(lookupErrors({ ok: true, automation: undefined }, 3, true), 3);
  // Found → evaluate normally.
  assert.equal(lookupErrors({ ok: true, automation: { tag_id: "t" } }, 3, true), null);
  assert.equal(lookupErrors({ ok: true, automation: { tag_id: "t" } }, 3, false), null);
});

// ---- cloud-AI consent (1.3.11) ----

const D = {
  defaultModel: "local:qwen",
  autogenModel: "local:qwen",
  resolve: (m: string) => (m === "legacy-haiku" ? "anthropic/claude-haiku" : m),
};

test("effective models: per-action cloud overrides behind an on-device default are found", () => {
  const models = automationAiModels(
    {
      ai_classify: { enabled: true, hint: "sales calls", model: "openai/gpt-x" },
      actions: { summary_prompt_text: "Summarise", summary_model: "anthropic/claude-sonnet" },
    },
    null,
    D,
  );
  assert.deepEqual(models.sort(), ["anthropic/claude-sonnet", "openai/gpt-x"]);
});

test("effective models: defaults fill in, workflow blocks resolve, send blocks ignored", () => {
  const models = automationAiModels(
    {
      ai_classify: { enabled: true, hint: "x" },
      actions: { workflow_id: "wf", summary_prompt_text: "S" },
    },
    [{ model: "legacy-haiku" }, { type: "send", model: "ignored" }, { model: null }],
    D,
  );
  assert.deepEqual(models.sort(), ["anthropic/claude-haiku", "local:qwen"]);
});

test("effective models: an Atlas-pack send counts the autogen model; nothing AI → empty", () => {
  const d = { ...D, autogenModel: "google/gemini" };
  assert.deepEqual(
    automationAiModels({ actions: { sends: [{ destination: "atlas_pack" }] } }, null, d),
    ["google/gemini"],
  );
  assert.deepEqual(
    automationAiModels(
      { ai_classify: { enabled: true, hint: "  " }, actions: { sends: [{ destination: "atlas" }] } },
      null,
      d,
    ),
    [],
  );
  // A workflow id without loadable blocks contributes nothing (the run fails anyway).
  assert.deepEqual(automationAiModels({ actions: { workflow_id: "gone" } }, null, d), []);
});

test("consent-deferred pairs round-trip and tolerate junk", () => {
  const k = deferKey("meeting-1", "tag-9");
  assert.deepEqual(splitDeferKey(k), { meetingId: "meeting-1", tagId: "tag-9" });
  assert.equal(splitDeferKey("no-separator"), null);
  assert.deepEqual([...parseDeferred(JSON.stringify([k, 3, null]))], [k]);
  assert.equal(parseDeferred(null).size, 0);
  assert.equal(parseDeferred("{not json").size, 0);
  assert.equal(parseDeferred('{"a":1}').size, 0);
});

test("effective models: a bound workflow's auto Atlas-pack send counts the autogen model", () => {
  const d = { ...D, autogenModel: "google/gemini" };
  const blocks = [
    { type: "send", send: { destination: "atlas_pack", mode: "auto" } },
    { type: "send", send: { destination: "atlas", mode: "auto" } },
  ];
  assert.deepEqual(automationAiModels({ actions: { workflow_id: "wf" } }, blocks, d), ["google/gemini"]);
  // Ask-mode sends are skipped headless, so they don't count.
  assert.deepEqual(
    automationAiModels(
      { actions: { workflow_id: "wf" } },
      [{ type: "send", send: { destination: "atlas_pack", mode: "ask" } }],
      d,
    ),
    [],
  );
});

test("keyed lock: same key never overlaps (second entrant waits), other keys run freely", async () => {
  const lock = createKeyedLock();
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = lock.run("m|t", async () => {
    log.push("a:start");
    await gate;
    log.push("a:end");
    return 1;
  });
  const second = lock.run("m|t", async () => {
    log.push("b:start");
    return 2;
  });
  const other = lock.run("m|other", async () => {
    log.push("c");
    return 3;
  });
  assert.equal(await other, 3);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["a:start", "c"]); // b is still waiting for a
  release();
  assert.deepEqual([await first, await second], [1, 2]);
  assert.deepEqual(log, ["a:start", "c", "a:end", "b:start"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lock.size(), 0);
});

test("keyed lock: a failed run doesn't block the next one for that key", async () => {
  const lock = createKeyedLock();
  await assert.rejects(lock.run("k", async () => Promise.reject(new Error("boom"))));
  assert.equal(await lock.run("k", async () => "ok"), "ok");
});
