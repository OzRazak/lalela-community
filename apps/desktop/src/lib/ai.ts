// One front door for every AI generation in the app. Routing:
//   local model   → the lalela-llm sidecar (free, on-device, no account)
//   BYOK key set  → OpenRouter directly with the user's key
//   signed in     → Lalela's free tier via the metered /api/ai proxy
//   none of those → NoAiError (callers show the "pick one of three" hint)
// The Settings "AI source" preference breaks the BYOK-over-free tie; each
// choice falls back to the other source when its own is unavailable.

import { AiConsentError, ensureCloudAiConsent } from "./aiConsent";
import { isCloudAiRoute } from "./aiConsentCore";
import { noteAiCall } from "./analytics";
import { reportAiFailure } from "./errorReporting";
import {
  cancelGenerate,
  getProjectBrief,
  getWorkspaceCard,
  onStreamDelta,
  streamGenerate,
  summarize,
} from "@/lib/lalela";
import {
  getAiSource,
  getApiKey,
  getModel,
  isAppleModelId,
  isLocalModelId,
  maxTokensFor,
  type ResponseLength,
} from "@/lib/settings";
import { supabase } from "@/lib/supabase";

/** Cap on injected workspace context (~1k tokens) so small local models keep
 * room for the actual transcript. Truncated at a line break where possible. */
const CARD_BUDGET_CHARS = 4000;
/** Cap on the injected project brief (Slice 3). */
const BRIEF_BUDGET_CHARS = 3000;

