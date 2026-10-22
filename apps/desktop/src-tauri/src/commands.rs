//! Tauri commands exposed to the frontend.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::recording::Recorder;
use crate::store::{self, FullMeeting, MeetingAttendees, MeetingMeta, Project, SaveMeetingInput};
use crate::transcribe::Segment;

/// Run a closure on the macOS main thread and block for its result.
/// Native file dialogs (NSOpenPanel/NSSavePanel) must run on the main thread.
#[cfg(desktop)]
pub(crate) fn run_on_main<T, F>(app: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// App-wide state: the active recorder (if any) and the SQLite index.
pub struct AppState {
    pub recorder: Mutex<Option<Recorder>>,
    pub db: Mutex<Connection>,
    /// Fallback root for saved meetings when no folder is chosen yet.
    pub fallback_root: PathBuf,
    /// True while a recording is active (read by the meeting detector to suppress prompts).
    pub recording: Arc<AtomicBool>,
    /// Whether meeting auto-detect (Phase 8) is enabled.
    pub detect_enabled: Arc<AtomicBool>,
    /// Diarized voices from the last stop_recording, waiting for save_meeting
    /// to attach them to a meeting id as speaker observations (Slice 1).
    pub pending_voices: Mutex<Vec<store::PendingObservation>>,
    /// Set by cancel_audio_import to abort an in-flight audio import (Slice 7).
    /// (Only read on desktop — audio import doesn't exist on mobile.)
    #[cfg_attr(mobile, allow(dead_code))]
    pub import_cancel: Arc<AtomicBool>,
    /// Change-triggered screenshare sampler state (Slice 4).
    #[cfg(desktop)]
    pub sampler: Mutex<ScreenshareSampler>,
    /// Wave C1: whether closing the window keeps the app in the menu bar.
    /// Cached from the `close_to_tray` setting; read on the CloseRequested hot
    /// path, updated by `set_close_to_tray`.
    #[cfg(desktop)]
    pub close_to_tray: Arc<AtomicBool>,
    /// Wave C1: set true by the tray's "Quit" so the close-to-tray guard steps
    /// aside and the app really exits.
    #[cfg(desktop)]
    pub real_quit: Arc<AtomicBool>,
}

/// State the screenshare sampler carries between ticks: the previous sample's
/// hash (stability), the last saved frame's hash (novelty), the last save
/// time (debounce). Reset when a recording starts.
#[cfg(desktop)]
#[derive(Default)]
pub struct ScreenshareSampler {
    prev_hash: Option<u64>,
    last_saved_hash: Option<u64>,
    last_save: Option<std::time::Instant>,
    /// Consecutive changed-but-never-settling ticks, feeding the motion
    /// fallback in `image_proc::should_save_tick` (a webcam tile or playing
    /// video inside the captured window must not block new slides forever).
    unsettled_ticks: u32,
    /// Persistent SCK stream on the sampled window — only kept when one-shot
    /// capture can't see it (fullscreen Space). Dropping it stops the helper.
    stream: Option<crate::capture::WindowStream>,
}

impl AppState {
    /// Resolve the current save root (chosen folder or fallback).
    fn save_root(&self, conn: &Connection) -> PathBuf {
        store::save_root(conn, &self.fallback_root)
    }
}

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    system_audio: bool,
    local_transcribe: bool,
    engine: Option<String>,
    voiceprints: Option<bool>,
    attendees: Option<Vec<String>>,
    // Quick voice memo (Wave B1): mic-only capture, diarization skipped so every
    // segment stays "Me". Absent/false = a normal meeting recording.
    mic_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.recorder.lock().map_err(|_| "state poisoned")?;
    if guard.is_some() {
        return Err("already recording".into());
    }
    // A live recording and system dictation both own the mic + a Whisper engine
    // — never both. Cancel any in-flight dictation before we grab the mic (the
    // reverse gate; the hotkey enforces the other direction). No-op if idle.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    crate::dictation::cancel(&app);
    let engine = engine.unwrap_or_else(|| crate::asr::WHISPER_ID.to_string());
    // Bias the decoder with the custom dictionary (explicit user terms, wins
    // conflicts) + workspace-card vocabulary + known speaker names (Slice 1)
    // + calendar attendee names (Slice 9, lowest precedence — passed in by
    // the frontend when a Microsoft account is connected and an event
    // overlaps now). Best-effort: unreadable files = no bias.
    let bias = {
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        let root = state.save_root(&conn);
        crate::asr::biasing::bias_from_sources(
            &store::read_dictionary_md(&root),
            &store::read_workspace_md(&root),
            &store::speaker_bias_names(&conn),
            attendees.as_deref().unwrap_or(&[]),
        )
    };
    // Keep a handle for the tray refresh below — `app` is moved into the recorder.
    #[cfg(desktop)]
    let app_for_tray = app.clone();
    let recorder = Recorder::start(
        app,
        system_audio,
        local_transcribe,
        engine,
        bias,
        voiceprints.unwrap_or(false),
        mic_only.unwrap_or(false),
    )?;
    *guard = Some(recorder);
    state.recording.store(true, Ordering::Relaxed);
    // Wave C1: reflect the live-recording indicator in the menu-bar tray.
    #[cfg(desktop)]
    crate::tray::refresh(&app_for_tray);
    // Meeting Copilot (CP1): if it's enabled, pre-create the (hidden) overlay so
    // its transcript ring buffer captures from the start of the meeting. No-op
    // when disabled. Fire-and-forget (it hops to the main thread internally).
    #[cfg(target_os = "macos")]
    crate::copilot::on_recording_started(&app_for_tray);
    // New meeting: drop any voices left over from an unsaved recording.
    if let Ok(mut pending) = state.pending_voices.lock() {
        pending.clear();
    }
    // A new meeting starts from a clean sampler (no stale hashes/debounce).
    #[cfg(desktop)]
    if let Ok(mut s) = state.sampler.lock() {
        *s = ScreenshareSampler::default();
    }
    Ok(())
}

/// Speech engines selectable in Settings: whisper (bundled default), Apple
/// Speech when eligible, plus whatever the `lalela-asr` sidecar advertises.
///
/// Async + `spawn_blocking` so it runs OFF the main thread: on iOS,
/// `list_all_engines` probes Apple availability through the in-process bridge
/// (semaphore + main-queue continuation), which would deadlock if run on the
/// main thread. Harmless on desktop (the probe just spawns a helper process).
#[tauri::command]
pub async fn list_asr_engines() -> Vec<crate::asr::EngineInfo> {
    tauri::async_runtime::spawn_blocking(crate::asr::list_all_engines)
        .await
        .unwrap_or_default()
}

/// The workspace card (`workspace.md` at the save root): company context the
/// AI prompts inject and the transcriber mines for vocabulary biasing.
#[tauri::command]
pub fn get_workspace_card(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    Ok(store::read_workspace_md(&state.save_root(&conn)))
}

#[tauri::command]
pub fn set_workspace_card(content: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::write_workspace_md(&state.save_root(&conn), &content)
}

/// The custom dictionary (`dictionary.md`): explicit transcription-bias terms,
/// `- term | weight | sounds-like` per line. Slice 0-ext.
#[tauri::command]
pub fn get_dictionary(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    Ok(store::read_dictionary_md(&state.save_root(&conn)))
}

#[tauri::command]
pub fn set_dictionary(content: String, state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::write_dictionary_md(&state.save_root(&conn), &content)?;
    // Echo how many terms parsed so the UI can confirm the format live.
    Ok(crate::asr::biasing::parse_dictionary(&content).len())
}

/// Parse-count preview for the dictionary editor (no write).
#[tauri::command]
pub fn preview_dictionary(content: String) -> usize {
    crate::asr::biasing::parse_dictionary(&content).len()
}

// ---------- External transcript import (Intelligence Layer, Slice 2) ----------

/// Native file picker for imports: transcripts/notes (Slice 2) or audio/video
/// recordings (Slice 7). The frontend dispatches on the picked extension.
#[cfg(desktop)]
#[tauri::command]
pub fn pick_import_file(app: AppHandle) -> Result<Option<String>, String> {
    run_on_main(&app, || {
        rfd::FileDialog::new()
            .set_title("Import a transcript, notes file or recording")
            .add_filter("Transcripts & notes", &["docx", "pdf", "txt", "md", "vtt"])
            .add_filter("Audio & video", crate::import::audio::AUDIO_EXTENSIONS)
            .pick_file()
            .map(|p| p.to_string_lossy().to_string())
    })
}

/// Extract + parse a file into an import preview (nothing is saved yet).
#[cfg(desktop)]
#[tauri::command]
pub fn import_preview(path: String) -> Result<crate::import::ImportPreview, String> {
    crate::import::preview_file(Path::new(&path))
}

// ---------- Bulk folder import ----------

/// Native folder picker for bulk import: every supported recording and
/// document inside is offered for one-pass import.
#[cfg(desktop)]
#[tauri::command]
pub fn pick_import_folder(app: AppHandle) -> Result<Option<String>, String> {
    run_on_main(&app, || {
        rfd::FileDialog::new()
            .set_title("Import a folder of recordings and notes")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
}

/// One candidate file found by `scan_import_folder`.
#[cfg(desktop)]
#[derive(serde::Serialize)]
pub struct FolderImportFile {
    pub path: String,
    pub filename: String,
    /// "audio" → Slice 7 pipeline; "document" → Slice 2 parser.
    pub kind: &'static str,
    pub size_bytes: u64,
    /// A file with this exact name was imported before (any meeting) — the
    /// UI deselects these by default so re-scanning a folder is idempotent.
    pub already_imported: bool,
}

/// Importable-looking files that never make sense to bulk-import: Lalela's
/// own per-meeting markdown, which would re-import the user's own library.
#[cfg(desktop)]
const OWN_MEETING_FILES: &[&str] = &["summary.md", "transcript.md", "notes.md"];

/// Recursively list every importable file under `path` (bounded), classified
/// for the bulk-import dialog. Hidden files/folders are skipped.
#[cfg(desktop)]
#[tauri::command]
pub fn scan_import_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FolderImportFile>, String> {
    const MAX_FILES: usize = 500;
    const MAX_DEPTH: usize = 4;

    let seen: std::collections::HashSet<String> = {
        let conn = state.db.lock().map_err(|_| "db poisoned")?;
        store::list_import_filenames(&conn)?.into_iter().collect()
    };

    fn walk(
        dir: &Path,
        depth: usize,
        seen: &std::collections::HashSet<String>,
        out: &mut Vec<FolderImportFile>,
        max_files: usize,
        max_depth: usize,
    ) {
        if depth > max_depth || out.len() >= max_files {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if out.len() >= max_files {
                return;
            }
            let p = entry.path();
            let Some(name) = p.file_name().and_then(|n| n.to_str()).map(String::from) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                walk(&p, depth + 1, seen, out, max_files, max_depth);
                continue;
            }
            let Some(kind) = classify_import_file(&name) else { continue };
            let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(FolderImportFile {
                path: p.to_string_lossy().to_string(),
                already_imported: seen.contains(&name),
                filename: name,
                kind,
                size_bytes,
            });
        }
    }

    let mut out = Vec::new();
    walk(Path::new(&path), 0, &seen, &mut out, MAX_FILES, MAX_DEPTH);
    out.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    Ok(out)
}

/// "audio" | "document" for a supported filename, `None` otherwise.
#[cfg(desktop)]
fn classify_import_file(filename: &str) -> Option<&'static str> {
    if OWN_MEETING_FILES.contains(&filename.to_ascii_lowercase().as_str()) {
        return None;
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    if crate::import::audio::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Some("audio");
    }
    if crate::import::DOC_EXTENSIONS.contains(&ext.as_str()) {
        return Some("document");
    }
    None
}

