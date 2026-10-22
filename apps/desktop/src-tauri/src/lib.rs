pub mod asr;
pub mod audio;
// Auto-sort meetings into folders: the meeting_sort ledger + guarded commands
// (the classifier runs frontend-side through the AI front door).
pub mod autosort;
// Folder automations: scheduled per-folder rules + their run ledger (the
// scheduler and AI calls run frontend-side, like Reports).
pub mod folder_rules;
pub mod capture;
mod cloud;
mod commands;
mod detect;
// Backend-owned local-model download registry (desktop only).
#[cfg(desktop)]
mod downloads;
// On-disk model inventory for the "Manage local models" Storage UI (desktop
// only): enumerate/classify downloaded weights so the user can reclaim space.
#[cfg(desktop)]
mod model_store;
#[cfg(desktop)]
pub mod image_proc;
#[cfg(desktop)]
pub mod window;
// Diarization uses sherpa-rs (host-only prebuilt libs) — desktop only.
#[cfg(desktop)]
pub mod diarize;
// Transcript import (Slice 2) — desktop only (docx-rs/pdf-extract are
// desktop deps; iOS gets imports in a later phase).
#[cfg(desktop)]
pub mod import;
// AVAudioSession activation — without it the iOS mic records silence.
#[cfg(target_os = "ios")]
mod ios_audio;
// JNI bridge to the RecordingService foreground service (mic FGS + wake lock) so
// capture survives screen-off / backgrounding — Android only. See android.rs.
#[cfg(target_os = "android")]
mod android;
// Local-LLM sidecar bridge (desktop only; the module is empty on iOS).
mod local_llm;
// Streaming AI lane (CP0): `stream_generate` / `cancel_generate` commands +
// per-request cancel registry. Routes apple / local / BYOK like `summarize` but
// emits `llm://delta` events. Compiles on every platform (local branch is
// cfg-gated inside).
mod streaming;
// Apple-Intelligence (Foundation Models) synthesis: `apple:` provider on both
// Apple platforms (macOS 26+ via the resident helper, iOS 26+ via apple_bridge).
// Shared map-reduce logic; the transport forks inside the module.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_llm;
// In-process Rust↔Swift Apple-Intelligence bridge — iOS only (App Store apps
// can't spawn the out-of-process helpers macOS uses). Phase 4/5 route real ops
// through it; Phase 3 just wires up + health-checks the transport.
#[cfg(target_os = "ios")]
mod apple_bridge;
// "Continue with Auxo ID" on iPhone/iPad: in-app ASWebAuthenticationSession
// (Swift: gen/apple/Sources/lalela/AuxoIdAuthSession.swift). iOS only — the Mac
// uses the msoauth loopback instead.
#[cfg(target_os = "ios")]
mod auxo_id_ios;
// watchOS companion ingest — iOS at runtime. Drains `<app_data_dir>/watch-inbox/`
// (filled by the Swift WatchConnectivity receiver) into meetings via whisper +
// store::insert_meeting. Also compiled under `test` so its pure decode/title
// helpers run on the host; absent from the normal desktop build. See
// watch_inbox.rs.
#[cfg(any(target_os = "ios", test))]
mod watch_inbox;
// Global panic hook → `<app_data_dir>/crash.log`, so a crash on a machine we
// can't debug still names the panic and its file:line. See crash.rs.
pub mod crash;
mod migrate;
// Central data-dir resolution (honors the LALELA_DATA_DIR override so the whole
// instance can run against a scratch dir — used by the demo seeder + testing).
pub mod paths;
// Slice 9 (desktop only): loopback OAuth listener + keychain secret custody
// for the Microsoft connection. All Graph/token logic lives in frontend TS.
#[cfg(desktop)]
mod msoauth;
#[cfg(desktop)]
mod secrets;
// Menu-bar tray + close-to-tray (Wave C1). Desktop-only: iOS has no menu bar,
// and the `tray-icon` tauri feature is unioned in only for non-iOS in Cargo.toml.
#[cfg(desktop)]
mod tray;
mod sidecar;
mod gateway;
mod models;
mod recording;
// System-wide on-device dictation (Wave B2) — macOS + Windows desktop (the OS
// layer — paste synthesis, foreground capture, Accessibility — is per-platform
// inside the module; keeps the iOS/Android/Linux builds clean).
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod dictation;
// Meeting Copilot overlay (CP1) — macOS desktop only. A hotkey-summoned,
// always-on-top translucent panel giving live AI guidance during a recording.
// Shares the one global-shortcut handler with dictation (routed by accelerator).
#[cfg(target_os = "macos")]
mod copilot;
// Alternate app icon (Wave E1 follow-up) — macOS desktop only. Swaps the RUNNING
// Dock icon via NSApplication.applicationIconImage; the static bundle .icns is
// unchanged (see docs/DECISIONS.md). A cosmetic reward on the same honor-system
// unlock as themes/badges — nothing functional is ever gated.
#[cfg(target_os = "macos")]
mod app_icon;
pub mod speakers;
// Public so the `seed_demo` cargo example can open/migrate the DB and insert
// meetings/tags/automations/reports through the exact same code path as the app.
pub mod store;
mod system_tap;
pub mod transcribe;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST thing: any panic from here on leaves a line in crash.log (see
    // crash.rs). Costs nothing until something panics.
    crash::install_panic_hook();

    let builder = tauri::Builder::default();

    // Windows: one instance per session. MUST be the first plugin registered
    // (it has to run before anything else claims per-process resources). A
    // second launch exits immediately and this callback brings the existing
    // window back — it may be hidden in the tray (close-to-tray).
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }));

    let builder = builder.plugin(tauri_plugin_opener::init());

    // Desktop-only plugins: iOS updates come from the App Store, and iOS can't
    // spawn subprocesses. The notification plugin (phase 20 reports) fires an OS
    // notification when a scheduled report finishes; kept desktop-only to keep
    // the aarch64-apple-ios check clean (iOS gets report notifications later).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    // The self-updater is registered ONLY in the direct-download build (the
    // `store` cargo feature is OFF). The Microsoft Store re-signs and updates
    // the MSIX itself, so tauri.store.conf.json strips `plugins.updater` — and
    // the updater plugin panics at startup on a null/missing config
    // (PluginInitialization("updater", …"invalid type: null"…) → exit 101).
    // Frontend update UI is already gated on IS_STORE_BUILD (src/lib/distribution.ts).
    // Likewise never in the Community edition (`cfg(lalela_community)`, set by
    // build.rs): it has no Auxo update feed or signing key, and its config
    // (tauri.community.conf.json) strips `plugins.updater`. Frontend: IS_COMMUNITY.
    #[cfg(all(desktop, not(feature = "store"), not(lalela_community)))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // System-wide dictation hotkey (Wave B2) — macOS + Windows. Registration lives in
    // Rust (not JS) so the hotkey keeps working even when the main window is
    // closed/minimised; the handler just toggles a dictation session on key-down.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    // Dictation (Wave B2) and the Meeting Copilot (CP1) both
                    // register through this ONE handler (the plugin is
                    // initialised once). Route by which accelerator fired: the
                    // copilot claims only its own, everything else stays
                    // dictation — so extending this never breaks dictation.
                    // `is_our_shortcut` is a cheap lock+parse on this (main)
                    // thread; the actual toggle marshals AppKit + window work
                    // back to main (run_on_main) and BLOCKS on it, so we dispatch
                    // to a worker thread to avoid deadlocking main against itself.
                    // The copilot is macOS-only; on Windows every registered
                    // accelerator is dictation's.
                    #[cfg(target_os = "macos")]
                    let is_copilot = copilot::is_our_shortcut(app, shortcut);
                    #[cfg(not(target_os = "macos"))]
                    let is_copilot = {
                        let _ = shortcut;
                        false
                    };
                    let app = app.clone();
                    std::thread::spawn(move || {
                        if is_copilot {
                            #[cfg(target_os = "macos")]
                            copilot::toggle(app);
                        } else {
                            dictation::toggle(app);
                        }
                    });
                }
            })
            .build(),
    );

    let builder = builder.setup(|app| {
        // Honors LALELA_DATA_DIR: when set, the whole instance (DB, staging,
        // models, logs, and the meeting save-root fallback below) runs against
        // that scratch dir instead of the OS app-data dir. See `paths`.
        let data_dir = paths::app_data_dir(app).expect("no app data dir");
        // Point the panic hook at the real data dir (it falls back to the
        // LALELA_DATA_DIR override before this runs).
        crash::set_log_dir(data_dir.clone());
        let isolated = paths::data_dir_override().is_some();
        // 2026-07 rename: pull Clio-era data across before anything opens it —
        // but never into an isolated LALELA_DATA_DIR instance (that would drag
        // real data into a demo/test dir).
        #[cfg(desktop)]
        if !isolated {
            migrate::migrate_from_clio(&data_dir);
        }
        let db = store::open(&data_dir.join("lalela.db")).expect("failed to open database");
        // In an isolated instance the save root lives INSIDE the scratch dir so
        // demo meeting Markdown never lands in the user's real Documents folder.
        let fallback_root = if isolated {
            data_dir.clone()
        } else {
            app.path()
                .document_dir()
                .or_else(|_| app.path().home_dir())
                .unwrap_or_else(|_| data_dir.clone())
        };
        // Pre-rename installs wrote meeting Markdown under "<root>/Clio Meetings"
        // and the DB stores absolute paths into it — pin save_folder so those
        // files stay where they are. New installs get "Lalela Meetings".
        #[cfg(desktop)]
        if store::get_setting(&db, "save_folder").is_none() {
            let legacy = fallback_root.join("Clio Meetings");
            if legacy.exists() {
                let _ = store::set_setting(&db, "save_folder", &legacy.to_string_lossy());
            }
        }

        // Phase 8: meeting auto-detect. Shared flags let the detector thread
        // suppress prompts while recording and honor the user's toggle. On iOS
        // there is no detector helper, so we skip spawning it entirely.
        let recording = Arc::new(AtomicBool::new(false));
        let detect_enabled = Arc::new(AtomicBool::new(true));
        #[cfg(desktop)]
        detect::spawn(app.handle().clone(), detect_enabled.clone(), recording.clone());

        // Wave C1: close-to-tray. Default ON — a fresh install has no row, so a
        // missing/anything-but-"0" value means keep running in the menu bar.
        // Cached in an AtomicBool the CloseRequested handler reads on the hot
        // path; the `set_close_to_tray` command keeps DB + cache in lockstep.
        // `real_quit` lets the tray's "Quit" bypass the close-to-tray guard.
        #[cfg(desktop)]
        let close_to_tray = Arc::new(AtomicBool::new(
            store::get_setting(&db, "close_to_tray").map(|v| v != "0").unwrap_or(true),
        ));
        #[cfg(desktop)]
        let real_quit = Arc::new(AtomicBool::new(false));

        app.manage(AppState {
            recorder: Mutex::new(None),
            db: Mutex::new(db),
            fallback_root,
            recording,
            detect_enabled,
            pending_voices: Mutex::new(Vec::new()),
            import_cancel: Arc::new(AtomicBool::new(false)),
            #[cfg(desktop)]
            sampler: Mutex::new(Default::default()),
            #[cfg(desktop)]
            close_to_tray,
            #[cfg(desktop)]
            real_quit,
        });
        // Streaming AI lane (CP0): per-request cancel registry. Managed on every
        // platform so stream_generate / cancel_generate resolve uniformly.
        app.manage(streaming::StreamRegistry::default());
        // Dictation state + hotkey registration (macOS only). Runs after
        // AppState is managed, since it reads the SQLite `settings` for the
        // saved enabled flag + accelerator.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            app.manage(dictation::DictationState::default());
            dictation::init_from_settings(app.handle());
        }
        #[cfg(target_os = "macos")]
        {
            // Meeting Copilot (CP1): managed state + hotkey registration (reads
            // the saved copilot.enabled / copilot.shortcut settings). Shares the
            // global-shortcut handler above.
            app.manage(copilot::CopilotState::default());
            copilot::init_from_settings(app.handle());
            // Re-apply the chosen alternate app icon (E1 follow-up) to the
            // running Dock icon. No-op for the default; reads the SQLite setting.
            app_icon::init_from_settings(app.handle());
        }
        // Build the menu-bar tray after AppState is managed (its menu reads the
        // recording flag). Best-effort — never aborts startup.
        #[cfg(desktop)]
        tray::init(app.handle());
        #[cfg(desktop)]
        {
            app.manage(local_llm::LlmState::default());
            // CP5-L3: reclaim the sidecar's ~2.5 GB RSS after the model has sat
            // idle (default 5 min; `llm_idle_unload_secs` overrides, 0 = never).
            // The monitor reads LlmState managed just above; the next request
            // lazily respawns the sidecar. Read the setting once here (needs the
            // managed AppState DB) rather than every tick.
            let idle_secs = local_llm::idle_unload_secs(app.handle());
            local_llm::spawn_idle_monitor(app.handle().clone(), idle_secs);
        }
        #[cfg(desktop)]
        app.manage(downloads::DownloadRegistry::default());
        #[cfg(desktop)]
        app.manage(msoauth::OauthState::default());
        // Drain any watch recordings delivered by WatchConnectivity while the
        // app was closed. Runs on its own thread (whisper model prep can block).
        // Stash the handle first so the Swift receiver's C entry points
        // (file-arrived / pending-changed) can reach Tauri without an argument.
        #[cfg(target_os = "ios")]
        {
            watch_inbox::set_app_handle(app.handle().clone());
            watch_inbox::spawn_scan(app.handle().clone());
        }
        Ok(())
    });

    // Wave C1: close-to-tray. Intercept the MAIN window's close button (red dot
    // / window.close()) — when close-to-tray is on and this isn't a real quit,
    // hide the window instead of closing it. Cmd+Q and the app-menu Quit go
    // through RunEvent::ExitRequested (NOT per-window CloseRequested), so they
    // still quit; the updater's relaunch/restart likewise bypasses this path.
    // The tray's "Quit" sets `real_quit` first, so its close-and-exit isn't
    // intercepted either.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        use std::sync::atomic::Ordering;
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            let Some(state) = app.try_state::<AppState>() else {
                return;
            };
            let hide = state.close_to_tray.load(Ordering::Relaxed)
                && !state.real_quit.load(Ordering::Relaxed);
            if hide {
                api.prevent_close();
                let _ = window.hide();
                // One-time "still running in the menu bar" nudge.
                tray::notify_first_hide(app);
            }
        }
    });

    // Desktop build exposes file-dialog / screen-capture / DOCX-export commands;
    // the iOS build omits them (those APIs don't exist on iOS).
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        crash::crash_reports_since,
        crash::build_target,
        commands::start_recording,
        commands::stop_recording,
        commands::stop_recording_wav,
        commands::cloud_transcribe,
        commands::is_recording,
        commands::set_paused,
        commands::list_asr_engines,
        commands::get_workspace_card,
        commands::set_workspace_card,
        commands::get_dictionary,
        commands::set_dictionary,
        commands::preview_dictionary,
        commands::list_speakers,
        commands::rename_speaker,
        commands::delete_speaker,
        commands::merge_speakers,
        commands::label_meeting_speaker,
        commands::search_transcripts,
        commands::search_transcripts_in,
        commands::get_project_brief,
        commands::set_project_brief,
        commands::upsert_wiki_pages,
        commands::list_wiki_pages,
        commands::get_wiki_page,
        commands::pick_import_file,
        commands::pick_import_folder,
        commands::scan_import_folder,
        commands::import_preview,
        commands::parse_import_text,
        commands::save_imported_meeting,
        commands::import_audio_file,
        commands::cancel_audio_import,
        commands::get_meeting_import_source,
        commands::summarize,
        streaming::stream_generate,
        streaming::cancel_generate,
        commands::save_meeting,
        commands::list_meetings,
        commands::list_meetings_in,
        commands::list_meeting_attendees,
        commands::get_meeting,
        commands::update_meeting,
        commands::update_enhanced_notes,
        commands::list_note_entries,
        commands::add_note_entry,
        commands::update_note_entry,
        commands::delete_note_entry,
        commands::claim_note_entries,
        commands::upsert_note_entries,
        commands::import_meeting,
        commands::delete_meeting,
        commands::rekey_meeting,
        commands::list_meeting_id_aliases,
        commands::search_meetings,
        commands::list_projects,
        commands::create_project,
        commands::rename_project,
        commands::delete_project,
        commands::set_project_parent,
        commands::set_project_favorite,
        commands::set_meeting_favorite,
        commands::move_meeting_to_project,
        autosort::autosort_record,
        autosort::autosort_mark_manual,
        autosort::autosort_skip,
        autosort::autosort_candidates,
        autosort::autosort_review_queue,
        autosort::autosort_recent,
        autosort::autosort_stats,
        autosort::autosort_undo_run,
        folder_rules::folder_rules_list,
        folder_rules::folder_rule_get,
        folder_rules::folder_rule_save,
        folder_rules::folder_rule_delete,
        folder_rules::folder_rule_claim,
        folder_rules::folder_rule_finish,
        folder_rules::folder_rule_runs,
        folder_rules::folder_rule_meetings,
        folder_rules::folder_rule_items_done,
        folder_rules::folder_rule_record_item,
        folder_rules::folder_rule_items_unfinished,
        folder_rules::folder_reports_list,
        commands::list_workflows,
        commands::save_workflow,
        commands::delete_workflow,
        commands::get_workflow_outputs,
        commands::set_workflow_output,
        commands::list_tags,
        commands::save_tag,
        commands::delete_tag,
        commands::get_meeting_tags,
        commands::set_meeting_tags,
        commands::add_meeting_tag,
        commands::list_meeting_tags,
        commands::list_automations,
        commands::upsert_automation,
        commands::delete_automation,
        commands::record_automation_run,
        commands::update_automation_run_status,
        commands::has_automation_run,
        commands::list_automation_runs,
        commands::list_reports,
        commands::save_report,
        commands::delete_report,
        commands::touch_report_last_run,
        commands::list_report_outputs,
        commands::insert_report_output,
        commands::delete_report_output,
        commands::list_report_meetings,
        commands::list_action_items,
        commands::set_meeting_action_items,
        commands::add_action_item,
        commands::update_action_item,
        commands::delete_action_item,
        commands::get_task_stages,
        commands::set_task_stages,
        commands::get_notification_prefs,
        commands::set_notification_prefs,
        commands::get_save_folder,
        commands::pick_save_folder,
        commands::export_meeting_file,
        commands::local_llm_status,
        commands::apple_llm_status,
        commands::start_model_download,
        commands::model_download_status,
        commands::delete_local_llm,
        commands::unload_local_llm,
        // Manage local models (Storage UI): list every downloaded model file +
        // safely delete one to reclaim disk space (path-validated, recording-safe).
        commands::list_local_models,
        commands::delete_local_model,
        commands::capture_live,
        commands::capture_screenshare_sample,
        commands::release_capture_stream,
        commands::list_windows,
        commands::capture_for_meeting,
        commands::remove_meeting_image,
        commands::save_meeting_image,
        commands::set_detection_enabled,
        // System dictation (Wave B2) — real on macOS, inert on other desktop.
        commands::dictation_status,
        commands::set_dictation_enabled,
        commands::set_dictation_shortcut,
        commands::trigger_dictation,
        commands::finish_dictation,
        commands::cancel_dictation,
        // Meeting Copilot overlay (CP1) — real on macOS, inert on other desktop.
        commands::copilot_status,
        commands::set_copilot_enabled,
        commands::copilot_show,
        commands::copilot_hide,
        commands::copilot_toggle,
        // Opt-in screen awareness (CP4) — real on macOS, errors on other desktop.
        commands::copilot_capture_screen,
        commands::list_chat_threads,
        commands::create_chat_thread,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::rename_chat_thread,
        commands::delete_chat_thread,
        // Manual "sync from watch" trigger; a no-op returning 0 on desktop.
        commands::scan_watch_inbox,
        // Wave C1: menu-bar tray + close-to-tray (desktop-only).
        commands::set_tray_agenda,
        commands::get_close_to_tray,
        commands::set_close_to_tray,
        // Alternate app icon cosmetic (E1 follow-up) — real on macOS, inert
        // elsewhere. Registered in BOTH handler lists so the shared frontend can
        // probe uniformly (`supported: false` hides the picker off macOS).
        commands::app_icon_status,
        commands::set_app_icon,
        msoauth::oauth_loopback_listen,
        msoauth::oauth_loopback_wait,
        msoauth::oauth_loopback_cancel,
        msoauth::ms_token_request,
        secrets::secret_set,
        secrets::secret_get,
        secrets::secret_delete,
    ]);

    // Mobile (iOS + Android) share one command surface — the desktop subset that
    // makes sense without a menu bar / file dialogs / subprocesses. The one
    // iOS-only entry (`apple_bridge_ping`) is gated inline below.
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        crash::crash_reports_since,
        crash::build_target,
        commands::start_recording,
        commands::stop_recording,
        commands::stop_recording_wav,
        commands::cloud_transcribe,
        commands::is_recording,
        commands::set_paused,
        commands::list_asr_engines,
        commands::get_workspace_card,
        commands::set_workspace_card,
        commands::get_dictionary,
        commands::set_dictionary,
        commands::preview_dictionary,
        commands::list_speakers,
        commands::rename_speaker,
        commands::delete_speaker,
        commands::merge_speakers,
        commands::label_meeting_speaker,
        commands::search_transcripts,
        commands::search_transcripts_in,
        commands::get_project_brief,
        commands::set_project_brief,
        commands::upsert_wiki_pages,
        commands::list_wiki_pages,
        commands::get_wiki_page,
        commands::get_meeting_import_source,
        commands::summarize,
        streaming::stream_generate,
        streaming::cancel_generate,
        commands::save_meeting,
        commands::list_meetings,
        commands::list_meetings_in,
        commands::list_meeting_attendees,
        commands::get_meeting,
        commands::update_meeting,
        commands::update_enhanced_notes,
        commands::list_note_entries,
        commands::add_note_entry,
        commands::update_note_entry,
        commands::delete_note_entry,
        commands::claim_note_entries,
        commands::upsert_note_entries,
        commands::import_meeting,
        commands::delete_meeting,
        commands::rekey_meeting,
        commands::list_meeting_id_aliases,
        commands::search_meetings,
        commands::list_projects,
        commands::create_project,
        commands::rename_project,
        commands::delete_project,
        commands::set_project_parent,
        commands::set_project_favorite,
        commands::set_meeting_favorite,
        commands::move_meeting_to_project,
        autosort::autosort_record,
        autosort::autosort_mark_manual,
        autosort::autosort_skip,
        autosort::autosort_candidates,
        autosort::autosort_review_queue,
        autosort::autosort_recent,
        autosort::autosort_stats,
        autosort::autosort_undo_run,
        folder_rules::folder_rules_list,
        folder_rules::folder_rule_get,
        folder_rules::folder_rule_save,
        folder_rules::folder_rule_delete,
        folder_rules::folder_rule_claim,
        folder_rules::folder_rule_finish,
        folder_rules::folder_rule_runs,
        folder_rules::folder_rule_meetings,
        folder_rules::folder_rule_items_done,
        folder_rules::folder_rule_record_item,
        folder_rules::folder_rule_items_unfinished,
        folder_rules::folder_reports_list,
        commands::list_workflows,
        commands::save_workflow,
        commands::delete_workflow,
        commands::get_workflow_outputs,
        commands::set_workflow_output,
        commands::list_tags,
        commands::save_tag,
        commands::delete_tag,
        commands::get_meeting_tags,
        commands::set_meeting_tags,
        commands::add_meeting_tag,
        commands::list_meeting_tags,
        commands::list_automations,
        commands::upsert_automation,
        commands::delete_automation,
        commands::record_automation_run,
        commands::update_automation_run_status,
        commands::has_automation_run,
        commands::list_automation_runs,
        commands::list_reports,
        commands::save_report,
        commands::delete_report,
        commands::touch_report_last_run,
        commands::list_report_outputs,
        commands::insert_report_output,
        commands::delete_report_output,
        commands::list_report_meetings,
        commands::list_action_items,
        commands::set_meeting_action_items,
        commands::add_action_item,
        commands::update_action_item,
        commands::delete_action_item,
        commands::get_task_stages,
        commands::set_task_stages,
        commands::get_notification_prefs,
        commands::set_notification_prefs,
        commands::get_save_folder,
        commands::remove_meeting_image,
        commands::save_meeting_image,
        commands::set_detection_enabled,
        commands::list_chat_threads,
        commands::create_chat_thread,
        commands::list_chat_messages,
        commands::append_chat_message,
        commands::rename_chat_thread,
        commands::delete_chat_thread,
        // Manual "sync from watch" trigger — drains the WatchConnectivity inbox
        // on demand and returns the number of recordings found.
        commands::scan_watch_inbox,
        // Always registered (returns unavailable on iOS) so the frontend can
        // probe uniformly; Apple synthesis itself is macOS-only for now.
        commands::apple_llm_status,
        // Phase 3 bridge health-check (not surfaced in the UI). Registering it
        // also keeps the Swift `@_cdecl` symbols it reaches from being
        // dead-stripped at app link; Phases 4/5 add the real Apple commands.
        // iOS-only: there is no Apple bridge (or Swift) on Android.
        #[cfg(target_os = "ios")]
        apple_bridge::apple_bridge_ping,
        // "Continue with Auxo ID" in-app sheet (iOS only; Android hides the button).
        #[cfg(target_os = "ios")]
        auxo_id_ios::auxo_id_web_auth,
        #[cfg(target_os = "ios")]
        auxo_id_ios::auxo_id_web_auth_cancel,
        // Alternate app icon cosmetic (E1 follow-up) — inert on iOS (`supported:
        // false`); the picker hides itself there. Registered so the shared
        // frontend can probe uniformly across desktop + iOS.
        commands::app_icon_status,
        commands::set_app_icon,
    ]);

    // Build + run with an event callback so iOS can re-drain the watch inbox
    // when the app returns to the foreground (WatchConnectivity may have
    // delivered new recordings while it was backgrounded). The callback is a
    // no-op on desktop, preserving the previous `.run()` behavior there.
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(move |_app_handle, _event| {
        #[cfg(target_os = "ios")]
        if let tauri::RunEvent::Resumed = _event {
            watch_inbox::spawn_scan(_app_handle.clone());
        }
        // Wave C1: macOS Dock-icon click after close-to-tray hid the window —
        // bring it back. (We keep the Dock icon / activation policy as-is in v1.)
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            if let Some(win) = _app_handle.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        // On ⌘Q, drop the warm dictation Whisper state BEFORE exit() runs the
        // atexit/C++ finalizers — otherwise ggml's Metal residency-set teardown
        // asserts (GGML_ASSERT [rsets->data count]==0) and aborts a clean quit.
        // Idempotent + panic-free; safe to fire on both exit events.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if matches!(
            _event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            dictation::shutdown(_app_handle);
        }
    });
}
