// Lightweight local settings (persisted in localStorage for now; moves to the
// backend/Supabase in later phases). Keep keys stable.

import { IS_COMMUNITY } from "./edition";

/** 2026-07 rename: copy every Clio-era localStorage key ("clio.*") to its
 * "lalela.*" twin once. Generic on purpose — it also covers keys owned by
 * components (sidebar expansion, activity last-seen, onboarding). Existing
 * lalela.* values always win; old keys stay in place as a safety net. */
export function migrateLegacyLocalStorage(): void {
  const MARKER = "lalela.migrated.v1";
  if (localStorage.getItem(MARKER)) return;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("clio.")) continue;
    const target = "lalela." + key.slice("clio.".length);
    if (localStorage.getItem(target) === null) {
      const value = localStorage.getItem(key);
      if (value !== null) localStorage.setItem(target, value);
    }
  }
  localStorage.setItem(MARKER, "true");
}

const KEYS = {
  consentEnabled: "lalela.consent.enabled",
  consentText: "lalela.consent.text",
  apiKey: "lalela.llm.apiKey",
  model: "lalela.llm.model",
  prompts: "lalela.prompts",
  selectedPrompt: "lalela.prompts.selected",
  autoDetect: "lalela.autoDetect.enabled",
  systemAudio: "lalela.systemAudio.enabled",
  onboarded: "lalela.onboarded",
  transcriptionMode: "lalela.transcription.mode",
  asrEngine: "lalela.asr.engine",
  voiceprints: "lalela.voiceprints.enabled",
  autogenEnabled: "lalela.autogen.enabled",
  autogenModel: "lalela.autogen.model",
  actionsModel: "lalela.actions.model",
  summaryModel: "lalela.summary.model",
  chatModel: "lalela.chat.model",
  responseLength: "lalela.ai.length",
  aiSource: "lalela.ai.source",
  taskStages: "lalela.tasks.stages",
  irisFeedback: "lalela.iris.feedback.enabled",
  errorReports: "lalela.errorReports.enabled",
  usageData: "lalela.analytics.usageData",
  copilotScreenAwareness: "lalela.copilot.screenAwareness",
  copilotScreenDisclosed: "lalela.copilot.screenAwareness.disclosed",
  copilotVisionModel: "lalela.copilot.visionModel",
  folderRecursiveDefault: "lalela.folders.recursiveDefault",
  folderRecursiveOverrides: "lalela.folders.recursiveOverrides",
} as const;

export const DEFAULT_CONSENT_TEXT =
  "This meeting is being recorded and transcribed by Lalela to generate notes and a summary. The audio is processed locally and discarded after transcription.";

// --- Consent ---

export function getConsentEnabled(): boolean {
  const v = localStorage.getItem(KEYS.consentEnabled);
  return v === null ? true : v === "true";
}
export function setConsentEnabled(value: boolean): void {
  localStorage.setItem(KEYS.consentEnabled, String(value));
}
export function getConsentText(): string {
  return localStorage.getItem(KEYS.consentText) ?? DEFAULT_CONSENT_TEXT;
}
export function setConsentText(text: string): void {
  localStorage.setItem(KEYS.consentText, text);
}

// --- Meeting auto-detect (Phase 8) ---

export function getAutoDetectEnabled(): boolean {
  const v = localStorage.getItem(KEYS.autoDetect);
  return v === null ? true : v === "true";
}
export function setAutoDetectEnabled(value: boolean): void {
  localStorage.setItem(KEYS.autoDetect, String(value));
}

// --- System-audio capture (opt-in) ---
// Off by default: the Core Audio process-tap can deadlock the HAL on machines
// with virtual audio devices, so mic-only is the safe default. Users who want
// to capture "Others" (remote participants) enable it explicitly.
export function getSystemAudioEnabled(): boolean {
  return localStorage.getItem(KEYS.systemAudio) === "true";
}
export function setSystemAudioEnabled(value: boolean): void {
  localStorage.setItem(KEYS.systemAudio, String(value));
}

// --- Transcription engine (Phase 3: local Whisper vs cloud AssemblyAI) ---
// Local = live + fully private. Cloud = post-hoc (transcript arrives after
// Stop), better speaker labels, audio goes to AssemblyAI via our server and is
// deleted right after. Cloud requires being signed in (upload uses the account).