#[cfg(all(test, desktop))]
mod bulk_import_tests {
    use super::classify_import_file;

    #[test]
    fn classifies_audio_documents_and_junk() {
        assert_eq!(classify_import_file("standup.m4a"), Some("audio"));
        assert_eq!(classify_import_file("Call Recording.MP3"), Some("audio"));
        assert_eq!(classify_import_file("minutes.docx"), Some("document"));
        assert_eq!(classify_import_file("board-pack.pdf"), Some("document"));
        assert_eq!(classify_import_file("captions.vtt"), Some("document"));
        assert_eq!(classify_import_file("photo.jpg"), None);
        assert_eq!(classify_import_file("no-extension"), None);
    }

    #[test]
    fn never_reimports_lalelas_own_meeting_markdown() {
        assert_eq!(classify_import_file("summary.md"), None);
        assert_eq!(classify_import_file("transcript.md"), None);
        assert_eq!(classify_import_file("notes.md"), None);
        // …but a user's ordinary markdown notes are fine.
        assert_eq!(classify_import_file("weekly-notes.md"), Some("document"));
    }
}

/// Re-parse text that the AI structured into "[m:ss] Name: text" lines
/// (the LLM-assisted fallback for documents). Same parser as files.
#[cfg(desktop)]
#[tauri::command]
pub fn parse_import_text(text: String, format: String, title: String) -> crate::import::ImportPreview {
    let mut preview = crate::import::preview_text(&text, &format, &title);
    if preview.kind == "transcript" {
        preview.detected = Some("ai-structured".to_string());
    }
    preview
}

/// Save an import as a canonical meeting record + provenance row.
/// Transcripts keep their parsed segments (speaker names normalised against
/// the directory — no voiceprint enrolment, there is no audio); documents
/// store their text as notes, honestly, with no synthetic transcript.
#[cfg(desktop)]
#[tauri::command]
pub fn save_imported_meeting(
    title: String,
    project_id: Option<String>,
    preview: crate::import::ImportPreview,
    original_filename: String,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let root = state.save_root(&conn);

    let mut segments = preview.segments;
    for seg in segments.iter_mut() {
        seg.speaker = store::canonicalize_speaker_name(&conn, &seg.speaker);
    }
    let is_document = preview.kind != "transcript" || segments.is_empty();
    let notes = if is_document { preview.text.clone() } else { String::new() };

    let meeting = store::insert_meeting(
        &conn,
        SaveMeetingInput {
            title,
            project_id,
            segments: if is_document { Vec::new() } else { segments },
            notes,
            summary: String::new(),
            images: Vec::new(),
            attendees: None,
        },
        &root,
    )?;
    let trust = match preview.detected.as_deref() {
        Some("ai-structured") => "external-ai-structured",
        _ => "external-unverified",
    };
    store::record_import_source(
        &conn,
        &meeting.id,
        if is_document { "document" } else { "transcript" },
        &preview.format,
        &original_filename,
        trust,
        None,
        None,
    )?;
    Ok(meeting)
}

// ---------- Audio-file import (Intelligence Layer, Slice 7) ----------

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct ImportStatus {
    state: &'static str,
    message: Option<String>,
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct ImportProgress {
    processed_ms: i64,
    total_ms: i64,
}

/// Label stamped on every transcribed segment before diarization. The
/// diarizer relabels from this to "Speaker N" — the import analogue of the
/// live pipeline relabelling from "Me".
#[cfg(desktop)]
const IMPORT_BASE_SPEAKER: &str = "Speaker 1";

/// Abort an in-flight audio import at the next chunk boundary.
#[cfg(desktop)]
#[tauri::command]
pub fn cancel_audio_import(state: State<'_, AppState>) {
    state.import_cancel.store(true, Ordering::Relaxed);
}

/// Import an external recording through the REAL pipeline: decode → 16 kHz
/// mono PCM → AsrEngine (with biasing) → diarization → voiceprint matching →
/// canonical meeting record with `verified-audio` provenance. Unlike text
/// imports, audio imports CAN observe voiceprints — real audio exists.
#[cfg(desktop)]
#[tauri::command]
pub async fn import_audio_file(
    app: AppHandle,
    path: String,
    title: Option<String>,
    project_id: Option<String>,
    engine: Option<String>,
    voiceprints: Option<bool>,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    // Gather everything the blocking stage needs up front — the SQLite
    // connection can't cross into spawn_blocking.
    let bias = {
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        let root = state.save_root(&conn);
        crate::asr::biasing::bias_from_sources(
            &store::read_dictionary_md(&root),
            &store::read_workspace_md(&root),
            &store::speaker_bias_names(&conn),
            &[], // no calendar match for imported recordings
        )
    };
    let cancel = state.import_cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let engine = engine.unwrap_or_else(|| crate::asr::WHISPER_ID.to_string());
    let want_voiceprints = voiceprints.unwrap_or(false);
    let app_task = app.clone();
    let path_task = path.clone();

    let (mut segments, voices, duration_ms, source_rate, slides) =
        tauri::async_runtime::spawn_blocking(move || {
            let (segments, voices, duration_ms, source_rate) = run_audio_import(
                app_task.clone(),
                path_task.clone(),
                engine,
                bias,
                want_voiceprints,
                cancel.clone(),
            )?;
            // Visual pass (videos only): distinct slides + on-device OCR,
            // staged for the save below. Best-effort — audio-only on failure.
            let video_path = Path::new(&path_task);
            let slides = if crate::import::frames::is_video_path(video_path)
                && !cancel.load(Ordering::Relaxed)
            {
                match crate::paths::app_data_dir(&app_task) {
                    Ok(app_data) => {
                        let staging = crate::capture::live_staging_dir(&app_data);
                        let _ = std::fs::create_dir_all(&staging);
                        crate::import::frames::extract_slides(
                            &app_task, video_path, &staging, &cancel,
                        )
                    }
                    Err(_) => Vec::new(),
                }
            } else {
                Vec::new()
            };
            Ok::<_, String>((segments, voices, duration_ms, source_rate, slides))
        })
        .await
        .map_err(|e| format!("import task failed: {e}"))??;

    let file_path = Path::new(&path);
    let format = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let filename = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    let fallback_title = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported recording")
        .to_string();

    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    // Speaker auto-naming (Slice 1) — same matching as a live recording, but
    // observations attach immediately (the meeting is saved right here).
    let pending = match_voices(&conn, &mut segments, voices);
    let root = state.save_root(&conn);
    let meeting = store::insert_meeting(
        &conn,
        SaveMeetingInput {
            title: title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or(fallback_title),
            project_id,
            segments,
            notes: String::new(),
            summary: String::new(),
            // Video slides (staged WebPs; captions carry the on-device OCR
            // text) move into the meeting folder exactly like live captures.
            images: slides
                .into_iter()
                .map(|s| store::ImageInput {
                    t_ms: s.t_ms,
                    src_path: s.src_path,
                    caption: s.caption,
                })
                .collect(),
            attendees: None,
        },
        &root,
    )?;
    if !pending.is_empty() {
        store::record_observations(&conn, &meeting.id, &pending)?;
    }
    store::record_import_source(
        &conn,
        &meeting.id,
        "audio",
        &format,
        &filename,
        "verified-audio",
        Some(duration_ms),
        Some(source_rate as i64),
    )?;
    Ok(meeting)
}

/// The blocking half of import_audio_file: decode, transcribe in silence-cut
/// chunks (cancellable), diarize, optionally embed voiceprints.
#[cfg(desktop)]
fn run_audio_import(
    app: AppHandle,
    path: String,
    engine: String,
    bias: crate::asr::EngineBias,
    voiceprints: bool,
    cancel: Arc<AtomicBool>,
) -> Result<(Vec<Segment>, Vec<crate::recording::ClusterVoice>, i64, u32), String> {
    use crate::import::audio as audio_import;

    /// Chunks quieter than this RMS are silence — skipped, like live windows.
    const SILENCE_RMS: f32 = 0.006;

    let emit_status = |state: &'static str, message: &str| {
        let _ = app.emit(
            "import://status",
            ImportStatus { state, message: Some(message.to_string()) },
        );
    };

    emit_status("decoding", "Decoding audio…");
    let decoded = audio_import::decode_audio_file(Path::new(&path))?;
    let total_ms = decoded.duration_ms;
    if cancel.load(Ordering::Relaxed) {
        return Err("import cancelled".into());
    }

    // Same engine resolution + fallback notice as a live recording.
    let app_dl = app.clone();
    let (mut asr_engine, notice) = crate::asr::create_engine(&app, &engine, move |d, t| {
        let _ = app_dl.emit(
            "model://progress",
            serde_json::json!({ "downloaded": d, "total": t }),
        );
    })?;
    if let Some(notice) = notice {
        let _ = app.emit("asr://fallback", notice);
    }

    emit_status("transcribing", "Transcribing…");
    let mut segments: Vec<Segment> = Vec::new();
    for (s0, s1) in audio_import::chunk_spans(&decoded.samples_16k, 30, 10) {
        if cancel.load(Ordering::Relaxed) {
            return Err("import cancelled".into());
        }
        let chunk = &decoded.samples_16k[s0..s1];
        if crate::audio::rms(chunk) >= SILENCE_RMS {
            let offset_ms = s0 as i64 * 1000 / crate::transcribe::WHISPER_RATE as i64;
            let segs = asr_engine.transcribe(chunk, offset_ms, IMPORT_BASE_SPEAKER, &bias)?;
            for seg in &segs {
                let _ = app.emit("import://segment", seg.clone());
            }
            segments.extend(segs);
        }
        let processed_ms = s1 as i64 * 1000 / crate::transcribe::WHISPER_RATE as i64;
        let _ = app.emit("import://progress", ImportProgress { processed_ms, total_ms });
    }
    if segments.is_empty() {
        return Err("no speech was detected in this recording".into());
    }

    // Diarization + optional voiceprint embeddings — mirrors the live
    // pipeline (recording.rs run_diarization); every step is best-effort.
    let mut voices: Vec<crate::recording::ClusterVoice> = Vec::new();
    emit_status("diarizing", "Separating speakers…");
    let app_dl = app.clone();
    if let Ok((_seg_model, emb_model)) = crate::models::ensure_diarization_models(&app, move |d, t| {
        let _ = app_dl.emit(
            "model://progress",
            serde_json::json!({ "downloaded": d, "total": t }),
        );
    }) {
        if let Ok(mut diarizer) = crate::diarize::Diarizer::new(
            &_seg_model.to_string_lossy(),
            &emb_model.to_string_lossy(),
        ) {
            if let Ok(turns) = diarizer.compute(decoded.samples_16k.clone()) {
                let distinct = {
                    let mut ids: Vec<i32> = turns.iter().map(|t| t.speaker).collect();
                    ids.sort_unstable();
                    ids.dedup();
                    ids.len()
                };
                // Only relabel when there's genuinely more than one voice.
                if distinct > 1 {
                    crate::diarize::relabel(&mut segments, &turns, "Speaker ", IMPORT_BASE_SPEAKER);
                    if voiceprints {
                        if let Ok(mut embedder) =
                            crate::diarize::SpeakerEmbedder::new(&emb_model.to_string_lossy())
                        {
                            voices = embedder
                                .embed_clusters(&decoded.samples_16k, &turns)
                                .into_iter()
                                .map(|(cluster, embedding)| crate::recording::ClusterVoice {
                                    label: format!("Speaker {}", cluster + 1),
                                    embedding,
                                })
                                .collect();
                        }
                    }
                }
            }
        }
    }
    segments.sort_by_key(|s| s.t0_ms);
    Ok((segments, voices, total_ms, decoded.source_sample_rate))
}