export function truncateCard(card: string, budget = CARD_BUDGET_CHARS): string {
  const trimmed = card.trim();
  if (trimmed.length <= budget) return trimmed;
  const cut = trimmed.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

/** Context assembly v1 (Slice 3): ranked injection ahead of the system
 * prompt — workspace card, then the project's rolling brief — each within
 * its own budget. Applied here — the single front door — so every route
 * (local sidecar, BYOK, free proxy) and every surface (summaries, chat,
 * workflows) gets the same context. Best-effort: a failed load never blocks
 * the generation. */
async function assembleSystemContext(
  system: string,
  opts?: { projectId?: string | null },
): Promise<string> {
  const parts: string[] = [];
  const card = truncateCard((await getWorkspaceCard().catch(() => "")) ?? "");
  if (card) {
    parts.push(
      `Workspace context (background about the user's company; use it to resolve names, projects and terminology):\n${card}`,
    );
  }
  if (opts?.projectId) {
    const brief = truncateCard(
      (await getProjectBrief(opts.projectId).catch(() => "")) ?? "",
      BRIEF_BUDGET_CHARS,
    );
    if (brief) {
      parts.push(
        `Project brief (current state, prior decisions and open actions of this project — reference them when relevant):\n${brief}`,
      );
    }
  }
  if (parts.length === 0) return system;
  return `${parts.join("\n\n---\n\n")}\n\n---\n\n${system}`;
}

export const LALELA_API = "https://lalela-app.auxodigital.africa";

export class NoAiError extends Error {
  constructor() {
    super("no-ai");
  }
}

export class QuotaError extends Error {
  used: number;
  quota: number;
  constructor(used: number, quota: number) {
    super(
      "You've used this month's free AI allowance. It resets on the 1st. Until then, add your own key in Settings or use an on-device model.",
    );
    this.used = used;
    this.quota = quota;
  }
}

// "apple" = Apple's on-device model (macOS 26+), routed like "local": through
// the Tauri summarize command, no API key, no proxy, no quota.
export type AiRoute = "local" | "apple" | "byok" | "free" | "none";

/** Which route a generation with `model` would take right now. */
export async function aiRoute(model: string = getModel()): Promise<AiRoute> {
  if (isLocalModelId(model)) return "local";
  if (isAppleModelId(model)) return "apple";
  const hasKey = Boolean(getApiKey());
  const { data } = await supabase.auth.getSession();
  const hasSession = Boolean(data.session);
  switch (getAiSource()) {
    case "free":
      return hasSession ? "free" : hasKey ? "byok" : "none";
    case "byok":
      return hasKey ? "byok" : hasSession ? "free" : "none";
    default:
      return hasKey ? "byok" : hasSession ? "free" : "none";
  }
}

/**
 * Ask for cloud-AI consent up front, before a USER-STARTED run of an engine
 * whose generations are background calls (Run automations now, retro runs,
 * folder rule "Run now", report "Run now", auto-sort batch, Send to Atlas).
 * Pass EVERY model the run can call (each action's effective model — see
 * automationsCore `automationAiModels` / folderRulesCore `folderRuleAiModels`):
 * an on-device default must not hide a cloud model one action is set to.
 * Shows the dialog only if one of them would go to a cloud lane and the user
 * has not answered yet. Resolves true when the run may use cloud AI (or
 * doesn't need it), false when the user said no.
 */
export async function preflightCloudAiConsent(
  models: string | string[] = getModel(),
): Promise<boolean> {
  const list = Array.isArray(models) ? models : [models];
  let route: AiRoute | null = null;
  for (const m of list) {
    const r = await aiRoute(m);
    if (isCloudAiRoute(r)) {
      route = r;
      break;
    }
  }
  if (!route) return true; // nothing in this run leaves the device
  try {
    await ensureCloudAiConsent(route, { interactive: true });
    return true;
  } catch (e) {
    if (e instanceof AiConsentError) return false;
    throw e;
  }
}

/** Best-effort BYOK usage bookkeeping — never blocks or fails a generation.
 * Only recorded when signed in (the cloud row is keyed to the account). */
function recordByokUsage(tokens: number): void {
  supabase.auth
    .getSession()
    .then(({ data }) =>
      data.session ? supabase.rpc("record_byok_usage", { p_tokens: tokens }) : null,
    )
    .then(
      () => {},
      () => {},
    );
}

/** Generate text. `userText` is the content, `system` the instruction.
 * `opts.length` (Wave A1) coarsely controls the response: "standard" sends NO
 * cap (legacy behaviour — the model decides, so long summaries don't truncate);
 * "detailed" caps at 4096 and appends a thoroughness hint. Callers that OMIT
 * `length` also send no cap, so autogen / action-item / workflow generations
 * keep their current token spend.
 * `opts.interactive` — set ONLY when the user just started this generation
 * (clicked Generate, sent a chat message, …). Then a not-yet-answered cloud-AI
 * consent shows the dialog. Omitted = background: an unanswered consent skips
 * the call quietly with AiConsentError (nothing is sent). */
export async function aiGenerate(
  userText: string,
  system: string,
  model: string = getModel(),
  opts?: {
    projectId?: string | null;
    length?: ResponseLength;
    imageDataUrl?: string;
    interactive?: boolean;
  },
): Promise<string> {
  const route = await aiRoute(model);
  noteAiCall(route, model); // analytics: route + model family only, never content
  if (route === "none") throw new NoAiError();
  // Third-party AI consent (App Review 5.1.2(i); every native build since
  // 1.3.11) — throws AiConsentError when refused, or when a background call
  // meets an unanswered consent. Never needed for local/apple.
  await ensureCloudAiConsent(route, { interactive: opts?.interactive === true });

  // Only opted-in callers cap output; undefined length ⇒ no maxTokens threaded.
  const maxTokens = opts?.length ? maxTokensFor(opts.length) : undefined;
  if (opts?.length === "detailed") system = `${system}\n\nBe thorough and detailed.`;

  system = await assembleSystemContext(system, opts);

  // Optional screenshot (CP4). Only vision-capable cloud lanes carry it; the
  // caller gates on `isVisionModel`, so local/Apple never receive one.
  const image = opts?.imageDataUrl;

  // Local, Apple and BYOK go through the Tauri command (nothing hits our proxy).
  if (route === "local" || route === "apple" || route === "byok") {
    const out = await summarize(userText, system, model, getApiKey(), maxTokens, image).catch(
      (e: unknown) => {
        reportAiFailure(e, route); // error only — never the prompt or output
        throw e;
      },
    );
    if (route === "byok" && out.tokens) recordByokUsage(out.tokens);
    return out.content;
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new NoAiError();

  const res = await fetch(`${LALELA_API}/api/ai`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      system,
      user: userText,
      model,
      ...(maxTokens ? { maxTokens } : {}),
      ...(image ? { image } : {}),
    }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    content?: string;
    error?: string;
    used?: number;
    quota?: number;
  };
  if (res.status === 402) throw new QuotaError(j.used ?? 0, j.quota ?? 0);
  if (!res.ok) throw new Error(j.error ?? `Free-tier request failed (${res.status})`);
  return j.content ?? "";
}

/** Handle for an in-flight streaming generation (CP0). `result` resolves with
 * the full text once done and REJECTS with an `AbortError` if cancelled (or the
 * usual NoAiError / QuotaError). `cancel()` stops the generation (idempotent). */
export interface AiStreamHandle {
  result: Promise<string>;
  cancel: () => void;
}

/** Options for `aiGenerateStream`. */
export interface AiStreamOpts {
  /** Model id; defaults to the user's current model (`getModel()`). */
  model?: string;
  /** Project whose rolling brief is injected (ignored when `rawSystem`). */
  projectId?: string | null;
  /** Coarse length control (same semantics as `aiGenerate`): "detailed" caps at
   * 4096 + adds a thoroughness hint. Ignored if `maxTokens` is given. */
  length?: ResponseLength;
  /** Hard cap on generated tokens for this call. Overrides `length`'s cap — the
   * live copilot loop passes a small value for snappy 2–3s guidance. */
  maxTokens?: number;
  /** Skip the workspace-card + project-brief auto-injection
   * (`assembleSystemContext`) so a live loop can send lean, self-managed
   * prompts. Default false (parity with `aiGenerate`). */
  rawSystem?: boolean;
  /** Optional base64 `data:` URL (CP4 screen awareness). When present the user
   * message becomes multimodal — carried on the free-proxy and BYOK/OpenRouter
   * lanes (the only vision lanes). The copilot only sets this when the resolved
   * model is vision-capable, so local + Apple never receive an image. */
  imageDataUrl?: string;
  /** External abort. Aborting it cancels the generation (same as `cancel()`). */
  signal?: AbortSignal;
  /** User-started generation — may show the cloud-AI consent dialog (see
   * `aiGenerate`). Omitted = background: skipped quietly if unanswered. */
  interactive?: boolean;
}

const abortError = () => new DOMException("Generation cancelled", "AbortError");

/**
 * Streaming sibling of {@link aiGenerate} — same front door (shared `aiRoute`
 * and context assembly), but tokens arrive incrementally via `onDelta` and the
 * generation is cancellable mid-flight. Built for the live Meeting Copilot loop.
 *
 * Which lanes truly stream token-by-token: **local** GGUF sidecar, **BYOK**
 * (OpenRouter SSE) and the **free** proxy (SSE from /api/ai). **Apple** can't
 * token-stream (map-reduce), so it fires a single `onDelta` with the whole
 * result. A lane with no AI available throws {@link NoAiError}.
 *
 * @param userText  the content (transcript / question / live window)
 * @param system    the instruction
 * @param onDelta   called with each token/chunk as it arrives
 * @param opts      see {@link AiStreamOpts}
 * @returns a handle whose `result` resolves to the full string (or rejects with
 *          an AbortError when cancelled), plus a `cancel()` function.
 */
export function aiGenerateStream(
  userText: string,
  system: string,
  onDelta: (delta: string) => void,
  opts?: AiStreamOpts,
): AiStreamHandle {
  const model = opts?.model ?? getModel();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", cancel, { once: true });
  }

  const result = (async (): Promise<string> => {
    const route = await aiRoute(model);
    noteAiCall(route, model);
    if (route === "none") throw new NoAiError();
    await ensureCloudAiConsent(route, { interactive: opts?.interactive === true }); // see aiGenerate

    const maxTokens = opts?.maxTokens ?? (opts?.length ? maxTokensFor(opts.length) : undefined);
    let sys = system;
    if (opts?.length === "detailed") sys = `${sys}\n\nBe thorough and detailed.`;
    if (!opts?.rawSystem) sys = await assembleSystemContext(sys, opts);
    if (controller.signal.aborted) throw abortError();

    const image = opts?.imageDataUrl;
    if (route === "local" || route === "apple" || route === "byok") {
      return streamViaTauri(userText, sys, model, maxTokens, route, image, onDelta, controller.signal);
    }
    return streamViaProxy(userText, sys, model, maxTokens, image, onDelta, controller.signal);
  })();

  return { result, cancel };
}