export type TranscriptionMode = "local" | "cloud";

export function getTranscriptionMode(): TranscriptionMode {
  // Cloud transcription runs on Auxo's servers: never in the Community edition.
  if (IS_COMMUNITY) return "local";
  return localStorage.getItem(KEYS.transcriptionMode) === "cloud" ? "cloud" : "local";
}
export function setTranscriptionMode(mode: TranscriptionMode): void {
  localStorage.setItem(KEYS.transcriptionMode, mode);
}

// --- Local speech engine (Intelligence Layer, Slice 8) ---
// Which on-device ASR engine local transcription uses. "whisper" (bundled,
// accuracy) is the default; alternative engines (e.g. Parakeet for speed) are
// hosted by the lalela-asr sidecar and offered only when present — the backend
// falls back to whisper with a notice if the choice is unavailable.

export const DEFAULT_ASR_ENGINE = "whisper";

export function getAsrEngine(): string {
  return localStorage.getItem(KEYS.asrEngine) ?? DEFAULT_ASR_ENGINE;
}
export function setAsrEngine(engine: string): void {
  localStorage.setItem(KEYS.asrEngine, engine);
}

// --- Speaker recognition / voiceprints (Intelligence Layer, Slice 1) ---
// OFF by default: voiceprints are biometric. When on, each diarized voice
// gets an embedding computed on-device (never synced) so people you've named
// once are auto-named in later meetings.

export function getVoiceprintsEnabled(): boolean {
  return localStorage.getItem(KEYS.voiceprints) === "true";
}
export function setVoiceprintsEnabled(value: boolean): void {
  localStorage.setItem(KEYS.voiceprints, String(value));
}

// --- Anonymous usage data (PostHog product analytics) ---
// ON by default, untickable in Settings ▸ Privacy (and on the first-run
// screen). Only the named, allowlisted events in lib/analyticsCore.ts are
// sent — never recordings, transcripts, notes, titles, names or file names.
// See docs/ANALYTICS.md and docs/DECISIONS.md 2026-10-06.

/** Fires on the window whenever the usage-data choice toggles. */
export const USAGE_DATA_EVENT = "lalela:usage-data-changed";

export function getUsageDataEnabled(): boolean {
  return localStorage.getItem(KEYS.usageData) !== "false";
}
export function setUsageDataEnabled(value: boolean): void {
  localStorage.setItem(KEYS.usageData, String(value));
  window.dispatchEvent(new Event(USAGE_DATA_EVENT));
}

// --- Opt-in crash & error reports (PostHog Error Tracking) ---
// OFF by default: nothing is sent unless the person turns this on in
// Settings ▸ Privacy (and the build can send — see lib/posthog.ts). Reports are
// content-free by design: error type, scrubbed message, stack locations, app
// version, OS + arch.

/** Fires on the window whenever the error-report opt-in toggles, so the
 *  reporter can start/stop sending immediately. */
export const ERROR_REPORTS_EVENT = "lalela:error-reports-changed";

export function getErrorReportsEnabled(): boolean {
  return localStorage.getItem(KEYS.errorReports) === "true";
}
export function setErrorReportsEnabled(value: boolean): void {
  localStorage.setItem(KEYS.errorReports, String(value));
  window.dispatchEvent(new Event(ERROR_REPORTS_EVENT));
}

// --- Iris bug-report widget (WS35, estate feedback widget) ---
// DOUBLE-GATED and OFF by default — deliberately stricter than the estate's
// env-only gate, because Lalela is privacy-first/local-first: the Iris widget
// loads a REMOTE script (widget.js) that can screenshot the app UI (which may
// show confidential transcripts / client names / notes) and POST it to Auxo.
// So nothing loads unless BOTH are true:
//   1. Build gate  — the build was compiled with VITE_IRIS_ENABLED="true" AND
//      a VITE_IRIS_KEY (see `irisBuildConfig`). No keys exist yet (Oz's
//      OZ-TODO), so every current build is an inert no-op regardless of (2).
//   2. User gate   — the person explicitly opts in here (default OFF).
// Voiceprints/transcripts remain local-only; this only ever transmits what the
// user chooses to attach to a bug report they file.