/// Provenance for a meeting, if it was imported (trust badge in the UI).
#[tauri::command]
pub fn get_meeting_import_source(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Option<store::ImportSource>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    Ok(store::get_import_source(&conn, &meeting_id))
}

// ---------- Knowledge layer (Intelligence Layer, Slice 3) ----------

/// Local full-text retrieval over transcripts/summaries/notes (FTS5),
/// optionally scoped to a project. Powers grounded chat excerpts.
#[tauri::command]
pub fn search_transcripts(
    query: String,
    project_id: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<store::TranscriptHit>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::search_transcripts(&conn, &query, project_id.as_deref(), limit.unwrap_or(6))
}

/// Set-variant of `search_transcripts` scoped to a SET of folders (folder chat's
/// "include subfolders" mode). The frontend computes the descendant folder ids and
/// passes them all; an empty list yields no hits.
#[tauri::command]
pub fn search_transcripts_in(
    query: String,
    project_ids: Vec<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<store::TranscriptHit>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::search_transcripts_in(&conn, &query, &project_ids, limit.unwrap_or(6))
}

/// The rolling project brief (brief.md in the project folder).
#[tauri::command]
pub fn get_project_brief(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let root = state.save_root(&conn);
    store::read_project_brief(&conn, &project_id, &root)
}

#[tauri::command]
pub fn set_project_brief(
    project_id: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let root = state.save_root(&conn);
    store::write_project_brief(&conn, &project_id, &content, &root)
}

/// Persist LLM-compiled wiki pages for a meeting (provenance required —
/// pages without facts are dropped). Returns how many pages were written.
#[tauri::command]
pub fn upsert_wiki_pages(
    meeting_id: String,
    pages: Vec<store::WikiPageInput>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    let root = state.save_root(&conn);
    store::upsert_wiki_pages(&conn, &meeting_id, pages, &root)
}

#[tauri::command]
pub fn list_wiki_pages(state: State<'_, AppState>) -> Result<Vec<store::WikiPageRow>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::list_wiki_pages(&conn)
}

#[tauri::command]
pub fn get_wiki_page(
    id: String,
    state: State<'_, AppState>,
) -> Result<store::WikiPageDetail, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let root = state.save_root(&conn);
    store::get_wiki_page(&conn, &id, &root)
}

// ---------- Speaker directory (Intelligence Layer, Slice 1) ----------

#[tauri::command]
pub fn list_speakers(state: State<'_, AppState>) -> Result<Vec<crate::speakers::Speaker>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::list_speakers(&conn)
}

#[tauri::command]
pub fn rename_speaker(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::speakers::Speaker>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::rename_speaker(&conn, &id, &name)?;
    store::list_speakers(&conn)
}

#[tauri::command]
pub fn delete_speaker(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::speakers::Speaker>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::delete_speaker(&conn, &id)?;
    store::list_speakers(&conn)
}

#[tauri::command]
pub fn merge_speakers(
    keep_id: String,
    merged_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::speakers::Speaker>, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::merge_speakers(&conn, &keep_id, &merged_id)?;
    store::list_speakers(&conn)
}

/// "This is X" on a meeting speaker — THE correction/enrolment loop (Slice 1).
/// Relabels every `from_label` segment in the meeting to the given name,
/// creates the speaker if new, and enrols/updates their voiceprint from the
/// voice observed in this meeting (when one was recorded and consent is on —
/// observations only exist when the voiceprint toggle was on at record time).
#[tauri::command]
pub fn label_meeting_speaker(
    meeting_id: String,
    from_label: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    let root = state.save_root(&conn);
    let speaker_id = store::get_or_create_speaker(&conn, &name)?;
    // Canonical display name (the label may have matched an alias).
    let canonical: String = conn
        .query_row("SELECT name FROM speakers WHERE id=?1", [speaker_id.as_str()], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let _ = store::enroll_speaker_from_meeting(&conn, &meeting_id, &from_label, &speaker_id)?;
    store::relabel_meeting_speaker(&conn, &meeting_id, &from_label, &canonical, &root)
}

/// Stop recording and return the final, diarized, time-sorted transcript.
///
/// `async` + `spawn_blocking`: `Recorder::stop()` joins the capture threads and
/// runs the diarization pass, which must not run on the main thread or a wedged
/// mic thread would freeze the whole UI. The join itself is time-bounded inside
/// `stop()`, so this can never hang indefinitely.
#[cfg_attr(mobile, allow(unused_variables))]
#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Segment>, String> {
    let recorder = state
        .recorder
        .lock()
        .map_err(|_| "state poisoned")?
        .take();
    state.recording.store(false, Ordering::Relaxed);
    // Wave C1: clear the tray's live-recording indicator.
    #[cfg(desktop)]
    crate::tray::refresh(&app);
    // Recording is over: release the sampler's persistent window stream (if
    // any) so its helper — and the system capture indicator — go away now,
    // not at the start of the next recording.
    #[cfg(desktop)]
    if let Ok(mut s) = state.sampler.lock() {
        s.stream = None;
    }
    let Some(r) = recorder else {
        return Err("not recording".into());
    };
    let (mut segments, voices) = tauri::async_runtime::spawn_blocking(move || r.stop())
        .await
        .map_err(|e| format!("stop task failed: {e}"))?;

    // Speaker auto-naming (Slice 1): match each diarized voice against
    // enrolled voiceprints; matches replace the generic "Speaker N" labels.
    // Everything observed is stashed so save_meeting can record it — enabling
    // the later manual "this is X" enrolment even for unmatched voices.
    if !voices.is_empty() {
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        let pending = match_voices(&conn, &mut segments, voices);
        *state.pending_voices.lock().map_err(|_| "state poisoned")? = pending;
    }
    Ok(segments)
}

/// Match diarized voices against enrolled voiceprints (Slice 1): a match
/// relabels that voice's generic "Speaker N" segments in place; every voice
/// (matched or not) becomes a PendingObservation for recording/enrolment.
/// Shared by live recordings (stop_recording) and audio imports (Slice 7).
fn match_voices(
    conn: &Connection,
    segments: &mut [Segment],
    voices: Vec<crate::recording::ClusterVoice>,
) -> Vec<store::PendingObservation> {
    if voices.is_empty() {
        return Vec::new();
    }
    let enrolled = store::speakers_with_voiceprints(conn).unwrap_or_default();
    let prints: Vec<Vec<f32>> = enrolled.iter().map(|(_, _, e)| e.clone()).collect();
    let mut pending = Vec::new();
    for voice in voices {
        match crate::speakers::best_match(&voice.embedding, &prints) {
            Some((idx, confidence)) => {
                let (id, name, _) = &enrolled[idx];
                for seg in segments.iter_mut() {
                    if seg.speaker == voice.label {
                        seg.speaker = name.clone();
                    }
                }
                pending.push(store::PendingObservation {
                    label: name.clone(),
                    speaker_id: Some(id.clone()),
                    embedding: voice.embedding,
                    confidence,
                });
            }
            None => pending.push(store::PendingObservation {
                label: voice.label,
                speaker_id: None,
                embedding: voice.embedding,
                confidence: 0.0,
            }),
        }
    }
    pending
}

/// Stop a cloud-mode recording: capture ends, the mic audio is resampled to
/// 16 kHz mono and written as a temp WAV, and its path is returned for
/// `cloud_transcribe`. (Same non-blocking rules as `stop_recording`.)
#[tauri::command]
pub async fn stop_recording_wav(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let recorder = state
        .recorder
        .lock()
        .map_err(|_| "state poisoned")?
        .take();
    state.recording.store(false, Ordering::Relaxed);
    // Wave C1: clear the tray's live-recording indicator.
    #[cfg(desktop)]
    crate::tray::refresh(&app);
    // Recording is over: release the sampler's persistent window stream (if
    // any) so its helper — and the system capture indicator — go away now,
    // not at the start of the next recording.
    #[cfg(desktop)]
    if let Ok(mut s) = state.sampler.lock() {
        s.stream = None;
    }
    let Some(r) = recorder else {
        return Err("not recording".into());
    };
    let app_data = crate::paths::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (samples, rate) = r.stop_audio();
        if samples.is_empty() {
            return Err("no audio was captured".to_string());
        }
        let samples_16k = crate::audio::resample_to_16k(&samples, rate);
        let dir = app_data.join("cloud");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("rec-{millis}.wav"));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
        for s in samples_16k {
            writer
                .write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("stop task failed: {e}"))?
}

