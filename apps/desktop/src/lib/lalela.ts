import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AutomationSend } from "@/lib/tags";

/** A single transcript line, mirrors the Rust `Segment`. */
export interface Segment {
  t0_ms: number;
  t1_ms: number;
  text: string;
  speaker: string;
}

export interface RecordingStatus {
  state: "preparing" | "recording" | "transcribing" | "stopped" | string;
  message?: string | null;
}

export interface ModelProgress {
  downloaded: number;
  total: number;
}

// --- Commands ---

export const startRecording = (
  systemAudio: boolean,
  localTranscribe = true,
  engine = "whisper",
  voiceprints = false,
  /** Calendar attendee display names — lowest-precedence bias terms (Slice 9). */
  attendees: string[] = [],
  /** Quick voice memo (Wave B1): forces mic-only capture and skips diarization
   * so every segment stays "Me". Default false = a normal meeting recording. */
  micOnly = false,
) =>
  invoke<void>("start_recording", {
    systemAudio,
    localTranscribe,
    engine,
    voiceprints,
    attendees,
    micOnly,
  });
/** Stops recording and returns the final, diarized, time-sorted transcript. */
export const stopRecording = () => invoke<Segment[]>("stop_recording");

// --- Speech engines (Intelligence Layer, Slice 8) ---

/** One selectable local speech engine, as reported by the backend. */
export interface AsrEngineInfo {
  id: string;
  label: string;
  available: boolean;
  is_default: boolean;
}

/** Whisper (always) plus whatever the lalela-asr sidecar advertises. */
export const listAsrEngines = () => invoke<AsrEngineInfo[]>("list_asr_engines");

/** Fired when the chosen engine was unavailable and whisper was substituted. */
export const onAsrFallback = (cb: (message: string) => void) =>
  listen<string>("asr://fallback", (e) => cb(e.payload));

/** Mic silence watchdog: `true` when the mic has delivered only digital
 * silence (dead input path — e.g. a wedged coreaudiod) for a while,
 * `false` once real audio flows again. */
export const onMicSilence = (cb: (silent: boolean) => void) =>
  listen<boolean>("recording://mic-silence", (e) => cb(e.payload));

// --- Workspace card (Intelligence Layer, Slice 0) ---

/** `workspace.md` at the save root: company context injected into AI prompts
 * and mined for transcription vocabulary biasing. Empty string when unset. */
export const getWorkspaceCard = () => invoke<string>("get_workspace_card");
export const setWorkspaceCard = (content: string) =>
  invoke<void>("set_workspace_card", { content });

/** `dictionary.md`: explicit transcription-bias terms, one per line as
 * `- term | weight | sounds-like`. Setter returns the parsed-term count. */
export const getDictionary = () => invoke<string>("get_dictionary");
export const setDictionary = (content: string) =>
  invoke<number>("set_dictionary", { content });
export const previewDictionary = (content: string) =>
  invoke<number>("preview_dictionary", { content });

// --- Speaker directory (Intelligence Layer, Slice 1) ---

/** One person in the local speaker directory. Voiceprint embeddings stay in
 * the backend; the frontend only ever sees the has_voiceprint flag. */
export interface Speaker {
  id: string;
  name: string;
  aliases: string[];
  role: string | null;
  has_voiceprint: boolean;
  meeting_count: number;
  created_at: number;
  updated_at: number;
}

export const listSpeakers = () => invoke<Speaker[]>("list_speakers");
export const renameSpeaker = (id: string, name: string) =>
  invoke<Speaker[]>("rename_speaker", { id, name });
export const deleteSpeaker = (id: string) => invoke<Speaker[]>("delete_speaker", { id });
/** Merge `mergedId` into `keepId` (aliases union, voiceprints averaged). */
export const mergeSpeakers = (keepId: string, mergedId: string) =>
  invoke<Speaker[]>("merge_speakers", { keepId, mergedId });

/** "This is X": relabel a meeting speaker and enrol their voiceprint from
 * this meeting's observed voice (when one was recorded). Returns the updated
 * meeting. */
export const labelMeetingSpeaker = (meetingId: string, fromLabel: string, name: string) =>
  invoke<FullMeeting>("label_meeting_speaker", { meetingId, fromLabel, name });

// --- External transcript import (Intelligence Layer, Slice 2) ---

/** What an import will become, previewed before saving. */
export interface ImportPreview {
  /** "transcript" (speakers detected) or "document" (prose/notes). */
  kind: "transcript" | "document" | string;
  format: string;
  detected: string | null;
  title: string;
  segments: Segment[];
  text: string;
}

/** Provenance row for an imported meeting (trust badge). The media fields
 * are set for audio imports only (Slice 7). */
export interface ImportSource {
  id: string;
  meeting_id: string;
  kind: string;
  format: string;
  original_filename: string;
  trust_level: string;
  media_duration_ms: number | null;
  decoded_sample_rate: number | null;
  imported_at: number;
}

export const pickImportFile = () => invoke<string | null>("pick_import_file");

// --- Bulk folder import ---

/** One candidate file from a folder scan, classified for bulk import. */
export interface FolderImportFile {
  path: string;
  filename: string;
  /** "audio" (transcribed like a recording) or "document" (parsed as text). */
  kind: "audio" | "document" | string;
  size_bytes: number;
  /** A file with this name was imported before — deselected by default. */
  already_imported: boolean;
}