/** Fires on the window whenever the Iris opt-in toggles, so a mounted
 *  IrisWidget can attach/detach the remote script without an App-level prop. */
export const IRIS_FEEDBACK_EVENT = "lalela:iris-feedback-changed";

export function getIrisFeedbackEnabled(): boolean {
  return localStorage.getItem(KEYS.irisFeedback) === "true";
}
export function setIrisFeedbackEnabled(value: boolean): void {
  localStorage.setItem(KEYS.irisFeedback, String(value));
  window.dispatchEvent(new Event(IRIS_FEEDBACK_EVENT));
}

export interface IrisBuildConfig {
  host: string;
  key: string;
  projectUrl: string;
  api?: string;
}

/** The build-time Iris configuration, or null when this build was not compiled
 *  with Iris enabled + a project key. Mirrors the estate embed spec (aion
 *  `components/IrisWidget.tsx`) but reads Vite build vars (VITE_*). Defaults:
 *  host → the Iris deployment serving widget.js; projectUrl → the origin the
 *  Iris project is registered for (Iris ingest requires data-project-url to
 *  equal the request Origin — a Tauri webview's Origin is not a web origin, so
 *  activation must register whatever origin this build actually reports). */
export function irisBuildConfig(): IrisBuildConfig | null {
  const enabled = import.meta.env.VITE_IRIS_ENABLED === "true";
  const key = import.meta.env.VITE_IRIS_KEY as string | undefined;
  if (!enabled || !key) return null;
  const host = (import.meta.env.VITE_IRIS_HOST as string | undefined)?.replace(/\/$/, "") ||
    "https://iris.auxodigital.africa";
  const projectUrl = (import.meta.env.VITE_IRIS_URL as string | undefined) ||
    "https://lalela.auxodigital.africa";
  const api = import.meta.env.VITE_IRIS_API as string | undefined;
  return { host, key, projectUrl, ...(api ? { api } : {}) };
}

// --- Folder browsing: show subfolders' meetings ---
// When you open a folder, Lalela can list ONLY that folder's meetings (default,
// today's behaviour) or ALSO those of its subfolders. Two layers:
//   • a GLOBAL DEFAULT (off) — the set-and-forget base for every folder;
//   • a PER-FOLDER OVERRIDE map (folderId → boolean) — a folder the user flipped
//     in the header remembers its own choice, independent of the global default.
// Effective mode for a folder = override if present, else the global default
// (see getEffectiveFolderRecursive). Flipping the header toggle always WRITES an
// override for that one folder, so it never surprises other folders.

export function getFolderRecursiveDefault(): boolean {
  return localStorage.getItem(KEYS.folderRecursiveDefault) === "true";
}
export function setFolderRecursiveDefault(value: boolean): void {
  localStorage.setItem(KEYS.folderRecursiveDefault, String(value));
}

function readFolderOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEYS.folderRecursiveOverrides);
    const obj = raw ? (JSON.parse(raw) as unknown) : null;
    return obj && typeof obj === "object" ? (obj as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** The per-folder override for `folderId`, or `null` when the folder follows the
 * global default. */
export function getFolderRecursiveOverride(folderId: string): boolean | null {
  const map = readFolderOverrides();
  return Object.prototype.hasOwnProperty.call(map, folderId) ? map[folderId] : null;
}

/** Remember an explicit per-folder choice (what the header toggle writes). */
export function setFolderRecursiveOverride(folderId: string, value: boolean): void {
  const map = readFolderOverrides();
  map[folderId] = value;
  localStorage.setItem(KEYS.folderRecursiveOverrides, JSON.stringify(map));
}

/** The effective recursive mode for a folder: its override if it has one, else
 * the global default. */
export function getEffectiveFolderRecursive(folderId: string): boolean {
  return getFolderRecursiveOverride(folderId) ?? getFolderRecursiveDefault();
}

// --- Onboarding (Phase 9) ---

export function getOnboarded(): boolean {
  return localStorage.getItem(KEYS.onboarded) === "true";
}
export function setOnboarded(value: boolean): void {
  localStorage.setItem(KEYS.onboarded, String(value));
}

// --- Auto-generate for new meetings ---
// When enabled, a freshly saved recording gets a summary generated
// automatically (titles are always auto-suggested when a model is usable).
// The model is chosen separately so users can point this at a cheap/local
// model regardless of their main pick. "" = follow the current model.

export function getAutogenEnabled(): boolean {
  return localStorage.getItem(KEYS.autogenEnabled) === "true";
}
export function setAutogenEnabled(value: boolean): void {
  localStorage.setItem(KEYS.autogenEnabled, String(value));
}
export function getAutogenModel(): string {
  return resolveLegacyModel(localStorage.getItem(KEYS.autogenModel) ?? "");
}
export function setAutogenModel(model: string): void {
  localStorage.setItem(KEYS.autogenModel, model);
}

// --- Per-feature models ---
// Action-item extraction and manual summaries each remember their own model
// (same contract as autogen: "" = follow the current model).

export function getActionsModel(): string {
  return resolveLegacyModel(localStorage.getItem(KEYS.actionsModel) ?? "");
}
export function setActionsModel(model: string): void {
  localStorage.setItem(KEYS.actionsModel, model);
}
/** The Actions tab's effective model. */
export function actionsModel(): string {
  return getActionsModel() || getModel();
}

export function getSummaryModel(): string {
  return resolveLegacyModel(localStorage.getItem(KEYS.summaryModel) ?? "");
}
export function setSummaryModel(model: string): void {
  localStorage.setItem(KEYS.summaryModel, model);
}
/** The meeting-detail summary picker's starting value (persisted per pick). */
export function summaryModel(): string {
  return getSummaryModel() || getModel();
}

export function getChatModel(): string {
  return resolveLegacyModel(localStorage.getItem(KEYS.chatModel) ?? "");
}
export function setChatModel(model: string): void {
  localStorage.setItem(KEYS.chatModel, model);
}
/** The per-transcript chat picker's starting value (persisted per pick). */
export function chatModel(): string {
  return getChatModel() || getModel();
}

// --- Model gateway (BYOK) ---

export interface ModelOption {
  id: string;
  label: string;
  note: string;
  /** Premium (Opus-class) model whose per-token cost is above the free-tier
   * envelope — usable only through the user's own key (BYOK). The free-tier
   * proxy rejects these so a shared-key generation can't rack up Opus costs;
   * pickers flag them "BYOK". Absent/false = free-tier eligible. */
  byok?: boolean;
  /** Multimodal: the model accepts image input on OpenRouter, so the Meeting
   * Copilot's opt-in screen awareness (CP4) can attach a screenshot. Absent/
   * false = text-only; the copilot never sends an image to it. */
  vision?: boolean;
}

/** OpenRouter model ids (verified against the live model list + pricing on
 * 2026-09-27). Default is the cheap + accurate Claude Haiku. The `byok` flag
 * marks models above the free-tier cost envelope (the most expensive model
 * already on free tier is Sonnet 5.5 at $2/$10 per Mtok) — Opus 5.5, Anthropic's
 * most capable model, is Opus-class and priced well above it, so it's
 * BYOK-only. GPT-5.1 and Gemini 2.5 Pro both sit at $1/$10, below Sonnet, so
 * they stay free-tier eligible. */
// The `vision` flag marks models verified multimodal (image input) on
// OpenRouter (2026-07-17), conservatively: Gemini 2.5 Flash/Pro, GPT-5.1, and
// Claude Sonnet 5.5 / Opus 5.5. The default Haiku and GPT-4o-mini are left
// text-only, so screen awareness's degrade path (req 4) is the common case.
export const MODELS: ModelOption[] = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", note: "Cheap, fast, accurate (default)" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (legacy)", note: "Previous default — kept so saved picks still work" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini", note: "Cheap OpenAI" },
  { id: "google/gemini-2.5-flash", label: "Gemini Flash", note: "Cheap Google", vision: true },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", note: "Higher quality, pricier", vision: true },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Long context, strong reasoning", vision: true },
  { id: "openai/gpt-5.1", label: "GPT-5.1", note: "OpenAI flagship", vision: true },
  {
    id: "anthropic/claude-opus-5.5",
    label: "Claude Opus 5.5",
    note: "Most capable Claude — your own key (BYOK) required (cheaper than Opus 4.8)",
    byok: true,
    vision: true,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

// --- Legacy model id migration ---
// 2026-09-27: Claude Sonnet 4.5 → Sonnet 5 (2026-10-08: → Sonnet 5.5, as is Sonnet 5), Claude Opus 4.8 → Opus 5.5. Keep
// this map — and the equivalent one in apps/web/lib/settings.ts /
// apps/web/lib/aiServer.ts — in sync. Applied wherever a model id is read back
// from storage (localStorage KEYS.*, a saved report row, a workflow/automation
// block) so a stored legacy pick resolves to its current equivalent instead of
// being silently reset to Haiku or sent to the server as a disallowed id.
export const LEGACY_MODEL_IDS: Record<string, string> = {
  "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5": "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-4.8": "anthropic/claude-opus-5.5",
};

/** Map a possibly-legacy stored model id to its current equivalent. Passes
 * through unknown/empty ids unchanged. */
export function resolveLegacyModel(id: string): string {
  return id ? (LEGACY_MODEL_IDS[id] ?? id) : id;
}

/** Is `id` a premium (BYOK-only) model in the shared catalog? Used to flag it
 * in pickers and to keep it off the free-tier proxy. */
export function isByokOnlyModel(id: string): boolean {
  return MODELS.some((m) => m.id === id && m.byok);
}

/** Is `id` a vision-capable (multimodal) model? The Meeting Copilot's screen
 * awareness (CP4) only attaches a screenshot when this is true; otherwise it
 * degrades to a note and never sends an image to a blind model. */
export function isVisionModel(id: string): boolean {
  return MODELS.some((m) => m.id === id && m.vision);
}

/** A picker's display label — appends a "· BYOK" flag for premium models so
 * users know they need their own key. */
export function modelPickerLabel(m: ModelOption): string {
  return m.byok ? `${m.label} · BYOK` : m.label;
}

// --- Meeting Copilot screen awareness (CP4) — opt-in, OFF by default ---
// The ONLY copilot path that sends data off-device: when ON, invoking a copilot
// action captures a single screenshot and sends it to the cloud vision model
// you've selected. On-demand only — never a background loop. The overlay toggle
// and the Settings master control share this one localStorage key. `disclosed`
// records that the plain-language confirmation has been shown once, so
// re-enabling later doesn't nag.

/** The plain-language disclosure — single source of truth for both the overlay's
 * first-use confirmation AND the Settings master control (product-locked copy). */
export const COPILOT_SCREEN_DISCLOSURE =
  "Screen awareness sends a snapshot of your screen to the cloud AI model you've selected, only when you ask the copilot for help. It's off by default and never runs in the background.";

export function getCopilotScreenAwareness(): boolean {
  return localStorage.getItem(KEYS.copilotScreenAwareness) === "true";
}
export function setCopilotScreenAwareness(value: boolean): void {
  localStorage.setItem(KEYS.copilotScreenAwareness, String(value));
}
export function getCopilotScreenDisclosed(): boolean {
  return localStorage.getItem(KEYS.copilotScreenDisclosed) === "true";
}
export function setCopilotScreenDisclosed(value: boolean): void {
  localStorage.setItem(KEYS.copilotScreenDisclosed, String(value));
}

/** Vision-capable models the screen-awareness picker offers. Screenshots go ONLY
 * to the model chosen here — the user's default (text) model is left untouched. */
export function visionModels(): ModelOption[] {
  return MODELS.filter((m) => m.vision);
}

/** The screen-awareness model to fall back on when none is stored: the current
 * default model if it can already see images, otherwise the first vision model
 * in the catalog. Guarantees a usable vision model whenever one exists. */
export function defaultCopilotVisionModel(): string {
  const current = getModel();
  if (isVisionModel(current)) return current;
  return visionModels()[0]?.id ?? current;
}

/** The model the Meeting Copilot uses for image-bearing (screen-awareness) calls.
 * Always resolves to a vision-capable model when the catalog has one, so the
 * copilot's screen path is never routed to a blind model. Ignores a stale stored
 * pick (e.g. a model that lost its vision flag). */
export function getCopilotVisionModel(): string {
  const saved = resolveLegacyModel(localStorage.getItem(KEYS.copilotVisionModel) ?? "");
  if (saved && isVisionModel(saved)) return saved;
  return defaultCopilotVisionModel();
}
export function setCopilotVisionModel(model: string): void {
  localStorage.setItem(KEYS.copilotVisionModel, model);
}

// --- Response length (Wave A1) ---
// A coarse control on how long a generation may run. "standard" sends NO cap at
// all — exactly the legacy behaviour, the model decides the length — so a long
// meeting's summary never truncates mid-sentence. "detailed" caps at 4096 AND
// nudges the model to be thorough. Callers that don't pass a length also send
// no cap, so autogen / action-item / workflow spend never changes.

export type ResponseLength = "standard" | "detailed";

export const DEFAULT_LENGTH: ResponseLength = "standard";

/** Token cap for a chosen length, or undefined for "standard" — which caps
 * nothing (legacy behaviour). Only "detailed" caps, at 4096. */
export function maxTokensFor(length: ResponseLength): number | undefined {
  return length === "detailed" ? 4096 : undefined;
}

export function getResponseLength(): ResponseLength {
  return localStorage.getItem(KEYS.responseLength) === "detailed" ? "detailed" : "standard";
}
export function setResponseLength(value: ResponseLength): void {
  localStorage.setItem(KEYS.responseLength, value);
}

// --- Local models (desktop only; run via the lalela-llm sidecar) ---
// The whole local-LLM path is model-agnostic: adding/trying a new model later
// is one more catalog entry (the sidecar reads the chat template from the
// GGUF itself). Model ids in pickers are `local:<file>`.

export interface LocalModelSpec {
  id: string;
  label: string;
  note: string;
  /** File name under <app_data>/models/. */
  file: string;
  /** Direct, unauthenticated download URL (huggingface.co only). */
  url: string;
  /** Approximate on-disk size for the Settings UI. */
  sizeLabel: string;
  /** Rough RAM the loaded model needs (Settings hint), e.g. "8 GB+". */
  ramLabel: string;
  /** One short phrase on what the model is good at. */
  strengths: string;
  /** SPDX-ish license label shown on the catalog card. */
  license: string;
  /** Optional SHA-256 of the GGUF (git-LFS oid). When present the backend
   * verifies the download before promoting the .part file. */
  sha256?: string;
}

// Curated set of llama.cpp-compatible GGUFs (Q4_K_M quants). All URLs are
// direct, unauthenticated huggingface.co `resolve/main` links, verified to
// exist and to serve publicly (2026-07-08). The sha256 is each file's git-LFS
// oid from the HF tree API — the backend checks it before finishing.
// Gemma 3 4B stays first and is the default local model.
export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: "gemma-3-4b",
    label: "Gemma 3 4B",
    note: "Best quality per RAM; 128K context",
    file: "gemma-3-4b-it-Q4_K_M.gguf",
    url: "https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
    sizeLabel: "2.5 GB",
    ramLabel: "8 GB+",
    strengths: "Balanced quality · long context",
    license: "Gemma",
    sha256: "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863",
  },
  {
    id: "qwen3-4b",
    label: "Qwen 3 4B",
    note: "Strong reasoning; multilingual",
    file: "Qwen3-4B-Q4_K_M.gguf",
    url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
    sizeLabel: "2.5 GB",
    ramLabel: "8 GB+",
    strengths: "Reasoning · multilingual",
    license: "Apache-2.0",
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  },
  {
    id: "granite-3.3-2b",
    label: "IBM Granite 3.3 2B",
    note: "Small & fast; enterprise-tuned",
    file: "granite-3.3-2b-instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/resolve/main/granite-3.3-2b-instruct-Q4_K_M.gguf",
    sizeLabel: "1.5 GB",
    ramLabel: "4 GB+",
    strengths: "Fast · low RAM",
    license: "Apache-2.0",
    sha256: "ac71e9e32c0bea919b409c5918f69ca74339854b0319c5065e4e9fb6d95c4852",
  },
  {
    id: "llama-3.2-3b",
    label: "Llama 3.2 3B",
    note: "Well-rounded; broad support",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sizeLabel: "2.0 GB",
    ramLabel: "6 GB+",
    strengths: "General purpose",
    license: "Llama 3.2",
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
  },
  {
    id: "phi-4-mini",
    label: "Phi-4 Mini",
    note: "Compact; strong at instructions",
    file: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/microsoft_Phi-4-mini-instruct-GGUF/resolve/main/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
    sizeLabel: "2.5 GB",
    ramLabel: "6 GB+",
    strengths: "Concise · instruction-following",
    license: "MIT",
    sha256: "01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2",
  },
];