/// Transcribe an exported WAV via the hosted cloud route (see `cloud.rs`).
#[tauri::command]
pub async fn cloud_transcribe(
    app: AppHandle,
    wav_path: String,
    access_token: String,
    endpoint: String,
) -> Result<Vec<Segment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::cloud::transcribe(&app, &wav_path, &access_token, &endpoint)
    })
    .await
    .map_err(|e| format!("cloud task failed: {e}"))?
}

/// Enable/disable meeting auto-detect (Phase 8).
#[tauri::command]
pub fn set_detection_enabled(enabled: bool, state: State<'_, AppState>) {
    state.detect_enabled.store(enabled, Ordering::Relaxed);
}

/// Wave C1: push the next few calendar events into the menu-bar tray. Called by
/// the frontend (`trayAgenda.ts`) on launch + every 5 min when signed into
/// Microsoft; an empty list simply clears the agenda section. Desktop-only.
#[cfg(desktop)]
#[tauri::command]
pub fn set_tray_agenda(app: AppHandle, items: Vec<crate::tray::AgendaItem>) {
    crate::tray::set_agenda(&app, items);
}

/// Wave C1: read the close-to-tray setting (default ON) for the Settings toggle.
#[cfg(desktop)]
#[tauri::command]
pub fn get_close_to_tray(state: State<'_, AppState>) -> bool {
    state.close_to_tray.load(Ordering::Relaxed)
}

/// Wave C1: persist + cache the close-to-tray setting. The DB row is the source
/// of truth at next launch; the AtomicBool is the hot-path cache read on close.
#[cfg(desktop)]
#[tauri::command]
pub fn set_close_to_tray(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    let conn = state.db.lock().map_err(|_| "state poisoned")?;
    store::set_setting(&conn, "close_to_tray", if enabled { "1" } else { "0" })
}

// ─────────────────────────── Alternate app icon (E1) ───────────────────────
// A cosmetic reward on the same honor-system unlock as themes/badges — nothing
// functional is ever gated. macOS-desktop-only: it swaps the RUNNING Dock icon
// via NSApplication.applicationIconImage (the static bundle .icns is unchanged —
// see docs/DECISIONS.md). These wrappers compile on EVERY target (they're in
// both invoke-handler lists) so the shared frontend can probe uniformly; off
// macOS they report `supported: false` and the setter is inert.

/// What the Settings "App icon" picker needs to render the applied state.
#[derive(serde::Serialize)]
pub struct AppIconStatus {
    /// True only on macOS — the picker hides itself otherwise.
    pub supported: bool,
    /// The active icon id ("default" for the stock mark).
    pub active: String,
}

#[tauri::command]
pub fn app_icon_status(state: State<'_, AppState>) -> AppIconStatus {
    #[cfg(target_os = "macos")]
    {
        let active = state
            .db
            .lock()
            .ok()
            .and_then(|c| store::get_setting(&c, crate::app_icon::KEY_ACTIVE))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| crate::app_icon::DEFAULT_ID.to_string());
        AppIconStatus { supported: true, active }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        AppIconStatus { supported: false, active: "default".to_string() }
    }
}

/// Persist + apply the chosen app icon to the running Dock icon. Inert (Ok) off
/// macOS so the shared frontend can call it without a platform branch.
#[tauri::command]
pub fn set_app_icon(_app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::app_icon::set_active(&_app, &id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Ok(())
    }
}

// ─────────────────────────── System dictation (Wave B2) ────────────────────
// The feature runs on macOS and Windows desktop (the OS layer lives in
// dictation.rs). These wrappers are compiled on every desktop
// target so the invoke-handler list stays uniform across desktop; on non-macOS
// desktop they report `supported: false` and the mutators are inert.

/// Everything the Settings "Dictation" section needs to render.
#[derive(serde::Serialize)]
pub struct DictationStatus {
    /// True on macOS and Windows — the section hides itself otherwise.
    pub supported: bool,
    /// Whether the global hotkey is currently armed.
    pub enabled: bool,
    /// The bound accelerator (Tauri format, e.g. "CmdOrCtrl+Shift+D").
    pub shortcut: String,
    /// Whether this app is trusted for Accessibility (required to paste).
    pub accessibility: bool,
    /// Whether a secure input field is focused right now (paste would be blocked).
    pub secure_input: bool,
}

#[cfg(desktop)]
#[tauri::command]
pub fn dictation_status(state: State<'_, AppState>) -> DictationStatus {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (enabled, shortcut) = match state.db.lock() {
            Ok(conn) => {
                let enabled =
                    store::get_setting(&conn, "dictation.enabled").as_deref() == Some("true");
                let shortcut = store::get_setting(&conn, "dictation.shortcut")
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| crate::dictation::DEFAULT_SHORTCUT.to_string());
                (enabled, shortcut)
            }
            Err(_) => (false, crate::dictation::DEFAULT_SHORTCUT.to_string()),
        };
        DictationStatus {
            supported: true,
            enabled,
            shortcut,
            accessibility: crate::dictation::accessibility_trusted(),
            secure_input: crate::dictation::secure_input_active(),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        DictationStatus {
            supported: false,
            enabled: false,
            shortcut: String::new(),
            accessibility: false,
            secure_input: false,
        }
    }
}

/// Arm/disarm the dictation hotkey (persists + registers/unregisters live).
#[cfg(desktop)]
#[tauri::command]
pub fn set_dictation_enabled(_app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        crate::dictation::set_enabled(&_app, enabled)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = enabled;
        Ok(())
    }
}

/// Re-bind the dictation hotkey to a new accelerator (persists + rebinds live).
#[cfg(desktop)]
#[tauri::command]
pub fn set_dictation_shortcut(_app: AppHandle, shortcut: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        crate::dictation::set_shortcut(&_app, &shortcut)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = shortcut;
        Ok(())
    }
}

// These three run on a worker thread (not the invoking thread): toggle/finish
// marshal AppKit + window work back to the main thread and BLOCK on it, so they
// must never execute on the main thread themselves (same reason as the hotkey
// handler). Fire-and-forget — the overlay reacts to backend events.

/// Toggle a dictation session by hand (the Settings "Try it" button). Same code
/// path the global hotkey drives.
#[cfg(desktop)]
#[tauri::command]
pub fn trigger_dictation(_app: AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    std::thread::spawn(move || crate::dictation::toggle(_app));
}

/// Finish the active dictation (overlay Enter / hotkey-again). Transcribes and
/// pastes into the captured target app.
#[cfg(desktop)]
#[tauri::command]
pub fn finish_dictation(_app: AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    std::thread::spawn(move || crate::dictation::finish(&_app));
}

/// Cancel + discard the active dictation (overlay Esc).
#[cfg(desktop)]
#[tauri::command]
pub fn cancel_dictation(_app: AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    std::thread::spawn(move || crate::dictation::cancel(&_app));
}

// ─────────────────────────── Meeting Copilot (CP1) ─────────────────────────
// macOS-desktop-only (second WebviewWindow + AppKit hardening + the global
// hotkey). Wrappers compile on every desktop target so the invoke-handler list
// stays uniform; on non-macOS desktop they report `supported: false` and the
// mutators are inert.

/// Everything the Settings "Meeting Copilot" section needs to render.
#[derive(serde::Serialize)]
pub struct CopilotStatus {
    /// True only on macOS — the section hides itself otherwise.
    pub supported: bool,
    /// Whether the global hotkey is currently armed.
    pub enabled: bool,
    /// The bound accelerator (Tauri format, e.g. "CmdOrCtrl+Shift+A").
    pub shortcut: String,
    /// Whether the overlay is showing right now.
    pub visible: bool,
}

#[cfg(desktop)]
#[tauri::command]
pub fn copilot_status(_app: AppHandle, state: State<'_, AppState>) -> CopilotStatus {
    #[cfg(target_os = "macos")]
    {
        let (enabled, shortcut) = match state.db.lock() {
            Ok(conn) => {
                let enabled =
                    store::get_setting(&conn, "copilot.enabled").as_deref() == Some("true");
                let shortcut = store::get_setting(&conn, "copilot.shortcut")
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| crate::copilot::DEFAULT_SHORTCUT.to_string());
                (enabled, shortcut)
            }
            Err(_) => (false, crate::copilot::DEFAULT_SHORTCUT.to_string()),
        };
        CopilotStatus {
            supported: true,
            enabled,
            shortcut,
            visible: crate::copilot::is_visible(&_app),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, _app);
        CopilotStatus {
            supported: false,
            enabled: false,
            shortcut: String::new(),
            visible: false,
        }
    }
}

/// Arm/disarm the copilot hotkey (persists + registers/unregisters live).
#[cfg(desktop)]
#[tauri::command]
pub fn set_copilot_enabled(_app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::copilot::set_enabled(&_app, enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

// show/hide/toggle run on a worker thread: they marshal AppKit + window work
// back to the main thread and BLOCK on it, so they must never execute on the
// invoking (async-runtime) thread if it happens to be main. Fire-and-forget.

/// Show the overlay (Settings "Try it" button).
#[cfg(desktop)]
#[tauri::command]
pub fn copilot_show(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || crate::copilot::show(&_app));
}

/// Hide the overlay (the overlay's ✕).
#[cfg(desktop)]
#[tauri::command]
pub fn copilot_hide(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || crate::copilot::hide(&_app));
}

/// Toggle overlay visibility (same code path the hotkey drives).
#[cfg(desktop)]
#[tauri::command]
pub fn copilot_toggle(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || crate::copilot::toggle(_app));
}