export const pickImportFolder = () => invoke<string | null>("pick_import_folder");
export const scanImportFolder = (path: string) =>
  invoke<FolderImportFile[]>("scan_import_folder", { path });
export const importPreview = (path: string) =>
  invoke<ImportPreview>("import_preview", { path });
/** Re-parse AI-structured text with the same parser used for files. */
export const parseImportText = (text: string, format: string, title: string) =>
  invoke<ImportPreview>("parse_import_text", { text, format, title });
export const saveImportedMeeting = (
  title: string,
  projectId: string | null,
  preview: ImportPreview,
  originalFilename: string,
) =>
  invoke<FullMeeting>("save_imported_meeting", { title, projectId, preview, originalFilename });
export const getMeetingImportSource = (meetingId: string) =>
  invoke<ImportSource | null>("get_meeting_import_source", { meetingId });

// --- Audio-file import (Intelligence Layer, Slice 7) ---

/** Extensions the audio-import path accepts (mirrors Rust AUDIO_EXTENSIONS). */
export const AUDIO_IMPORT_EXTENSIONS = [
  "mp3",
  "m4a",
  "mp4",
  "wav",
  "flac",
  "ogg",
  "aac",
  "mkv",
  "webm",
];

export const isAudioImportPath = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_IMPORT_EXTENSIONS.includes(ext);
};

/** Decode + transcribe + diarize an external recording through the real
 * pipeline and save it with `verified-audio` provenance. Long-running:
 * progress arrives via onImportStatus/onImportProgress; cancellable. */
export const importAudioFile = (
  path: string,
  title: string | null,
  projectId: string | null,
  engine = "whisper",
  voiceprints = false,
) =>
  invoke<FullMeeting>("import_audio_file", { path, title, projectId, engine, voiceprints });

/** Abort an in-flight audio import at the next chunk boundary. */
export const cancelAudioImport = () => invoke<void>("cancel_audio_import");

export interface ImportStatus {
  state: "decoding" | "transcribing" | "diarizing" | string;
  message?: string | null;
}

export interface ImportProgress {
  processed_ms: number;
  total_ms: number;
}

export const onImportStatus = (cb: (s: ImportStatus) => void) =>
  listen<ImportStatus>("import://status", (e) => cb(e.payload));
export const onImportProgress = (cb: (p: ImportProgress) => void) =>
  listen<ImportProgress>("import://progress", (e) => cb(e.payload));
export const onImportSegment = (cb: (s: Segment) => void) =>
  listen<Segment>("import://segment", (e) => cb(e.payload));

// --- Knowledge layer (Intelligence Layer, Slice 3) ---

/** A full-text retrieval hit over transcripts/summaries/notes. */
export interface TranscriptHit {
  meeting_id: string;
  title: string;
  snippet: string;
  created_at: number;
}

/** Local FTS retrieval, optionally scoped to a project. */
export const searchTranscripts = (query: string, projectId: string | null, limit = 6) =>
  invoke<TranscriptHit[]>("search_transcripts", { query, projectId, limit });

/** FTS retrieval scoped to a SET of folders (WHERE project_id IN …) — the
 * "include subfolders" mirror of {@link searchTranscripts}. The frontend passes
 * a folder plus its descendant folder ids (see {@link descendantProjectIds}); an
 * empty list returns no hits. */
export const searchTranscriptsIn = (query: string, projectIds: string[], limit = 6) =>
  invoke<TranscriptHit[]>("search_transcripts_in", { query, projectIds, limit });

/** Rolling project brief (brief.md in the project folder). */
export const getProjectBrief = (projectId: string) =>
  invoke<string>("get_project_brief", { projectId });
export const setProjectBrief = (projectId: string, content: string) =>
  invoke<void>("set_project_brief", { projectId, content });

/** One LLM-compiled wiki page (input shape for upsert). */
export interface WikiPageInput {
  kind: "person" | "project" | "topic" | string;
  title: string;
  summary_line?: string;
  tags?: string[];
  links?: string[];
  content_md: string;
  /** Provenance is mandatory — pages without facts are dropped. */
  facts: { quote: string; t_ms?: number | null }[];
}

export interface WikiPageRow {
  id: string;
  kind: string;
  title: string;
  summary_line: string;
  tags: string[];
  links: string[];
  updated_at: number;
  fact_count: number;
}

export interface WikiFact {
  meeting_id: string;
  meeting_title: string;
  t_ms: number | null;
  quote: string;
}

export interface WikiPageDetail {
  id: string;
  kind: string;
  title: string;
  summary_line: string;
  content_md: string;
  facts: WikiFact[];
}

export const upsertWikiPages = (meetingId: string, pages: WikiPageInput[]) =>
  invoke<number>("upsert_wiki_pages", { meetingId, pages });
export const listWikiPages = () => invoke<WikiPageRow[]>("list_wiki_pages");
export const getWikiPage = (id: string) => invoke<WikiPageDetail>("get_wiki_page", { id });

// --- Cloud transcription (Phase 3) ---

/** Hosted web app that fronts AssemblyAI (key stays server-side). */
export const CLOUD_TRANSCRIBE_ENDPOINT = "https://lalela-app.auxodigital.africa";

/** Stop a cloud-mode recording; returns the temp WAV path for cloudTranscribe. */
export const stopRecordingWav = () => invoke<string>("stop_recording_wav");