/** Local / Apple / BYOK: the Rust `stream_generate` command emits `llm://delta`
 * events tagged with a per-request id; we filter by it and forward. Cancel =
 * `cancel_generate(id)` (kills the sidecar / drops the SSE socket backend-side). */
async function streamViaTauri(
  userText: string,
  sys: string,
  model: string,
  maxTokens: number | undefined,
  route: AiRoute,
  image: string | undefined,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const id = crypto.randomUUID();
  const onAbort = () => {
    cancelGenerate(id).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const unlisten = await onStreamDelta((p) => {
    if (p.id === id) onDelta(p.delta);
  });
  try {
    const out = await streamGenerate({
      id,
      transcript: userText,
      prompt: sys,
      model,
      apiKey: getApiKey(),
      maxTokens,
      image,
    }).catch((e: unknown) => {
      if (!signal.aborted) reportAiFailure(e, route); // error only, no prompt/output
      throw e;
    });
    if (signal.aborted) throw abortError();
    if (route === "byok" && out.tokens) recordByokUsage(out.tokens);
    return out.content;
  } finally {
    unlisten();
    signal.removeEventListener("abort", onAbort);
  }
}

/** Free-tier proxy: opt into SSE with `stream:true` and read `data:` lines off
 * the ReadableStream. Metering stays server-side (see /api/ai). The AbortSignal
 * aborts the fetch, so `cancel()` rejects `result` with an AbortError. */
async function streamViaProxy(
  userText: string,
  sys: string,
  model: string,
  maxTokens: number | undefined,
  image: string | undefined,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new NoAiError();

  const res = await fetch(`${LALELA_API}/api/ai`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      system: sys,
      user: userText,
      model,
      stream: true,
      ...(maxTokens ? { maxTokens } : {}),
      ...(image ? { image } : {}),
    }),
    signal,
  });
  if (res.status === 402) {
    const q = (await res.json().catch(() => ({}))) as { used?: number; quota?: number };
    throw new QuotaError(q.used ?? 0, q.quota ?? 0);
  }
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Free-tier request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;
      let ev: { delta?: string; error?: string; used?: number; quota?: number };
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.error) {
        if (ev.error === "quota_exceeded") throw new QuotaError(ev.used ?? 0, ev.quota ?? 0);
        throw new Error(ev.error);
      }
      if (ev.delta) {
        full += ev.delta;
        onDelta(ev.delta);
      }
    }
  }
  return full;
}