/// Capture the current screen for the Meeting Copilot's opt-in "screen
/// awareness" (CP4). Silently grabs the full screen (no picker, no shutter via
/// `capture::screencapture`), downscales it IN MEMORY to ≤`COPILOT_MAX_EDGE` on
/// the long edge, encodes JPEG (~q70), and returns a base64 `data:` URL. The
/// temp PNG lives in the OS temp dir and is deleted immediately after decode —
/// NOTHING is ever written into a meeting folder and the frame is never
/// persisted. When Screen Recording permission is missing, returns the
/// `SCREEN_PERMISSION_ERR` sentinel so the overlay shows a "grant permission"
/// hint. Called only on-demand (a copilot chip), never on a background loop.
#[cfg(desktop)]
#[tauri::command]
pub async fn copilot_capture_screen() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // The capture + encode is blocking (screencapture is a subprocess); keep
        // it off the async runtime thread.
        tauri::async_runtime::spawn_blocking(|| {
            use base64::Engine as _;
            // Preflight TCC: fail fast with an actionable error instead of a
            // windowless frame.
            if !crate::capture::has_screen_recording_permission() {
                return Err(crate::capture::SCREEN_PERMISSION_ERR.to_string());
            }
            // Temp file OUTSIDE any meeting folder; deleted right after decode.
            let tmp = std::env::temp_dir().join(crate::capture::capture_filename());
            let produced = crate::capture::screencapture(&tmp, false);
            let wrote = match produced {
                Ok(w) => w,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e);
                }
            };
            if !wrote {
                let _ = std::fs::remove_file(&tmp);
                // No file despite a granted-looking state: treat as a permission /
                // capture failure the UI can act on.
                return Err(crate::capture::SCREEN_PERMISSION_ERR.to_string());
            }
            let decoded = crate::image_proc::decode(&tmp);
            let _ = std::fs::remove_file(&tmp); // never persist — delete now
            let img = decoded?;
            let bytes = crate::image_proc::to_jpeg_downscaled(
                &img,
                crate::image_proc::COPILOT_MAX_EDGE,
                crate::image_proc::COPILOT_JPEG_QUALITY,
            )?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(format!("data:image/jpeg;base64,{b64}"))
        })
        .await
        .map_err(|e| format!("screen capture task failed: {e}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Screen awareness is only available on macOS.".into())
    }
}

/// Manually drain the Apple Watch inbox (iOS). Returns the number of WAV files
/// found waiting at scan start (0 = nothing on the phone yet). The actual import
/// runs on a background thread and reports progress via `watch://scan`. A no-op
/// returning `Ok(0)` on desktop, where there is no watch inbox.
#[tauri::command]
pub fn scan_watch_inbox(_app: AppHandle) -> Result<usize, String> {
    #[cfg(target_os = "ios")]
    {
        Ok(crate::watch_inbox::scan_now(&_app))
    }
    // Android + desktop share the no-op: neither has a watch inbox. Kept as
    // `not(ios)` (not `desktop`) so the Android build also compiles this arm.
    #[cfg(not(target_os = "ios"))]
    {
        Ok(0)
    }
}

#[tauri::command]
pub fn is_recording(state: State<'_, AppState>) -> bool {
    state
        .recorder
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// Generate a summary from a transcript using the selected prompt + model.
/// Model ids of the form `local:<file.gguf>` route to the on-device model
/// (no API key needed); anything else goes to OpenRouter. Async +
/// spawn_blocking because local inference can take minutes.
#[tauri::command]
pub async fn summarize(
    app: AppHandle,
    transcript: String,
    prompt: String,
    model: String,
    api_key: String,
    // Optional response cap (Wave A1). None ⇒ each backend's legacy default:
    // uncapped for OpenRouter, 2048 for the local sidecar, self-managed for
    // Apple (its Foundation Models window is fixed, so length is a no-op there).
    max_tokens: Option<u32>,
    // Optional base64 `data:` URL (CP4 screen awareness). Carried only on the
    // BYOK/OpenRouter vision lane; local + Apple models can't see images so it
    // is ignored there.
    image: Option<String>,
) -> Result<crate::gateway::SummarizeOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // `apple:*` ids route to Apple's on-device Foundation Models (macOS 26+
        // via the resident helper, iOS 26+ via the in-process bridge; no API
        // key). Checked before `local:` and never present in the shared MODELS
        // catalog, so the free-tier proxy never sees it.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if model.strip_prefix("apple:").is_some() {
            return crate::apple_llm::generate(&prompt, &transcript).map(|content| {
                crate::gateway::SummarizeOutput {
                    content,
                    tokens: None,
                }
            });
        }
        #[cfg(desktop)]
        if let Some(file) = model.strip_prefix("local:") {
            let llm = app.state::<crate::local_llm::LlmState>();
            return crate::local_llm::generate(&app, &llm, file, &prompt, &transcript, max_tokens)
                .map(|content| crate::gateway::SummarizeOutput {
                    content,
                    tokens: None,
                });
        }
        let _ = &app;
        crate::gateway::summarize(&transcript, &prompt, &model, &api_key, max_tokens, image.as_deref())
    })
    .await
    .map_err(|e| format!("summarize task failed: {e}"))?
}

#[tauri::command]
pub fn set_paused(paused: bool, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.recorder.lock().map_err(|_| "state poisoned")?;
    match guard.as_ref() {
        Some(r) => {
            r.set_paused(paused);
            Ok(())
        }
        None => Err("not recording".into()),
    }
}

// ---------- Workflows (prompt pipelines) ----------

#[tauri::command]
pub fn list_workflows(state: State<'_, AppState>) -> Result<Vec<store::Workflow>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_workflows(&conn)
}

#[tauri::command]
pub fn save_workflow(
    workflow: store::Workflow,
    state: State<'_, AppState>,
) -> Result<store::Workflow, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::save_workflow(&conn, workflow)
}

#[tauri::command]
pub fn delete_workflow(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_workflow(&conn, &id)
}

#[tauri::command]
pub fn get_workflow_outputs(
    meeting_id: String,
    workflow_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::WorkflowOutput>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::get_workflow_outputs(&conn, &meeting_id, &workflow_id)
}

#[tauri::command]
pub fn set_workflow_output(
    meeting_id: String,
    workflow_id: String,
    block_id: String,
    output: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::set_workflow_output(&conn, &meeting_id, &workflow_id, &block_id, &output)
}

// ---------- Tags + automations (phase 19) ----------

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<store::Tag>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_tags(&conn)
}

#[tauri::command]
pub fn save_tag(tag: store::Tag, state: State<'_, AppState>) -> Result<store::Tag, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::save_tag(&conn, tag)
}

#[tauri::command]
pub fn delete_tag(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_tag(&conn, &id)
}

#[tauri::command]
pub fn get_meeting_tags(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::get_meeting_tags(&conn, &meeting_id)
}

#[tauri::command]
pub fn set_meeting_tags(
    meeting_id: String,
    tag_ids: Vec<String>,
    added_by: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::set_meeting_tags(
        &conn,
        &meeting_id,
        &tag_ids,
        added_by.as_deref().unwrap_or("manual"),
    )
}

#[tauri::command]
pub fn add_meeting_tag(
    meeting_id: String,
    tag_id: String,
    added_by: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::add_meeting_tag(
        &conn,
        &meeting_id,
        &tag_id,
        added_by.as_deref().unwrap_or("rule"),
    )
}

#[tauri::command]
pub fn list_meeting_tags(state: State<'_, AppState>) -> Result<Vec<store::MeetingTag>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_meeting_tags(&conn)
}

#[tauri::command]
pub fn list_automations(state: State<'_, AppState>) -> Result<Vec<store::Automation>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_automations(&conn)
}

#[tauri::command]
pub fn upsert_automation(
    automation: store::Automation,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::upsert_automation(&conn, &automation)
}

#[tauri::command]
pub fn delete_automation(tag_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_automation(&conn, &tag_id)
}

#[tauri::command]
pub fn record_automation_run(
    run: store::AutomationRun,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::record_automation_run(&conn, &run)
}

#[tauri::command]
pub fn update_automation_run_status(
    meeting_id: String,
    tag_id: String,
    action: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::update_automation_run_status(&conn, &meeting_id, &tag_id, &action, &status)
}

#[tauri::command]
pub fn has_automation_run(
    meeting_id: String,
    tag_id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::has_automation_run(&conn, &meeting_id, &tag_id, &action)
}

#[tauri::command]
pub fn list_automation_runs(
    meeting_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<store::AutomationRun>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = meeting_id.map(|id| store::resolve_meeting_id(&conn, &id));
    store::list_automation_runs(&conn, meeting_id.as_deref())
}

// ---------- Reports (phase 20) ----------

#[tauri::command]
pub fn list_reports(state: State<'_, AppState>) -> Result<Vec<store::Report>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_reports(&conn)
}

#[tauri::command]
pub fn save_report(report: store::Report, state: State<'_, AppState>) -> Result<store::Report, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::save_report(&conn, report)
}

#[tauri::command]
pub fn delete_report(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_report(&conn, &id)
}

#[tauri::command]
pub fn touch_report_last_run(
    id: String,
    ran_at: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::touch_report_last_run(&conn, &id, ran_at)
}

#[tauri::command]
pub fn list_report_outputs(
    report_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::ReportOutput>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_report_outputs(&conn, &report_id)
}

#[tauri::command]
pub fn insert_report_output(
    output: store::ReportOutput,
    state: State<'_, AppState>,
) -> Result<store::ReportOutput, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::insert_report_output(&conn, output)
}

#[tauri::command]
pub fn delete_report_output(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_report_output(&conn, &id)
}

#[tauri::command]
pub fn list_report_meetings(
    state: State<'_, AppState>,
) -> Result<Vec<store::ReportMeetingRow>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_report_meetings(&conn)
}

// ---------- Apple Intelligence (macOS 26+ / iOS 26+ on-device synthesis) ----------

/// Availability of Apple's on-device Foundation Models LLM, for the Settings
/// card + model-picker gating. Defined cross-platform (the struct itself) so the
/// command below compiles everywhere; both Apple platforms now probe for real
/// (macOS via the resident helper, iOS via the bridge). `reason` is a
/// human-readable string only when the feature is present but currently unusable;
/// absent/ineligible → `available:false` with no reason (the UI hides the card
/// and looks exactly as today).
#[derive(serde::Serialize, Default, Clone)]
pub struct AppleLlmStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Probe Apple-Intelligence availability. Async (runs off the main thread) to
/// spawn the helper (macOS) or cross the in-process bridge (iOS);
/// `apple_llm::status()` itself is cached and never blocks behind an in-flight
/// generation (so the picker's option can't flicker out mid-generation). Never
/// an error for mere absence — a missing helper, an ineligible device, an old
/// OS, or a non-Apple build all resolve to unavailable.
#[tauri::command]
pub async fn apple_llm_status() -> AppleLlmStatus {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // spawn_blocking keeps the probe off the main thread — required on iOS,
        // where the bridge's async continuations land on the main queue.
        tauri::async_runtime::spawn_blocking(|| crate::apple_llm::status().unwrap_or_default())
            .await
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        AppleLlmStatus::default()
    }
}