/** Upload + transcribe the WAV via the hosted route. Needs a signed-in user's
 * Supabase access token; the audio object is deleted after transcription. */
export const cloudTranscribe = (wavPath: string, accessToken: string) =>
  invoke<Segment[]>("cloud_transcribe", {
    wavPath,
    accessToken,
    endpoint: CLOUD_TRANSCRIBE_ENDPOINT,
  });

export interface CloudStatus {
  stage: "uploading" | "transcribing" | string;
}

export const onCloudStatus = (cb: (s: CloudStatus) => void) =>
  listen<CloudStatus>("cloud://status", (e) => cb(e.payload));
export const isRecording = () => invoke<boolean>("is_recording");
export const setPaused = (paused: boolean) => invoke<void>("set_paused", { paused });

export interface SummarizeOutput {
  content: string;
  /** Provider-reported token count; null for the local sidecar. */
  tokens: number | null;
}

export const summarize = (
  transcript: string,
  prompt: string,
  model: string,
  apiKey: string,
  /** Optional response cap (Wave A1). Omitted ⇒ the backend's legacy default
   * (uncapped for OpenRouter, 2048 for the local sidecar). */
  maxTokens?: number,
  /** Optional base64 `data:` URL (CP4 screen awareness). Carried only on the
   * BYOK/OpenRouter vision lane; local + Apple models ignore it. */
  image?: string,
) => invoke<SummarizeOutput>("summarize", { transcript, prompt, model, apiKey, maxTokens, image });

// --- Workflows (prompt pipelines) ---

/** A workflow send block's push config — the SAME shape as an automation send
 * (destination + optional target + ask/auto mode), so a block reuses the
 * existing push executors verbatim (T8). */
export type WorkflowSend = AutomationSend;

export interface WorkflowBlock {
  id: string;
  name: string;
  /** Block kind. Absent/"prompt" = the original prompt block (back-compat);
   * "send" pushes the meeting to a connected MCP destination (T8). */
  type?: "prompt" | "send";
  /** The runnable prompt text (inlined even when copied from the library).
   * Empty for send blocks. */
  prompt_text: string;
  /** Prompt-library id it was copied from — display only. */
  prompt_ref: string | null;
  /** "transcript" or the id of an EARLIER block in the same workflow. */
  input: string;
  /** Model id override; null = the user's current model. */
  model: string | null;
  /** Send blocks only: destination + target + ask/auto mode. */
  send?: WorkflowSend;
}

export interface Workflow {
  id: string;
  name: string;
  blocks: WorkflowBlock[];
  created_at: number;
}

export interface WorkflowOutput {
  block_id: string;
  output: string;
  updated_at: number;
}

// --- Action items ---

/** The canonical lifecycle values. A task's actual `status` is free text — it
 * holds the current stage id, which may be a user-defined Kanban column
 * (see settings `TaskStage`). "suggested" is reserved for un-approved items. */
export type ActionItemStatus = "suggested" | "approved" | "in_progress" | "done";

export interface ActionItem {
  id: string;
  meeting_id: string;
  title: string;
  assignee_name: string | null;
  /** Cloud profile id when the name matched a project member. */
  assignee_uid: string | null;
  /** Stage id (free text): a canonical value or a custom Kanban column id. */
  status: string;
  due: string | null;
  created_at: number;
  updated_at: number;
  /** Joined for board cards. */
  meeting_title: string;
  project_id: string | null;
}

export interface NewActionItem {
  title: string;
  assignee_name: string | null;
  assignee_uid: string | null;
  due: string | null;
}

/** No meetingId → every item (the kanban); with → that meeting's items. */
export const listActionItems = (meetingId?: string) =>
  invoke<ActionItem[]>("list_action_items", { meetingId: meetingId ?? null });

/** Replace a meeting's *suggested* items (approved/in-flight are kept). */
export const setMeetingActionItems = (meetingId: string, items: NewActionItem[]) =>
  invoke<ActionItem[]>("set_meeting_action_items", { meetingId, items });

/** Manually add ONE task to a meeting — goes straight onto the board with the
 * given stage id (default a canonical "approved"). Returns the created row. */
export const addActionItem = (item: {
  meeting_id: string;
  title: string;
  assignee_name: string | null;
  assignee_uid: string | null;
  due: string | null;
  status: string;
}) =>
  invoke<ActionItem>("add_action_item", {
    meetingId: item.meeting_id,
    title: item.title,
    assigneeName: item.assignee_name,
    assigneeUid: item.assignee_uid,
    due: item.due,
    status: item.status,
  });

export const updateActionItem = (item: {
  id: string;
  title: string;
  assignee_name: string | null;
  assignee_uid: string | null;
  due: string | null;
  status: string;
}) =>
  invoke<ActionItem>("update_action_item", {
    id: item.id,
    title: item.title,
    assigneeName: item.assignee_name,
    assigneeUid: item.assignee_uid,
    due: item.due,
    status: item.status,
  });

export const deleteActionItem = (id: string) => invoke<void>("delete_action_item", { id });

// --- Task board stages (phase21; local SQLite mirror of the cloud config) ---

/** The stored custom-stage JSON, or null if the user hasn't customised the
 * board. Frontend layers localStorage (cache) + Supabase (cross-device) on top. */
export const getTaskStagesLocal = () =>
  invoke<string | null>("get_task_stages");

