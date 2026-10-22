// Automation engine — small PURE helpers (no imports) for the opt-in "strict"
// retro-run mode, so `node --test` can cover them (automationsCore.test.ts).
//
// Default engine behaviour is lenient and unchanged: an AI-classify failure is
// "no match", and a missing automation is a no-op batch. Folder automations
// run with `strict: true`, because they ledger each meeting as done once it's
// evaluated. A swallowed failure would then mark a never-evaluated meeting
// done for good. In strict mode both surface as per-meeting errors, which
// folder rules carry forward and retry.

/** Run the AI classifier. Lenient: any failure is "no match". Strict: the
 * failure propagates, so the caller counts the meeting as an error and
 * nothing is recorded for it. */
export function classifyMatch(classify: () => Promise<boolean>, strict: boolean): Promise<boolean> {
  return strict ? classify() : classify().catch(() => false);
}

export type AutomationLookup<T> = { ok: true; automation: T | undefined } | { ok: false };

/** Errors to charge a retro-run batch of `total` meetings when the
 * automation can't be used. Lenient: 0 (a silent no-op, as before). Strict: a
 * failed lookup or a missing automation means no meeting was evaluated, so
 * every meeting is an error. Returns null when the automation was found. */
export function lookupErrors<T>(lookup: AutomationLookup<T>, total: number, strict: boolean): number | null {
  if (lookup.ok && lookup.automation) return null;
  return strict ? total : 0;
}

// ---- cloud-AI consent (1.3.11) -------------------------------------------

/** Defaults the effective-model resolution needs (injected so this stays pure). */
export interface ModelDefaults {
  /** The user's current model (`getModel()`). */
  defaultModel: string;
  /** The auto-generation model (`autogenModel()`) — Atlas-pack summaries use it. */
  autogenModel: string;
  /** Legacy model-id mapping (`resolveLegacyModel`). */
  resolve: (model: string) => string;
}

/** The parts of an automation that decide which models it can call. */
export interface AutomationModelFacts {
  ai_classify?: { enabled: boolean; hint?: string; model?: string };
  actions: {
    workflow_id?: string;
    summary_prompt_text?: string;
    summary_model?: string;
    sends?: { destination: string }[];
  };
}

/**
 * Every model running automation `a` can call, resolved the way the engine
 * resolves it (per-action override, else the default). `workflowBlocks` = the
 * bound workflow's blocks (null when it has none / can't be loaded). A
 * user-started run preflights cloud-AI consent against this list, so an
 * on-device default model can't hide a cloud model one action is set to.
 */
export function automationAiModels(
  a: AutomationModelFacts,
  workflowBlocks:
    | { type?: string; model?: string | null; send?: { destination: string; mode?: string } | null }[]
    | null,
  d: ModelDefaults,
): string[] {
  const out = new Set<string>();
  if (a.ai_classify?.enabled && a.ai_classify.hint?.trim()) {
    out.add(a.ai_classify.model || d.defaultModel);
  }
  if (a.actions.workflow_id) {
    for (const b of workflowBlocks ?? []) {
      if (b.type === "send") {
        // A headless run executes auto-mode sends; an Atlas pack may write a
        // missing summary with the autogen model first.
        if (b.send?.destination === "atlas_pack" && b.send.mode === "auto") out.add(d.autogenModel);
        continue;
      }
      out.add(b.model ? d.resolve(b.model) : d.defaultModel);
    }
  }
  if (a.actions.summary_prompt_text) out.add(a.actions.summary_model || d.defaultModel);
  if ((a.actions.sends ?? []).some((s) => s.destination === "atlas_pack")) out.add(d.autogenModel);
  return [...out];
}

/** Key of one (meeting, automation) pair whose AI actions were skipped for an
 * unanswered cloud-AI consent. Such pairs stay retryable: the engine re-runs
 * their not-yet-ledgered actions instead of treating them as already done. */
export function deferKey(meetingId: string, tagId: string): string {
  return `${meetingId}\u0000${tagId}`;
}

/** Parse the stored deferred set; anything malformed is an empty set. */
export function parseDeferred(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Split a deferred key back into its pair (null for a malformed key). */
export function splitDeferKey(key: string): { meetingId: string; tagId: string } | null {
  const i = key.indexOf("\u0000");
  if (i <= 0 || i === key.length - 1) return null;
  return { meetingId: key.slice(0, i), tagId: key.slice(i + 1) };
}

/**
 * A process-wide lock keyed by string: `run(key, fn)` runs `fn` only after any
 * earlier `run` for the same key has settled (FIFO), so two entrants for one
 * (meeting, automation) pair — the consent-granted auto-resume, a manual
 * "Run automations", a retro run, a folder rule — never execute its actions
 * at the same time. The second one then sees the first one's ledger rows and
 * no-ops them. Different keys never wait for each other.
 */
export function createKeyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      const tail = next.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return next;
    },
    /** Keys with a run in flight or queued (tests / diagnostics). */
    size: () => tails.size,
  };
}