// ---------- Local LLM (desktop only) ----------

#[cfg(desktop)]
#[derive(serde::Serialize)]
pub struct LlmStatus {
    pub file: String,
    pub present: bool,
    pub size_bytes: u64,
    pub running: bool,
}

/// Status for each catalog model file the frontend asks about.
#[cfg(desktop)]
#[tauri::command]
pub fn local_llm_status(
    app: AppHandle,
    files: Vec<String>,
    llm: State<'_, crate::local_llm::LlmState>,
) -> Result<Vec<LlmStatus>, String> {
    let dir = crate::local_llm::models_dir(&app)?;
    let running = crate::local_llm::running_model(&llm);
    files
        .into_iter()
        .map(|file| {
            crate::local_llm::safe_model_file(&file)?;
            let path = dir.join(&file);
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            Ok(LlmStatus {
                present: path.exists(),
                size_bytes: size,
                running: running.as_deref() == Some(file.as_str()),
                file,
            })
        })
        .collect()
}

/// Start a catalog-model download on a background thread and return
/// immediately. Progress streams as `llm://progress` AND is recorded in the
/// `DownloadRegistry` so the UI can restore its state after navigating away.
/// Completion fires `llm://complete` + an OS notification. Calling again while a
/// file is already downloading is a no-op (the existing thread keeps running).
#[cfg(desktop)]
#[tauri::command]
pub fn start_model_download(
    app: AppHandle,
    url: String,
    file: String,
    sha256: Option<String>,
    label: Option<String>,
    reg: State<'_, crate::downloads::DownloadRegistry>,
) -> Result<(), String> {
    use crate::downloads::DownloadState;

    crate::local_llm::safe_model_file(&file)?;
    // Catalog URLs are trusted code, but re-validate across the IPC boundary.
    if !url.starts_with("https://huggingface.co/") {
        return Err("model downloads are restricted to huggingface.co".into());
    }
    // Don't start a second thread for a file that's already in flight.
    {
        let map = reg.0.lock().map_err(|_| "download registry poisoned")?;
        if map.get(&file).map(|s| s.status == "downloading").unwrap_or(false) {
            return Ok(());
        }
    }
    let dest = crate::local_llm::models_dir(&app)?.join(&file);
    {
        let mut map = reg.0.lock().map_err(|_| "download registry poisoned")?;
        map.insert(
            file.clone(),
            DownloadState {
                file: file.clone(),
                status: "downloading".into(),
                ..Default::default()
            },
        );
    }

    let display = label.unwrap_or_else(|| file.clone());
    std::thread::spawn(move || {
        let pfile = file.clone();
        let progress_app = app.clone();
        let result = crate::models::download_resumable(
            &url,
            &dest,
            sha256.as_deref(),
            move |downloaded, total| {
                if let Some(reg) = progress_app.try_state::<crate::downloads::DownloadRegistry>() {
                    if let Ok(mut map) = reg.0.lock() {
                        if let Some(s) = map.get_mut(&pfile) {
                            s.downloaded = downloaded;
                            s.total = total;
                        }
                    }
                }
                let _ = progress_app.emit(
                    "llm://progress",
                    serde_json::json!({ "file": pfile, "downloaded": downloaded, "total": total }),
                );
            },
        );

        match result {
            Ok(()) => {
                if let Some(reg) = app.try_state::<crate::downloads::DownloadRegistry>() {
                    if let Ok(mut map) = reg.0.lock() {
                        if let Some(s) = map.get_mut(&file) {
                            s.status = "done".into();
                        }
                    }
                }
                let _ = app.emit(
                    "llm://complete",
                    serde_json::json!({ "file": file, "ok": true }),
                );
                // Gated by the "Local model ready" notification preference
                // (Wave C3). Read backend-side because this fires from Rust,
                // where the frontend's localStorage settings aren't visible.
                if model_ready_notifications_enabled(&app) {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("Local model ready")
                        .body(format!("{display} finished downloading and is ready to use."))
                        .show();
                }
            }
            Err(e) => {
                if let Some(reg) = app.try_state::<crate::downloads::DownloadRegistry>() {
                    if let Ok(mut map) = reg.0.lock() {
                        if let Some(s) = map.get_mut(&file) {
                            s.status = "error".into();
                            s.error = Some(e.clone());
                        }
                    }
                }
                let _ = app.emit(
                    "llm://complete",
                    serde_json::json!({ "file": file, "ok": false, "error": e }),
                );
            }
        }
    });
    Ok(())
}

/// Current download state for every model file touched this session. The UI
/// calls this on mount to restore in-progress bars.
#[cfg(desktop)]
#[tauri::command]
pub fn model_download_status(
    reg: State<'_, crate::downloads::DownloadRegistry>,
) -> Vec<crate::downloads::DownloadState> {
    reg.0
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

/// Delete a downloaded model (unloads it first if running).
#[cfg(desktop)]
#[tauri::command]
pub fn delete_local_llm(
    app: AppHandle,
    file: String,
    llm: State<'_, crate::local_llm::LlmState>,
) -> Result<(), String> {
    crate::local_llm::safe_model_file(&file)?;
    if crate::local_llm::running_model(&llm).as_deref() == Some(file.as_str()) {
        crate::local_llm::unload(&llm);
    }
    let path = crate::local_llm::models_dir(&app)?.join(&file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let part = path.with_extension("part");
    if part.exists() {
        let _ = std::fs::remove_file(&part);
    }
    Ok(())
}

/// Kill the inference sidecar, reclaiming its memory (~4 GB when loaded).
#[cfg(desktop)]
#[tauri::command]
pub fn unload_local_llm(llm: State<'_, crate::local_llm::LlmState>) {
    crate::local_llm::unload(&llm);
}

// ---------- Manage local models (Storage UI) ----------

/// Every model file on disk (LLM GGUF, whisper GGML, ONNX diarization), largest
/// first, with a total. `in_use` is set here from the two things `model_store`
/// can't see: the LLM resident in the sidecar, and — for ASR/diarization —
/// whether a recording is currently live (its engines are loaded for the whole
/// capture). Drives the disk-reclaim section of Settings → Storage.
#[cfg(desktop)]
#[tauri::command]
pub fn list_local_models(
    app: AppHandle,
    state: State<'_, AppState>,
    llm: State<'_, crate::local_llm::LlmState>,
) -> Result<crate::model_store::LocalModelList, String> {
    let running = crate::local_llm::running_model(&llm);
    let recording = state.recording.load(std::sync::atomic::Ordering::SeqCst);
    let mut list = crate::model_store::list(&app)?;
    for m in &mut list.models {
        m.in_use = match m.kind {
            "llm" => running.as_deref() == Some(m.file.as_str()),
            "asr" | "diarization" => recording,
            _ => false,
        };
    }
    Ok(list)
}

/// The result of deleting one model file.
#[cfg(desktop)]
#[derive(serde::Serialize)]
pub struct DeleteModelResult {
    pub freed_bytes: u64,
    pub file: String,
}

/// Typed failure for `delete_local_model` so the UI can tell a safety refusal
/// apart from a real error and word its message accordingly.
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum DeleteModelError {
    /// A recording is live — its ASR/diarization models may be memory-mapped.
    RecordingInProgress,
    /// The path canonicalized to somewhere outside the app's model directories
    /// (path traversal / arbitrary-delete attempt), or isn't a plain file.
    OutsideModelDir,
    /// Nothing exists at that path.
    NotFound,
    /// Any other failure (resolve, unload, remove_file …).
    Failed { message: String },
}

#[cfg(desktop)]
impl DeleteModelError {
    fn failed(e: impl std::string::ToString) -> Self {
        DeleteModelError::Failed { message: e.to_string() }
    }
}

/// Safely delete ONE downloaded model file and report the bytes freed.
///
/// Safety, in order:
///   1. **Refuse while recording** — a live capture has its ASR/diarization
///      engine loaded from these files; deleting one mid-recording is a hard no.
///   2. **Path validation** — the target is canonicalized and must live inside
///      one of the app's own model directories (no traversal / arbitrary path),
///      and must be a plain file (never a directory).
///   3. **Unload first** — if the target is the LLM resident in the sidecar,
///      kill the sidecar before unlinking the file.
///
/// Everything deleted is re-downloadable, so this is reversible; the twin in the
/// legacy per-app dir (macOS hard-links adopted downloads) is removed too, else
/// the freed bytes wouldn't actually come back.
#[cfg(desktop)]
#[tauri::command]
pub fn delete_local_model(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
    llm: State<'_, crate::local_llm::LlmState>,
) -> Result<DeleteModelResult, DeleteModelError> {
    use std::sync::atomic::Ordering;

    // (1) Never delete a model an active recording may be using.
    if state.recording.load(Ordering::SeqCst) {
        return Err(DeleteModelError::RecordingInProgress);
    }

    // (2) Resolve the real path and require it inside an app model dir.
    let real = PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| DeleteModelError::NotFound)?;
    let dirs = crate::model_store::model_dirs(&app).map_err(DeleteModelError::failed)?;
    let inside = dirs.iter().any(|d| {
        d.canonicalize().map(|rd| real.starts_with(&rd)).unwrap_or(false)
    });
    if !inside {
        return Err(DeleteModelError::OutsideModelDir);
    }
    let meta = std::fs::metadata(&real).map_err(DeleteModelError::failed)?;
    if !meta.is_file() {
        return Err(DeleteModelError::OutsideModelDir);
    }
    let freed = meta.len();
    let file = real
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    // (3) If this file is the LLM currently resident in the sidecar, unload it
    // first so we're not unlinking a file the child has memory-mapped.
    if crate::local_llm::running_model(&llm).as_deref() == Some(file.as_str()) {
        crate::local_llm::unload(&llm);
    }

    std::fs::remove_file(&real).map_err(DeleteModelError::failed)?;

    // Best-effort cleanup: drop any leftover `.part`, and the hard-linked twin in
    // the *other* app model dir (adopted macOS downloads), which would otherwise
    // keep the disk blocks alive. Never fails the delete.
    let _ = std::fs::remove_file(real.with_extension("part"));
    if !file.is_empty() {
        for d in &dirs {
            if let Ok(rd) = d.canonicalize() {
                let twin = rd.join(&file);
                if twin != real {
                    let _ = std::fs::remove_file(&twin);
                }
            }
        }
    }

    Ok(DeleteModelResult { freed_bytes: freed, file })
}

// ---------- Storage commands (Phase 4) ----------

#[tauri::command]
pub fn save_meeting(
    input: SaveMeetingInput,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    let meeting = store::insert_meeting(&conn, input, &root)?;
    // Attach the voices diarized at stop time to this meeting (Slice 1) so
    // "this is X" can enrol them later. Best-effort; never fails the save.
    if let Ok(mut pending) = state.pending_voices.lock() {
        if !pending.is_empty() {
            let _ = store::record_observations(&conn, &meeting.id, &pending);
            pending.clear();
        }
    }
    Ok(meeting)
}

#[tauri::command]
pub fn list_meetings(
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingMeta>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_meetings(&conn, project_id.as_deref())
}

/// List meetings across a SET of folders (folder "include subfolders" mode). The
/// frontend computes the descendant folder ids and passes them all; an empty
/// list yields no meetings.
#[tauri::command]
pub fn list_meetings_in(
    project_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingMeta>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_meetings_in(&conn, &project_ids)
}

/// Attendees-only projection over EVERY meeting (no cap) — the lean read behind
/// People & Companies. Omits the heavy transcript/summary payloads so the whole
/// store can be grouped in one call, lifting the old ~2000-meeting scan cap.
#[tauri::command]
pub fn list_meeting_attendees(
    state: State<'_, AppState>,
) -> Result<Vec<MeetingAttendees>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_meeting_attendees(&conn)
}