/** The default local model (also the first catalog card). */
export const DEFAULT_LOCAL_MODEL = LOCAL_MODEL_CATALOG[0];

/** Model-picker id for a downloaded local model. */
export const localModelId = (spec: LocalModelSpec) => `local:${spec.file}`;

export const isLocalModelId = (id: string) => id.startsWith("local:");

/** Picker option for a local model (mirrors ModelOption). */
export const localModelOption = (spec: LocalModelSpec): ModelOption => ({
  id: localModelId(spec),
  label: `Local: ${spec.label}`,
  note: "Free, on-device — no API key",
});

// --- Apple Intelligence (on-device Foundation Models — macOS 26+ / iOS 26+) ---
// A single fixed provider (no model catalog): `apple:foundation`. Discriminated
// everywhere by the `apple:` prefix and, like local models, NEVER added to the
// shared MODELS catalog — so the /api/ai allowlist stays clean and the option
// only appears when the backend reports Apple Intelligence available.

export const APPLE_MODEL_ID = "apple:foundation";

export const isAppleModelId = (id: string) => id.startsWith("apple:");

/** Picker option for Apple's on-device model (mirrors ModelOption). */
export const appleModelOption: ModelOption = {
  id: APPLE_MODEL_ID,
  label: "Apple Intelligence (on-device)",
  note: "Free, on-device — no API key",
};