/** Persist the (already-normalised) stage-list JSON to the local mirror. */
export const setTaskStagesLocal = (json: string) =>
  invoke<void>("set_task_stages", { json });

export const listWorkflows = () => invoke<Workflow[]>("list_workflows");
export const saveWorkflow = (workflow: Workflow) =>
  invoke<Workflow>("save_workflow", { workflow });
export const deleteWorkflow = (id: string) => invoke<void>("delete_workflow", { id });
export const getWorkflowOutputs = (meetingId: string, workflowId: string) =>
  invoke<WorkflowOutput[]>("get_workflow_outputs", { meetingId, workflowId });
export const setWorkflowOutput = (
  meetingId: string,
  workflowId: string,
  blockId: string,
  output: string,
) => invoke<void>("set_workflow_output", { meetingId, workflowId, blockId, output });

// --- Chat threads (persisted chat history) ---

export type ChatScope = "global" | "folder" | "meeting";

export interface ChatThreadRow {
  id: string;
  scope: ChatScope;
  scope_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

export const listChatThreads = (scope: ChatScope, scopeId: string | null) =>
  invoke<ChatThreadRow[]>("list_chat_threads", { scope, scopeId });

export const createChatThread = (scope: ChatScope, scopeId: string | null, title: string) =>
  invoke<ChatThreadRow>("create_chat_thread", { scope, scopeId, title });

export const listChatMessages = (threadId: string) =>
  invoke<ChatMessageRow[]>("list_chat_messages", { threadId });

export const appendChatMessage = (threadId: string, role: "user" | "assistant", content: string) =>
  invoke<ChatMessageRow>("append_chat_message", { threadId, role, content });

export const renameChatThread = (id: string, title: string) =>
  invoke<void>("rename_chat_thread", { id, title });

export const deleteChatThread = (id: string) => invoke<void>("delete_chat_thread", { id });

// --- Local LLM (desktop only) ---

export interface LlmStatus {
  file: string;
  present: boolean;
  size_bytes: number;
  running: boolean;
}

export const localLlmStatus = (files: string[]) =>
  invoke<LlmStatus[]>("local_llm_status", { files });

// --- Apple Intelligence (desktop, macOS 26+) ---

export interface AppleLlmStatus {
  available: boolean;
  /** Human-readable reason when present-but-unusable; absent otherwise. */
  reason?: string | null;
}

/** Whether Apple's on-device Foundation Models LLM can serve requests. Resolves
 * to `available:false` (no reason) on iOS / older macOS / ineligible hardware —
 * never rejects for mere absence. */
export const appleLlmStatus = () => invoke<AppleLlmStatus>("apple_llm_status");

/** Kick off a resumable, background download. Returns immediately — progress
 * arrives via `onLlmProgress` and completion via `onLlmComplete`; the backend
 * keeps running even if this view unmounts. `label` names the OS notification. */
export const startModelDownload = (
  url: string,
  file: string,
  sha256?: string,
  label?: string,
) => invoke<void>("start_model_download", { url, file, sha256, label });

/** Terminal/in-progress state of every model download this session — used to
 * restore progress bars when Settings is re-opened mid-download. */
export interface DownloadState {
  file: string;
  downloaded: number;
  total: number;
  status: "downloading" | "done" | "error";
  error: string | null;
}

export const modelDownloadStatus = () =>
  invoke<DownloadState[]>("model_download_status");

export const deleteLocalLlm = (file: string) => invoke<void>("delete_local_llm", { file });

export const unloadLocalLlm = () => invoke<void>("unload_local_llm");

// --- Manage local models: reclaim disk space (desktop only) ---

/** One downloaded model file on disk. `kind` classifies the weight; `label` is
 * a best-effort friendly name (the UI overrides LLM labels from the catalog). */
export interface LocalModelFile {
  file: string;
  path: string;
  size_bytes: number;
  kind: "llm" | "asr" | "diarization";
  label: string;
  /** The whisper base model transcription needs — flag it, don't hide delete. */
  is_base_asr: boolean;
  /** Loaded in the sidecar, or (ASR/diarization) an engine of a live recording. */
  in_use: boolean;
}

export interface LocalModelList {
  models: LocalModelFile[];
  total_bytes: number;
  /** The directory enumerated (shown as the storage location). */
  dir: string;
}

/** Every model file on disk, largest-first, with a total. */
export const listLocalModels = () => invoke<LocalModelList>("list_local_models");

/** Typed refusal/failure from `deleteLocalModel` (serde `{ code, … }`). */
export interface DeleteModelError {
  code: "recording_in_progress" | "outside_model_dir" | "not_found" | "failed";
  message?: string;
}

/** Safely delete ONE model file (path-validated, unloads it first if resident,
 * refused while recording). Returns the bytes freed. */
export const deleteLocalModel = (path: string) =>
  invoke<{ freed_bytes: number; file: string }>("delete_local_model", { path });

export interface LlmProgress {
  file: string;
  downloaded: number;
  total: number;
}

export const onLlmProgress = (cb: (p: LlmProgress) => void) =>
  listen<LlmProgress>("llm://progress", (e) => cb(e.payload));

export interface LlmComplete {
  file: string;
  ok: boolean;
  error?: string;
}

/** Fires once per download when it finishes (success or failure), from any
 * view. Subscribe to refresh model pickers / catalog UI globally. */
export const onLlmComplete = (cb: (p: LlmComplete) => void) =>
  listen<LlmComplete>("llm://complete", (e) => cb(e.payload));

// --- Streaming AI lane (CP0) ---
// `stream_generate` mirrors `summarize`'s routing (apple / local / BYOK) but
// forwards tokens as `llm://delta` events tagged with a per-request `id`. The
// free-tier proxy lane is NOT here — it streams over SSE from /api/ai directly
// (see lib/ai.ts `aiGenerateStream`). Prefer that front door over these raw
// bindings.

export interface StreamDelta {
  /** The request id passed to `streamGenerate` — filter events by it. */
  id: string;
  delta: string;
}

/** Subscribe to token deltas for any in-flight `streamGenerate`. Filter on the
 * payload `id` you passed in (concurrent streams share this one channel). */
export const onStreamDelta = (cb: (p: StreamDelta) => void) =>
  listen<StreamDelta>("llm://delta", (e) => cb(e.payload));

/** Start a streaming generation. Deltas arrive via `onStreamDelta` (matched by
 * `id`); the promise resolves with the full text + token count when done. */
export const streamGenerate = (args: {
  id: string;
  transcript: string;
  prompt: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** Optional base64 `data:` URL (CP4 screen awareness). Carried only on the
   * BYOK/OpenRouter vision lane; local + Apple models ignore it. */
  image?: string;
}) => invoke<SummarizeOutput>("stream_generate", args);

/** Cancel an in-flight `streamGenerate` by its `id` (idempotent). */
export const cancelGenerate = (id: string) => invoke<void>("cancel_generate", { id });

/** A finished meeting handed from the recorder to the detail view. */
export interface Meeting {
  title: string;
  dateISO: string;
  segments: Segment[];
  images: ImageInput[];
  /** Notes the user typed in the live notes pane while recording (Wave A2).
   * Persisted into the saved meeting's `notes` so detail view opens with them. */
  notes: string;
  /** Calendar attendees from the recording-time calendar match (Slice 9). */
  attendees?: Attendee[] | null;
  /** Live "What did I miss?" catch-up exchanges (Wave A4), collected during the
   * recording. Replayed into the saved meeting's chat thread on save (best-effort
   * — never blocks the save). */
  catchup?: { question: string; answer: string }[] | null;
}

/** Render segments as grounded, LLM-friendly text: "[m:ss] Speaker: text". */
export function transcriptToText(segments: Segment[]): string {
  return segments
    .map((s) => `[${formatMs(s.t0_ms)}] ${s.speaker}: ${s.text}`)
    .join("\n");
}

// --- Storage (Phase 4) ---

export interface MeetingMeta {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
  has_summary: boolean;
  /** Short list-card preview (summary head, else transcript start). */
  snippet: string;
  /** Local-only "starred" flag (A6) — never synced to the cloud. */
  is_favorite: boolean;
}

/** A screen capture anchored to a transcript timestamp (Phase 6). */
export interface MeetingImage {
  id: string;
  t_ms: number;
  /** Path relative to the meeting folder, e.g. `images/cap-123.png`. */
  rel_path: string;
  caption: string;
}

/** A calendar attendee attached to a meeting (Slice 9). Mirrors the cloud
 * `meetings.attendees` jsonb shape (phase17) and the Rust store `Attendee`. */
export interface Attendee {
  name?: string | null;
  email?: string | null;
}

export interface FullMeeting {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
  dir_path: string | null;
  segments: Segment[];
  notes: string;
  summary: string;
  /** AI-enhanced notes (Wave A3): the user's rough notes merged with the
   * transcript into polished, cited notes. Stored separately from `notes` —
   * the user's own notes are never mutated. Empty string = not enhanced yet. */
  enhanced_notes: string;
  images: MeetingImage[];
  /** Calendar attendees — null/absent for meetings without a calendar match. */
  attendees?: Attendee[] | null;
}

/** An image captured during a live recording (still in app-data staging). */
export interface LiveCapture {
  t_ms: number;
  src_path: string;
}

/** An image passed to `save_meeting` to be moved into the meeting folder. */
export interface ImageInput {
  t_ms: number;
  src_path: string;
  caption: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
  /** Parent folder id; null = root. Folders form a tree. */
  parent_id: string | null;
  /** Local-only "starred" flag (A6) — never synced to the cloud. */
  is_favorite: boolean;
}

export interface SaveMeetingInput {
  title: string;
  project_id: string | null;
  segments: Segment[];
  notes: string;
  summary: string;
  images: ImageInput[];
  /** Calendar attendees from the recording-time calendar match (Slice 9). */
  attendees?: Attendee[] | null;
}

export const saveMeeting = (input: SaveMeetingInput) =>
  invoke<FullMeeting>("save_meeting", { input });

export const listMeetings = (projectId: string | null = null) =>
  invoke<MeetingMeta[]>("list_meetings", { projectId });

/** List meetings across a SET of folders in one query (WHERE project_id IN …).
 * Used by the "include subfolders" folder mode — the frontend computes the
 * descendant folder ids (see {@link descendantProjectIds}) and passes them all.
 * An empty list returns no meetings. */
export const listMeetingsIn = (projectIds: string[]) =>
  invoke<MeetingMeta[]>("list_meetings_in", { projectIds });

/** A lean, attendees-only projection of a meeting — id, title, folder, timestamp
 * and its calendar attendees, WITHOUT the heavy transcript/summary/notes/images
 * payloads. Mirrors the Rust `MeetingAttendees`. Powers the People & Companies
 * grouping ({@link listMeetingAttendees}); `attendees` is `[]` when the meeting
 * had no calendar match. */
export interface MeetingAttendees {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
  attendees: Attendee[];
}

/** Attendees-only projection over EVERY meeting (no cap) in ONE query — the lean
 * read behind People & Companies. Unlike the old path (list_meetings + a
 * get_meeting per row, capped at ~2000), this pulls no transcript/summary, so it
 * groups the WHOLE store cheaply. The meeting LIST views keep {@link listMeetings}. */
export const listMeetingAttendees = () =>
  invoke<MeetingAttendees[]>("list_meeting_attendees", {});

export const getMeeting = (id: string) => invoke<FullMeeting>("get_meeting", { id });

export const updateMeeting = (
  id: string,
  title: string,
  notes: string,
  summary: string,
  projectId: string | null,
) => invoke<FullMeeting>("update_meeting", { id, title, notes, summary, projectId });

/** Set (or clear) a meeting's AI-enhanced notes (Wave A3). Stored separately
 * from the user's own `notes`, which are never touched — re-running replaces
 * this field. Returns the updated meeting. */
export const updateEnhancedNotes = (id: string, text: string) =>
  invoke<FullMeeting>("update_enhanced_notes", { id, text });

/** One authored, timestamped entry in a meeting's notes LOG (A7). `meetings.notes`
 * is DERIVED from these (chronological concat) so Enhance/FTS/notes.md/sync all
 * keep working. `author_id === null` = created locally while signed out —
 * rendered "You" and treated as this device's until claimed on first push. */
export interface NoteEntry {
  id: string;
  meeting_id: string;
  author_id: string | null;
  author_name: string;
  text: string;
  created_at: number;
  updated_at: number;
}

export const listNoteEntries = (meetingId: string) =>
  invoke<NoteEntry[]>("list_note_entries", { meetingId });

/** Append an entry authored by the given identity (null = signed out). Returns
 * the fresh entry list; the backend re-derives notes + rewrites the files. */
export const addNoteEntry = (
  meetingId: string,
  authorId: string | null,
  authorName: string,
  text: string,
) => invoke<NoteEntry[]>("add_note_entry", { meetingId, authorId, authorName, text });

export const updateNoteEntry = (id: string, text: string) =>
  invoke<NoteEntry[]>("update_note_entry", { id, text });

export const deleteNoteEntry = (id: string) =>
  invoke<NoteEntry[]>("delete_note_entry", { id });

/** Claim this device's authorless entries for a meeting as `authorId` before a
 * cloud push (RLS forbids inserting a null author). */
export const claimNoteEntries = (meetingId: string, authorId: string, authorName: string) =>
  invoke<void>("claim_note_entries", { meetingId, authorId, authorName });

/** Upsert cloud-pulled entries locally (last-write-wins on updated_at). */
export const upsertNoteEntries = (entries: NoteEntry[]) =>
  invoke<void>("upsert_note_entries", { entries });

export const deleteMeeting = (id: string) => invoke<void>("delete_meeting", { id });

/** Import a meeting (e.g. pulled from the cloud) into the local store by id. */
export const importMeeting = (meeting: FullMeeting) =>
  invoke<void>("import_meeting", { meeting });

/** Move a local meeting to a new id in one transaction, keeping the old id as
 * an alias (#284: connector-id collision with another account's cloud row).
 * Rejects when the new id already exists locally. */
export const rekeyMeeting = (oldId: string, newId: string) =>
  invoke<FullMeeting>("rekey_meeting", { oldId, newId });

/** Old ids re-keyed onto other meetings — connector import dedupe treats them
 * as "already have it". */
export const listMeetingIdAliases = () => invoke<string[]>("list_meeting_id_aliases");

export const searchMeetings = (query: string) =>
  invoke<MeetingMeta[]>("search_meetings", { query });

export const listProjects = () => invoke<Project[]>("list_projects");

export const renameProject = (id: string, name: string) =>
  invoke<Project>("rename_project", { id, name });

/** Delete a project; its meetings are kept and become Unfiled. */
export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

/** Flatten the folder tree depth-first for indent-rendered <select> options.
 * Folders with a missing parent are treated as roots (defensive). */
export function flattenProjectTree(
  projects: Project[],
): Array<{ project: Project; depth: number }> {
  const ids = new Set(projects.map((p) => p.id));
  const children = new Map<string | null, Project[]>();
  for (const p of projects) {
    const key = p.parent_id && ids.has(p.parent_id) ? p.parent_id : null;
    const list = children.get(key) ?? [];
    list.push(p);
    children.set(key, list);
  }
  const out: Array<{ project: Project; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of children.get(parent) ?? []) {
      out.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The set of folder ids rooted at `folderId`: the folder itself ∪ every
 * transitive descendant (children, grandchildren, …). Pure — used to fetch
 * meetings recursively when a folder is opened in "include subfolders" mode.
 *
 * Returns `[folderId]` when the folder has no children, and `[]` if `folderId`
 * isn't in `projects`. A `visited` set makes it cycle-safe: the backend refuses
 * to create cycles (`set_project_parent`), but a corrupt/legacy tree can't hang
 * the UI. Order is a breadth-first walk (root first); callers treat it as a set. */
export function descendantProjectIds(projects: Project[], folderId: string): string[] {
  const childrenOf = new Map<string, Project[]>();
  for (const p of projects) {
    if (!p.parent_id) continue;
    const list = childrenOf.get(p.parent_id) ?? [];
    list.push(p);
    childrenOf.set(p.parent_id, list);
  }
  if (!projects.some((p) => p.id === folderId)) return [];
  const out: string[] = [];
  const visited = new Set<string>();
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue; // cycle guard
    visited.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }
  return out;
}

export const createProject = (name: string, parentId: string | null = null) =>
  invoke<Project>("create_project", { name, parentId });

/** Re-parent a folder (null = move to root). Backend refuses cycles. */
export const setProjectParent = (id: string, parentId: string | null) =>
  invoke<void>("set_project_parent", { id, parentId });

/** Move a meeting into a project (null = Unfiled); rewrites its markdown. */
export const moveMeetingToProject = (meetingId: string, projectId: string | null) =>
  invoke<FullMeeting>("move_meeting_to_project", { meetingId, projectId });

/** Star/unstar a meeting (A6). Local-only preference — not synced to cloud. */
export const setMeetingFavorite = (id: string, fav: boolean) =>
  invoke<void>("set_meeting_favorite", { id, fav });

/** Star/unstar a folder (A6). Local-only preference — not synced to cloud. */
export const setProjectFavorite = (id: string, fav: boolean) =>
  invoke<void>("set_project_favorite", { id, fav });

export const getSaveFolder = () => invoke<string>("get_save_folder");
export const pickSaveFolder = () => invoke<string | null>("pick_save_folder");
/** The formats the desktop export button offers. Both carry the same content —
 *  transcript plus the meeting's captured frames. */
export type ExportFormat = "docx" | "pdf";

/** Export a meeting to disk. Opens the native save dialog and resolves with the
 *  chosen path, or null if the user cancelled. */
export const exportMeetingFile = (id: string, format: ExportFormat) =>
  invoke<string | null>("export_meeting_file", { id, format });

// --- Screen capture (Phase 6) ---

/** Capture the screen during a live recording (before the meeting is saved).
 *  `interactive` shows the native region picker; false = silent full-screen. */
export const captureLive = (tMs: number, interactive: boolean) =>
  invoke<LiveCapture | null>("capture_live", { tMs, interactive });

/** An on-screen window offered by the slide-capture picker. `meeting` marks
 * conferencing/browser windows (shown first). */
export interface MeetingWindow {
  id: number;
  app: string;
  title: string;
  width: number;
  height: number;
  meeting: boolean;
}

/** Every on-screen window, for the manual slide-capture picker (desktop only).
 * Empty when the window helper isn't built. */
export const listWindows = () => invoke<MeetingWindow[]>("list_windows");

/** Drop the backend's persistent window-capture stream (held for windows in
 * fullscreen Spaces). Call when slide capture turns off or changes target. */
export const releaseCaptureStream = () => invoke<void>("release_capture_stream");

/** One screenshare capture tick (Slice 4): shoots one window and saves a WebP
 * frame only when a held slide changed. Pass `windowId` to pin a specific
 * window (manual pick); omit/null to auto-detect the meeting window. Returns
 * null on no-save ticks (most of them) and when the window isn't on screen. */
export const captureScreenshareSample = (tMs: number, windowId?: number | null) =>
  invoke<LiveCapture | null>("capture_screenshare_sample", { tMs, windowId: windowId ?? null });

/** Capture the screen and attach it to an already-saved meeting at `tMs`. */
export const captureForMeeting = (meetingId: string, tMs: number, interactive: boolean) =>
  invoke<FullMeeting | null>("capture_for_meeting", { meetingId, tMs, interactive });

export const removeMeetingImage = (meetingId: string, imageId: string) =>
  invoke<FullMeeting>("remove_meeting_image", { meetingId, imageId });

/** Write image bytes (downloaded from cloud Storage) into a meeting's folder. */
export const saveMeetingImage = (meetingId: string, relPath: string, data: number[]) =>
  invoke<void>("save_meeting_image", { meetingId, relPath, data });

/** Build a webview-loadable URL for an image given the meeting folder + rel path. */
export const meetingImageSrc = (dirPath: string | null, relPath: string): string =>
  convertFileSrc(dirPath ? `${dirPath}/${relPath}` : relPath);

/** Build a webview-loadable URL for an absolute file path (live captures). */
export const fileSrc = (absPath: string): string => convertFileSrc(absPath);

/** Format an epoch-millis timestamp for display. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Format just the clock time of an epoch-millis timestamp (used inside a
 * day-grouped list, where the date lives in the group header). */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" });
}

/** A run of items that share a calendar day, with a human header. */
export interface DayGroup<T> {
  /** Stable key (local yyyy-mm-dd) for React lists. */
  key: string;
  /** "Today" · "Yesterday" · "Monday 14 July" (en-GB tone, year added when it
   * differs from now to avoid ambiguity). */
  label: string;
  items: T[];
}

/** Local yyyy-mm-dd for a date (grouping key — day boundaries are local). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Header label for a day, relative to `now`: Today / Yesterday / weekday date. */
export function dayGroupLabel(d: Date, now: Date = new Date()): string {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  // en-GB tone: "Monday 14 July"; include the year only when it differs from
  // the current year so older meetings stay unambiguous.
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: "long", day: "numeric", month: "long" }
      : { weekday: "long", day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** Group an already-time-sorted list into contiguous day runs (order
 * preserved — pass a DESC list to get Today first). */
export function groupByDay<T>(
  items: T[],
  getMs: (item: T) => number,
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const d = new Date(getMs(item));
    const key = dayKey(d);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayGroupLabel(d, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export interface CaptureSources {
  mic: boolean;
  system: boolean;
  /** Whether system audio was asked for at all. `systemRequested && !system`
   * is the degraded case — the tap couldn't start, so the recording captures
   * only this device's microphone (half of any call). Optional: recordings
   * started by an older build emit the event without it. */
  systemRequested?: boolean;
}

// --- Meeting auto-detect (Phase 8) ---

export interface MeetingDetected {
  /** Human-readable display string (e.g. "Zoom", "your browser (Google Meet?)"). */
  source: string;
  /** Canonical app id for the detected meeting ("Zoom" | "Microsoft Teams" |
   *  "Webex" | "Browser"), or "" for a generic/unknown source. Matches the
   *  notification mute list (see lib/notifications.ts). */
  kind: string;
}

/** Enable/disable backend meeting auto-detect. */
export const setDetectionEnabled = (enabled: boolean) =>
  invoke<void>("set_detection_enabled", { enabled });

/** Wave C1: read the "keep running in the menu bar" setting (default ON). */
export const getCloseToTray = () => invoke<boolean>("get_close_to_tray");

/** Wave C1: persist the "keep running in the menu bar" setting. */
export const setCloseToTray = (enabled: boolean) =>
  invoke<void>("set_close_to_tray", { enabled });

// --- Events ---

export const onTranscriptSegment = (cb: (s: Segment) => void): Promise<UnlistenFn> =>
  listen<Segment>("transcript://segment", (e) => cb(e.payload));

export const onRecordingStatus = (
  cb: (s: RecordingStatus) => void,
): Promise<UnlistenFn> =>
  listen<RecordingStatus>("recording://status", (e) => cb(e.payload));

export const onModelProgress = (
  cb: (p: ModelProgress) => void,
): Promise<UnlistenFn> =>
  listen<ModelProgress>("model://progress", (e) => cb(e.payload));

export const onRecordingError = (cb: (msg: string) => void): Promise<UnlistenFn> =>
  listen<string>("recording://error", (e) => cb(e.payload));

export const onCaptureSources = (
  cb: (s: CaptureSources) => void,
): Promise<UnlistenFn> =>
  listen<CaptureSources>("capture://sources", (e) => cb(e.payload));

export const onMeetingDetected = (
  cb: (d: MeetingDetected) => void,
): Promise<UnlistenFn> =>
  listen<MeetingDetected>("meeting://detected", (e) => cb(e.payload));

/** Fires when the iOS launch/foreground scan imports a recording synced from
 *  the paired Apple Watch (payload = the new meeting id). Lets the UI refresh
 *  its meeting list without waiting for a manual reload. iOS-only in practice. */
export const onWatchImported = (
  cb: (meetingId: string) => void,
): Promise<UnlistenFn> =>
  listen<string>("watch://imported", (e) => cb(e.payload));

/** Progress of a watch-inbox drain. Emitted three ways by `scan_and_import`:
 *  `{found}` at the start of a pass, `{importing,index,total}` per file, and
 *  `{imported}` when the pass finishes. Fields are mutually exclusive per event. */
export interface WatchScanEvent {
  /** Start of a pass: how many recordings were waiting. */
  found?: number;
  /** Per-file: the recording currently importing. */
  importing?: string;
  /** Per-file: 1-based position in the pass. */
  index?: number;
  /** Per-file / start: total recordings in the pass. */
  total?: number;
  /** End of a pass: how many imported successfully. */
  imported?: number;
}

/** Subscribe to watch-inbox drain progress (see {@link WatchScanEvent}). */
export const onWatchScan = (
  cb: (e: WatchScanEvent) => void,
): Promise<UnlistenFn> =>
  listen<WatchScanEvent>("watch://scan", (e) => cb(e.payload));

/** The paired watch's latest "waiting to sync" count (in transit + queued on
 *  the wrist), relayed through the phone's WatchConnectivity application context. */
export interface WatchPendingEvent {
  count: number;
}

/** Subscribe to the watch's pending-sync count. */
export const onWatchPending = (
  cb: (count: number) => void,
): Promise<UnlistenFn> =>
  listen<WatchPendingEvent>("watch://pending", (e) => cb(e.payload.count));

/** Manually drain the watch inbox. Resolves with the number of recordings found
 *  waiting on the phone at scan start (0 = nothing waiting). iOS-only; a no-op
 *  returning 0 on desktop. */
export const scanWatchInbox = (): Promise<number> =>
  invoke<number>("scan_watch_inbox");

/** Format milliseconds as m:ss. */
export function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Stable color class per speaker label. */
export function speakerColor(speaker: string): string {
  if (speaker === "Me") return "var(--color-speaker-me)";
  const palette = [
    "var(--color-speaker-1)",
    "var(--color-speaker-2)",
    "var(--color-speaker-3)",
    "var(--color-speaker-4)",
    "var(--color-speaker-5)",
  ];
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}