#[tauri::command]
pub fn get_meeting(id: String, state: State<'_, AppState>) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    // A re-keyed meeting (#284) still opens by its old id.
    store::get_meeting(&conn, &store::resolve_meeting_id(&conn, &id))
}

/// Move a local meeting to a new id (#284 connector-id collision re-key) in one
/// transaction, keeping the old id as an alias. Returns the moved meeting.
#[tauri::command]
pub fn rekey_meeting(
    old_id: String,
    new_id: String,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::rekey_meeting(&conn, &old_id, &new_id)
}

/// Old ids that were re-keyed onto other meetings (import dedupe).
#[tauri::command]
pub fn list_meeting_id_aliases(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_meeting_id_aliases(&conn)
}

#[tauri::command]
pub fn update_meeting(
    id: String,
    title: String,
    notes: String,
    summary: String,
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    // An edit made in a view opened before a #284 re-key lands on the new id.
    let id = store::resolve_meeting_id(&conn, &id);
    store::update_meeting(&conn, &id, &title, &notes, &summary, project_id.as_deref(), &root)
}

/// Set (or clear) a meeting's AI-enhanced notes (Wave A3). Stored separately
/// from the user's own `notes`, which are never touched; re-running just
/// replaces this field. Returns the updated meeting.
#[tauri::command]
pub fn update_enhanced_notes(
    id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    let id = store::resolve_meeting_id(&conn, &id);
    store::update_enhanced_notes(&conn, &id, &text, &root)
}

// ---------- Notes log entries (A7) ----------

/// The authored, timestamped entries making up a meeting's notes log.
#[tauri::command]
pub fn list_note_entries(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::NoteEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::list_note_entries(&conn, &meeting_id)
}

/// Append an entry, stamped with the caller's Supabase identity (null = signed
/// out). Re-derives `notes`, rewrites files, returns the fresh entry list.
#[tauri::command]
pub fn add_note_entry(
    meeting_id: String,
    author_id: Option<String>,
    author_name: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::NoteEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    let root = state.save_root(&conn);
    store::add_note_entry(&conn, &meeting_id, author_id.as_deref(), &author_name, &text, &root)
}

/// Edit one entry's text (author-only in the cloud; the local DB is single-user).
#[tauri::command]
pub fn update_note_entry(
    id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::NoteEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    store::update_note_entry(&conn, &id, &text, &root)
}

/// Delete one entry. Returns the fresh entry list for its meeting.
#[tauri::command]
pub fn delete_note_entry(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::NoteEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    store::delete_note_entry(&conn, &id, &root)
}

/// Claim this device's authorless entries for a meeting as the signed-in user
/// (called by the sync layer just before pushing them up).
#[tauri::command]
pub fn claim_note_entries(
    meeting_id: String,
    author_id: String,
    author_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::claim_note_entries(&conn, &meeting_id, &author_id, &author_name)
}

/// Upsert cloud-pulled entries (last-write-wins on updated_at) and re-derive the
/// affected meetings' notes.
#[tauri::command]
pub fn upsert_note_entries(
    entries: Vec<store::NoteEntry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    store::upsert_note_entries(&conn, &entries, &root)
}

/// Import a meeting (e.g. pulled from the cloud) into the local store by id.
#[tauri::command]
pub fn import_meeting(meeting: FullMeeting, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    store::upsert_meeting(&conn, &meeting, &root)
}

#[tauri::command]
pub fn delete_meeting(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let id = store::resolve_meeting_id(&conn, &id);
    store::delete_meeting(&conn, &id)
}

#[tauri::command]
pub fn search_meetings(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingMeta>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    if query.trim().is_empty() {
        return store::list_meetings(&conn, None);
    }
    store::search_meetings(&conn, query.trim())
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_projects(&conn)
}

#[tauri::command]
pub fn create_project(
    name: String,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::create_project(&conn, &name, parent_id.as_deref())
}

#[tauri::command]
pub fn set_project_parent(
    id: String,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::set_project_parent(&conn, &id, parent_id.as_deref())
}

/// Move a meeting into a project (None = Unfiled); rewrites its markdown.
#[tauri::command]
pub fn move_meeting_to_project(
    meeting_id: String,
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let root = state.save_root(&conn);
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::move_meeting_by_user(&conn, &meeting_id, project_id.as_deref(), &root)
}

#[tauri::command]
pub fn rename_project(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::rename_project(&conn, &id, &name)
}

#[tauri::command]
pub fn delete_project(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_project(&conn, &id)
}

/// Star/unstar a folder (A6). Local-only preference — never mirrored to cloud.
#[tauri::command]
pub fn set_project_favorite(
    id: String,
    fav: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::set_project_favorite(&conn, &id, fav)
}

/// Star/unstar a meeting (A6). Local-only preference — never mirrored to cloud.
#[tauri::command]
pub fn set_meeting_favorite(
    id: String,
    fav: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let id = store::resolve_meeting_id(&conn, &id);
    store::set_meeting_favorite(&conn, &id, fav)
}

// ---------- Action items ----------

#[tauri::command]
pub fn list_action_items(
    meeting_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ActionItem>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = meeting_id.map(|id| store::resolve_meeting_id(&conn, &id));
    store::list_action_items(&conn, meeting_id.as_deref())
}

/// Replace a meeting's *suggested* items with a fresh extraction (approved
/// and in-flight items are kept). Returns the meeting's full list.
#[tauri::command]
pub fn set_meeting_action_items(
    meeting_id: String,
    items: Vec<store::NewActionItem>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ActionItem>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::replace_suggested_action_items(&conn, &meeting_id, items)
}

/// Manually add ONE task to a meeting (goes straight to the board with the
/// given stage id). Used by the "Add task" composers on the meeting panel and
/// the global Tasks board.
#[tauri::command]
pub fn add_action_item(
    meeting_id: String,
    title: String,
    assignee_name: Option<String>,
    assignee_uid: Option<String>,
    due: Option<String>,
    status: String,
    state: State<'_, AppState>,
) -> Result<store::ActionItem, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    store::add_action_item(
        &conn,
        &meeting_id,
        &title,
        assignee_name.as_deref(),
        assignee_uid.as_deref(),
        due.as_deref(),
        &status,
    )
}

#[tauri::command]
pub fn update_action_item(
    id: String,
    title: String,
    assignee_name: Option<String>,
    assignee_uid: Option<String>,
    due: Option<String>,
    status: String,
    state: State<'_, AppState>,
) -> Result<store::ActionItem, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::update_action_item(
        &conn,
        &id,
        &title,
        assignee_name.as_deref(),
        assignee_uid.as_deref(),
        due.as_deref(),
        &status,
    )
}

#[tauri::command]
pub fn delete_action_item(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_action_item(&conn, &id)
}

// ---------- Task board stages (phase21; local mirror of the cloud config) ----------

/// The user's custom stage-list JSON, or None if they've never customised the
/// board. The frontend layers localStorage (cache) + Supabase (cross-device)
/// on top of this SQLite mirror.
#[tauri::command]
pub fn get_task_stages(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    Ok(store::get_task_stages(&conn))
}

/// Persist the (already-normalised) stage-list JSON to the local mirror.
#[tauri::command]
pub fn set_task_stages(json: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::set_task_stages(&conn, &json)
}

// ---------- Notification preferences (Wave C3) ----------
// One JSON blob (shape owned + defaulted frontend-side, see lib/notifications.ts):
// the four notification toggles plus the per-app detection mute list. Stored in
// the settings K/V so BOTH the frontend (detection OS notifications +
// NotificationBell feed filtering) and Rust (the backend-fired "Local model
// ready" notification) read the same gates from one place.
const NOTIFICATION_PREFS_KEY: &str = "notification_prefs";

/// The stored notification-preferences JSON, or None on a fresh install (the
/// frontend then falls back to its built-in defaults — everything on).
#[tauri::command]
pub fn get_notification_prefs(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    Ok(store::get_setting(&conn, NOTIFICATION_PREFS_KEY))
}

/// Persist the notification-preferences JSON (already shaped by the frontend).
#[tauri::command]
pub fn set_notification_prefs(json: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::set_setting(&conn, NOTIFICATION_PREFS_KEY, &json)
}

/// Whether the "Local model ready" OS notification is enabled. Reads the
/// notification-prefs blob directly from the settings K/V. Defaults to `true`:
/// a missing key, unreadable DB, parse failure, or absent `modelReady` field
/// all mean "on" (never silently swallow a ready notification on a fresh box).
#[cfg(desktop)]
fn model_ready_notifications_enabled(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return true;
    };
    let Ok(conn) = state.db.lock() else {
        return true;
    };
    let Some(raw) = store::get_setting(&conn, NOTIFICATION_PREFS_KEY) else {
        return true;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("modelReady").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

// ---------- Chat threads (persisted chat history) ----------

#[tauri::command]
pub fn list_chat_threads(
    scope: String,
    scope_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatThreadRow>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let scope_id = store::resolve_chat_scope_id(&conn, &scope, scope_id);
    store::list_chat_threads(&conn, &scope, scope_id.as_deref())
}

#[tauri::command]
pub fn create_chat_thread(
    scope: String,
    scope_id: Option<String>,
    title: String,
    state: State<'_, AppState>,
) -> Result<store::ChatThreadRow, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let scope_id = store::resolve_chat_scope_id(&conn, &scope, scope_id);
    store::create_chat_thread(&conn, &scope, scope_id.as_deref(), &title)
}