/** One MCP-derived citation returned by the connections chat loop (T7). */
export interface ChatCitation {
  connection: string;
  connectionName: string;
  tool: string;
}

/**
 * Chat enriched with the user's connected MCP servers (T7). The connectors
 * framework + tool-use loop live in the WEB backend, so this always goes
 * through the hosted /api/chat route with the Supabase JWT (CORS-enabled) —
 * never the local sidecar. Requires a cloud model + being signed in; callers
 * gate the toggle on both. Only the assembled `userText` (meeting context +
 * question) reaches the model; transcripts never reach the MCP servers.
 */
export async function aiChatWithConnections(
  userText: string,
  system: string,
  model: string,
  connections: string[],
): Promise<{ content: string; citations: ChatCitation[] }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new NoAiError();
  // Always a cloud model via our proxy; only ever called from a chat message
  // the user just sent, so it may ask.
  await ensureCloudAiConsent("free", { interactive: true });
  const res = await fetch(`${LALELA_API}/api/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ system, user: userText, model, connections }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    content?: string;
    citations?: ChatCitation[];
    error?: string;
    used?: number;
    quota?: number;
  };
  if (res.status === 402) throw new QuotaError(j.used ?? 0, j.quota ?? 0);
  if (!res.ok) throw new Error(j.error ?? `Chat request failed (${res.status})`);
  return { content: j.content ?? "", citations: j.citations ?? [] };
}

export interface AiUsage {
  used: number;
  quota: number;
  plan: string;
  /** Tokens spent through the user's own key this month (informational only —
   * billed to them by their provider, never counted against the quota). */
  byokUsed: number;
}

const PLAN_TOKENS: Record<string, number> = { free: 200_000, pro: 2_000_000 };

/** This month's free-tier usage for the signed-in user (Settings bar). */
export async function getAiUsage(uid: string): Promise<AiUsage> {
  const month = new Date().toISOString().slice(0, 7);
  const [{ data: usage }, { data: profile }] = await Promise.all([
    supabase
      .from("ai_usage")
      .select("tokens_used,byok_tokens")
      .eq("user_id", uid)
      .eq("month", month)
      .maybeSingle(),
    supabase.from("profiles").select("plan,bonus_tokens").eq("id", uid).maybeSingle(),
  ]);
  const plan = profile?.plan ?? "free";
  return {
    used: Number(usage?.tokens_used ?? 0),
    quota: (PLAN_TOKENS[plan] ?? PLAN_TOKENS.free) + Number(profile?.bonus_tokens ?? 0),
    plan,
    byokUsed: Number(usage?.byok_tokens ?? 0),
  };
}