export function getApiKey(): string {
  return localStorage.getItem(KEYS.apiKey) ?? "";
}
export function setApiKey(key: string): void {
  localStorage.setItem(KEYS.apiKey, key);
}
export function getModel(): string {
  const v = resolveLegacyModel(localStorage.getItem(KEYS.model) ?? "");
  return v || DEFAULT_MODEL;
}
export function setModel(model: string): void {
  localStorage.setItem(KEYS.model, model);
}

/** Which billing source cloud generations should use when both are available:
 * the user's own key or the signed-in free allowance. "auto" = key wins
 * (the pre-preference behavior). Local models bypass this entirely. */
export type AiSource = "auto" | "byok" | "free";

export function getAiSource(): AiSource {
  const v = localStorage.getItem(KEYS.aiSource);
  return v === "byok" || v === "free" ? v : "auto";
}
export function setAiSource(source: AiSource): void {
  localStorage.setItem(KEYS.aiSource, source);
}

// --- Prompt library ---

export interface Prompt {
  id: string;
  name: string;
  text: string;
}

export const DEFAULT_PROMPTS: Prompt[] = [
  {
    id: "general",
    name: "General summary",
    text:
      "You are an expert meeting note-taker. Using ONLY the transcript provided, write clean Markdown with these sections:\n\n" +
      "## Summary\nA concise paragraph of what was discussed.\n\n" +
      "## Key decisions\nBullet points of decisions made.\n\n" +
      "## Action items\nBullet points as: owner — task — due date (if mentioned).\n\n" +
      "Cite supporting moments with their timestamp like [3:24]. Do not invent anything not in the transcript. If something is unclear, say so rather than guessing.",
  },
  {
    id: "actions",
    name: "Action items only",
    text:
      "From the transcript, extract ONLY action items as Markdown bullets in the form: owner — task — due date (if mentioned), each with a [m:ss] timestamp. If there are none, say 'No action items found.' Do not invent anything.",
  },
  {
    id: "minutes",
    name: "Detailed minutes",
    text:
      "Write formal meeting minutes in Markdown from the transcript: attendees (by speaker label), agenda/topics discussed in order, decisions, action items (owner/task/due), and open questions. Cite timestamps [m:ss]. Use only what's in the transcript.",
  },
];