#[tauri::command]
pub fn list_chat_messages(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<store::ChatMessageRow>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::list_chat_messages(&conn, &thread_id)
}

#[tauri::command]
pub fn append_chat_message(
    thread_id: String,
    role: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<store::ChatMessageRow, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::append_chat_message(&conn, &thread_id, &role, &content)
}

#[tauri::command]
pub fn rename_chat_thread(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::rename_chat_thread(&conn, &id, &title)
}

#[tauri::command]
pub fn delete_chat_thread(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    store::delete_chat_thread(&conn, &id)
}

#[tauri::command]
pub fn get_save_folder(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    Ok(state.save_root(&conn).to_string_lossy().to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub fn pick_save_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let picked = run_on_main(&app, || {
        rfd::FileDialog::new()
            .set_title("Choose where Lalela saves meetings")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })?;
    if let Some(path) = &picked {
        let conn = state.db.lock().map_err(|_| "db poisoned")?;
        store::set_setting(&conn, "save_folder", path)?;
    }
    Ok(picked)
}

/// Export a meeting as a Word document or a PDF. Both carry the same content —
/// title, summary, notes and the transcript with the captured frames placed at
/// their timestamps. Prompts for a save location; returns the path, or None if
/// the user cancelled.
#[cfg(desktop)]
#[tauri::command]
pub fn export_meeting_file(
    app: AppHandle,
    id: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let ext = match format.as_str() {
        "docx" => "docx",
        "pdf" => "pdf",
        other => return Err(format!("Unknown export format: {other}")),
    };
    let meeting = {
        let conn = state.db.lock().map_err(|_| "db poisoned")?;
        store::get_meeting(&conn, &id)?
    };
    let stem = meeting
        .title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .to_string();
    let default_name = format!("{stem}.{ext}");
    let label = ext.to_uppercase();
    let path = run_on_main(&app, move || {
        rfd::FileDialog::new()
            .set_title(format!("Export meeting as {label}"))
            .set_file_name(&default_name)
            .add_filter(&label, &[ext])
            .save_file()
    })?;
    match path {
        Some(path) => {
            // The dialog only appends the extension on some platforms; a
            // meeting title ending in ".2" would otherwise produce a file no
            // app can open by name.
            let path = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) {
                path
            } else {
                let mut name = path.file_name().unwrap_or_default().to_os_string();
                name.push(format!(".{ext}"));
                path.with_file_name(name)
            };
            match ext {
                "pdf" => store::export_pdf(&meeting, &path)?,
                _ => store::export_docx(&meeting, &path)?,
            }
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

// ---------- Screen capture (Phase 6) ----------

/// An image captured during a live recording, still staged in app data until
/// the meeting is saved.
#[derive(serde::Serialize)]
pub struct LiveCapture {
    pub t_ms: i64,
    pub src_path: String,
}

/// Capture the screen during a live recording. `interactive` shows the native
/// region/window picker; otherwise it's a silent full-screen grab (auto mode).
/// Returns `None` if the user cancelled an interactive capture.
#[cfg(desktop)]
#[tauri::command]
pub fn capture_live(
    app: AppHandle,
    t_ms: i64,
    interactive: bool,
) -> Result<Option<LiveCapture>, String> {
    let app_data = crate::paths::app_data_dir(&app)?;
    let dest = crate::capture::live_staging_dir(&app_data).join(crate::capture::capture_filename());
    if !crate::capture::screencapture(&dest, interactive)? {
        return Ok(None);
    }
    Ok(Some(LiveCapture {
        t_ms,
        src_path: dest.to_string_lossy().to_string(),
    }))
}

/// One tick of screenshare auto-capture (Slice 4). Called every few seconds
/// by the recording view while the auto toggle is on. Captures ONLY the
/// active meeting window (Zoom/Teams/Webex over browser, largest wins) and
/// saves a frame only when it is STABLE (not mid-transition/video) and
/// CHANGED vs the last saved frame — with a motion fallback so a webcam
/// tile or playing video inside the window can't block new slides forever
/// (`image_proc::should_save_tick`) — debounced to one save per 10 s. Saved
/// frames are ≤1600px WebP. Returns `None` on a no-save tick, when the
/// meeting window is minimized/closed, or when the helper isn't built.
/// List every on-screen window for the manual slide-capture picker (desktop).
#[cfg(desktop)]
#[tauri::command]
pub fn list_windows() -> Vec<crate::window::MeetingWindow> {
    crate::window::list_all_windows()
}

#[cfg(desktop)]
#[tauri::command]
pub fn capture_screenshare_sample(
    app: AppHandle,
    t_ms: i64,
    window_id: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Option<LiveCapture>, String> {
    const DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(10);

    // Manual pick pins a specific window id; auto-detect resolves the meeting
    // window each tick (so it tracks a Zoom/Teams window that moves/reopens).
    let target_id = match window_id {
        Some(id) => id,
        None => {
            let Some(target) = crate::window::resolve_meeting_window() else {
                // Window gone (minimized/closed): break stability so nothing is
                // saved from a half-restored window on the next tick.
                if let Ok(mut s) = state.sampler.lock() {
                    s.prev_hash = None;
                    s.unsettled_ticks = 0;
                }
                return Ok(None);
            };
            target.id
        }
    };

    let app_data = crate::paths::app_data_dir(&app)?;
    let staging = crate::capture::live_staging_dir(&app_data);
    let probe = staging.join(crate::capture::sample_filename());
    // One lock for the whole tick: `capture_window` manages the persistent
    // stream slot living in the sampler (kept for fullscreen-Space windows,
    // which one-shot capture cannot photograph). Ticks never overlap (the UI
    // serializes them), so holding the lock across the capture is safe.
    let mut s = state.sampler.lock().map_err(|_| "state poisoned")?;
    if !crate::capture::capture_window(&mut s.stream, target_id, &probe)? {
        s.prev_hash = None;
        s.unsettled_ticks = 0;
        return Ok(None);
    }
    let decoded = crate::image_proc::decode(&probe);
    let _ = std::fs::remove_file(&probe);
    let img = decoded?;
    let hash = crate::image_proc::dhash(&img);

    let debounced = s.last_save.map_or(true, |t| t.elapsed() >= DEBOUNCE);
    let mut save = false;
    if debounced {
        let (decision, unsettled) = crate::image_proc::should_save_tick(
            hash,
            s.prev_hash,
            s.last_saved_hash,
            s.unsettled_ticks,
        );
        save = decision;
        s.unsettled_ticks = unsettled;
    }
    s.prev_hash = Some(hash);
    if !save {
        return Ok(None);
    }

    let bytes = crate::image_proc::to_webp(&img)?;
    let dest = staging.join(crate::capture::capture_filename_ext("webp"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    s.last_saved_hash = Some(hash);
    s.last_save = Some(std::time::Instant::now());
    Ok(Some(LiveCapture {
        t_ms,
        src_path: dest.to_string_lossy().to_string(),
    }))
}

/// Release the sampler's persistent window stream, if one is held. Called by
/// the UI when slide capture is switched off or its target changes, so the
/// helper — and the system capture indicator — don't outlive the selection.
#[cfg(desktop)]
#[tauri::command]
pub fn release_capture_stream(state: State<'_, AppState>) {
    if let Ok(mut s) = state.sampler.lock() {
        s.stream = None;
    }
}

/// Capture the screen and attach it to an already-saved meeting at `t_ms`.
/// Returns the updated meeting, or `None` if an interactive capture was cancelled.
#[cfg(desktop)]
#[tauri::command]
pub fn capture_for_meeting(
    meeting_id: String,
    t_ms: i64,
    interactive: bool,
    state: State<'_, AppState>,
) -> Result<Option<FullMeeting>, String> {
    let (meeting_id, dir_path, save_root) = {
        let conn = state.db.lock().map_err(|_| "db poisoned")?;
        let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
        let m = store::get_meeting(&conn, &meeting_id)?;
        (meeting_id, m.dir_path.clone(), state.save_root(&conn))
    };
    let dir = dir_path.ok_or("This meeting has no folder yet — save it first.")?;
    let fname = crate::capture::capture_filename();
    let dest = Path::new(&dir).join("images").join(&fname);
    if !crate::capture::screencapture(&dest, interactive)? {
        return Ok(None);
    }

    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let mut meeting = store::get_meeting(&conn, &meeting_id)?;
    meeting.images.push(store::MeetingImage {
        id: crate::capture::image_id(),
        t_ms,
        rel_path: format!("images/{fname}"),
        caption: String::new(),
    });
    Ok(Some(store::update_images(
        &conn,
        &meeting_id,
        &meeting.images,
        &save_root,
    )?))
}

/// Write image bytes (downloaded from cloud Storage) into a meeting's folder at
/// `rel_path` (e.g. `images/cap-123.png`). Used when importing a shared meeting.
#[tauri::command]
pub fn save_meeting_image(
    meeting_id: String,
    rel_path: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = {
        let conn = state.db.lock().map_err(|_| "db poisoned")?;
        store::get_meeting(&conn, &store::resolve_meeting_id(&conn, &meeting_id))?.dir_path
    };
    let dir = dir.ok_or("meeting has no folder yet")?;
    // Guard against path traversal in rel_path (it comes from synced data).
    if rel_path.contains("..") {
        return Err("invalid image path".into());
    }
    let dest = Path::new(&dir).join(&rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, &data).map_err(|e| e.to_string())
}

/// Remove a captured image from a meeting (deletes the file too).
#[tauri::command]
pub fn remove_meeting_image(
    meeting_id: String,
    image_id: String,
    state: State<'_, AppState>,
) -> Result<FullMeeting, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = store::resolve_meeting_id(&conn, &meeting_id);
    let mut meeting = store::get_meeting(&conn, &meeting_id)?;
    if let (Some(dir), Some(img)) = (
        meeting.dir_path.as_ref(),
        meeting.images.iter().find(|i| i.id == image_id),
    ) {
        let _ = std::fs::remove_file(Path::new(dir).join(&img.rel_path));
    }
    meeting.images.retain(|i| i.id != image_id);
    let save_root = state.save_root(&conn);
    store::update_images(&conn, &meeting_id, &meeting.images, &save_root)
}