export function getPrompts(): Prompt[] {
  const raw = localStorage.getItem(KEYS.prompts);
  if (!raw) return DEFAULT_PROMPTS;
  try {
    const parsed = JSON.parse(raw) as Prompt[];
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PROMPTS;
  } catch {
    return DEFAULT_PROMPTS;
  }
}
export function savePrompts(prompts: Prompt[]): void {
  localStorage.setItem(KEYS.prompts, JSON.stringify(prompts));
}
export function getSelectedPromptId(): string {
  return localStorage.getItem(KEYS.selectedPrompt) ?? DEFAULT_PROMPTS[0].id;
}
export function setSelectedPromptId(id: string): void {
  localStorage.setItem(KEYS.selectedPrompt, id);
}

// --- Task board stages (custom Kanban columns) ---
// User-defined columns for the Tasks board. As of phase21 the DEFINITIONS are
// cloud-backed per user (Supabase `task_stages`, mirrored into the desktop
// SQLite `settings` row `tasks.stages`), so the same columns appear on every
// one of a user's devices. localStorage is a synchronous cache/fallback for
// first paint. The three defaults keep the canonical ids
// ("approved"/"in_progress"/"done") so existing action items map onto them 1:1.
// Users can add/rename/reorder the working columns; the terminal "Done" stage
// is fixed (Oz likes its cross-out) and always renders last. A task's `status`
// holds the EXACT stage id, stored verbatim in the cloud (phase21 relaxed the
// `action_items.status` CHECK) so custom placement survives cross-device and
// for other users viewing a shared task (they place it via `stageForStatus`,
// falling back to their first column when they haven't defined that stage).

export interface TaskStage {
  /** Stored in the action item's `status`. Defaults use canonical ids. */
  id: string;
  title: string;
  /** The one built-in terminal stage ("Done"): cross-out; not removable. */
  terminal?: boolean;
}

export const DEFAULT_STAGES: TaskStage[] = [
  { id: "approved", title: "To do" },
  { id: "in_progress", title: "In progress" },
  { id: "done", title: "Done", terminal: true },
];

/** Reserved ids that can never be a custom stage. */
const RESERVED_STAGE_IDS = new Set(["suggested", "done"]);

/** Normalise a stage list: keep only valid non-terminal stages, then pin the
 * fixed terminal "Done" stage last (preserving its user-renamed title). */
export function normaliseStages(stages: TaskStage[]): TaskStage[] {
  const doneTitle =
    stages.find((s) => s.terminal || s.id === "done")?.title?.trim() || "Done";
  const working = stages.filter(
    (s) =>
      s &&
      typeof s.id === "string" &&
      s.id.trim() &&
      typeof s.title === "string" &&
      !s.terminal &&
      s.id !== "done",
  );
  // De-dupe by id, dropping the reserved "suggested"/"done" from working.
  const seen = new Set<string>();
  const cleaned: TaskStage[] = [];
  for (const s of working) {
    if (RESERVED_STAGE_IDS.has(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    cleaned.push({ id: s.id, title: s.title.trim() || s.id });
  }
  if (cleaned.length === 0) {
    cleaned.push({ id: "approved", title: "To do" });
  }
  return [...cleaned, { id: "done", title: doneTitle, terminal: true }];
}

export function getTaskStages(): TaskStage[] {
  const raw = localStorage.getItem(KEYS.taskStages);
  if (!raw) return DEFAULT_STAGES;
  try {
    const parsed = JSON.parse(raw) as TaskStage[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_STAGES;
    return normaliseStages(parsed);
  } catch {
    return DEFAULT_STAGES;
  }
}

export function setTaskStages(stages: TaskStage[]): void {
  localStorage.setItem(KEYS.taskStages, JSON.stringify(normaliseStages(stages)));
}

/** A fresh, unique custom stage id. */
export function newStageId(): string {
  return `stage_${Math.random().toString(36).slice(2, 9)}`;
}

/** Which stage a task with `status` belongs to. Falls back to the first stage
 * for an orphaned id (e.g. a deleted custom stage) so nothing ever vanishes. */
export function stageForStatus(status: string, stages: TaskStage[]): TaskStage {
  return stages.find((s) => s.id === status) ?? stages[0];
}

/** Today as YYYY-MM-DD in local time (for date-only overdue comparisons). */
export function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** True when a task's due date is in the past and it isn't done. Date-only
 * (YYYY-MM-DD) dues compare lexically (timezone-safe); free-text AI dues that
 * don't parse are never treated as overdue. */
export function isTaskOverdue(due: string | null | undefined, status: string): boolean {
  if (!due || status === "done") return false;
  const trimmed = due.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed < todayIsoDate();
  const t = Date.parse(trimmed);
  return !Number.isNaN(t) && t < Date.now();
}
