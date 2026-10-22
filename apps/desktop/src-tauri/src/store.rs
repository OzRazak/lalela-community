//! Local persistence: a SQLite index (app data dir) plus clean Markdown files
//! written into the user's chosen save folder. DOCX export via docx-rs, PDF
//! via printpdf.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::transcribe::Segment;

// ---------- Types shared with the frontend ----------

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// Parent folder id; None = root. Folders form a tree.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Local-only "starred" preference (A6). Not mirrored to the cloud — a
    /// per-device favourite, so `#[serde(default)]` keeps cloud project
    /// payloads (which lack the field) deserialising cleanly.
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Serialize, Clone)]
pub struct MeetingMeta {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub created_at: i64,
    pub has_summary: bool,
    /// Short preview for list cards: summary head if present, else the start
    /// of the transcript.
    pub snippet: String,
    /// Local-only "starred" preference (A6); not synced to the cloud.
    pub is_favorite: bool,
}

/// An image captured during/after a meeting, stored as a file under the
/// meeting's `images/` folder and referenced by relative path in the Markdown.
#[derive(Serialize, Deserialize, Clone)]
pub struct MeetingImage {
    pub id: String,
    /// Transcript timestamp (ms) the image is anchored to.
    pub t_ms: i64,
    /// Path relative to the meeting folder, e.g. `images/cap-123.png`.
    pub rel_path: String,
    pub caption: String,
}

/// A calendar attendee attached to a meeting (Slice 9): display name and/or
/// email. Mirrors the cloud `meetings.attendees` jsonb shape (phase17) so
/// desktop rows and web/connector rows stay interchangeable.
#[derive(Serialize, Deserialize, Clone)]
pub struct Attendee {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// A lean, attendees-only projection of a meeting for the People & Companies
/// grouping (Wave E2). Just id/title/folder/timestamp plus the parsed calendar
/// attendees — NONE of the heavy transcript/summary/notes/images payloads.
/// `list_meeting_attendees` returns one of these per meeting across the WHOLE
/// store (no LIMIT), so grouping no longer reads each meeting's full row and can
/// drop the old ~2000-meeting scan cap.
#[derive(Serialize, Clone)]
pub struct MeetingAttendees {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub created_at: i64,
    /// Calendar attendees (Slice 9); empty when the meeting had no calendar match.
    pub attendees: Vec<Attendee>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FullMeeting {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub created_at: i64,
    pub dir_path: Option<String>,
    pub segments: Vec<Segment>,
    pub notes: String,
    pub summary: String,
    /// AI-enhanced notes (Wave A3): the user's rough notes merged with the
    /// transcript into polished, cited notes. Stored SEPARATELY from `notes` —
    /// the user's own notes are never mutated — and idempotently re-runnable
    /// from notes+transcript. Empty string = not enhanced yet.
    #[serde(default)]
    pub enhanced_notes: String,
    #[serde(default)]
    pub images: Vec<MeetingImage>,
    /// Calendar attendees (Slice 9) — None for meetings without a calendar match.
    #[serde(default)]
    pub attendees: Option<Vec<Attendee>>,
}

/// An image handed up from a live recording, still in app-data staging,
/// to be moved into the meeting folder when the meeting is saved.
#[derive(Deserialize)]
pub struct ImageInput {
    pub t_ms: i64,
    pub src_path: String,
    #[serde(default)]
    pub caption: String,
}

#[derive(Deserialize)]
pub struct SaveMeetingInput {
    pub title: String,
    pub project_id: Option<String>,
    pub segments: Vec<Segment>,
    pub notes: String,
    pub summary: String,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    /// Calendar attendees from the recording-time calendar match (Slice 9).
    #[serde(default)]
    pub attendees: Option<Vec<Attendee>>,
}

/// One authored, timestamped entry in a meeting's notes LOG (A7). Meeting notes
/// are a log of these entries rather than one blob: anyone who can see a meeting
/// can ADD an entry; only the author can edit/delete their own. `meetings.notes`
/// is DERIVED from these (chronological concatenation) so Enhance (A3), FTS,
/// notes.md and sync keep working on the same field. `author_id = None` means
/// the entry was created locally while signed out — rendered "You" and treated
/// as this device's, then claimed as yours (author_id = uid) on first push.
#[derive(Serialize, Deserialize, Clone)]
pub struct NoteEntry {
    pub id: String,
    pub meeting_id: String,
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub author_name: String,
    pub text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------- Helpers ----------

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn gen_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}")
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim().trim_matches('-').trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

// ---------- DB lifecycle ----------

pub fn open(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    migrate(&conn)?;
    // Auto-sort ledger (meeting_sort) — its own module, see autosort.rs.
    crate::autosort::migrate(&conn)?;
    // Folder automations (scheduled per-folder rules) — see folder_rules.rs.
    crate::folder_rules::migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            project_id TEXT,
            created_at INTEGER NOT NULL,
            dir_path TEXT,
            transcript_json TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    // Phase 6: images. SQLite has no `ADD COLUMN IF NOT EXISTS`, so guard it.
    let has_images: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name='images_json'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_images {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // Slice 9: calendar attendees ({name,email}[] JSON, nullable) — populated
    // by the Microsoft calendar match on native recordings and by direct
    // Teams transcript imports. Same guarded-ALTER pattern as images_json.
    let has_attendees: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name='attendees_json'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_attendees {
        conn.execute("ALTER TABLE meetings ADD COLUMN attendees_json TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // Nested folders: projects form a tree via parent_id (NULL = root).
    let has_parent: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name='parent_id'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_parent {
        conn.execute("ALTER TABLE projects ADD COLUMN parent_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // A6 favourites: a local-only "starred" flag on both meetings and projects
    // (Granola-parity Wave A). LOCAL ONLY by design — a per-device preference
    // that is never mirrored to Supabase. Same guarded-ALTER pattern as above.
    let meetings_have_fav: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name='is_favorite'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !meetings_have_fav {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let projects_have_fav: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name='is_favorite'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !projects_have_fav {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // A3 "Enhance my notes": AI-polished notes stored SEPARATELY from the user's
    // own `notes` (which are never mutated). Empty = not enhanced yet. Same
    // guarded-ALTER pattern as above. The matching cloud column ships in
    // docs/sql/phase25_enhanced_notes.sql (applied to prod separately).
    let meetings_have_enhanced: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name='enhanced_notes'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !meetings_have_enhanced {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN enhanced_notes TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // A7 "Notes log with authorship": a meeting's notes become a LOG of authored,
    // timestamped entries. `meetings.notes` is now DERIVED from these entries
    // (chronological concatenation, blank-line separated) so Enhance (A3), FTS,
    // notes.md and cloud sync keep operating on the same `notes` field unchanged.
    // author_id NULL = created locally while signed out (rendered "You"; claimed
    // as yours on first cloud push). Cloud mirror ships in
    // docs/sql/phase26_note_entries.sql (applied to prod separately).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meeting_note_entries (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            author_id TEXT,
            author_name TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_entries_meeting
            ON meeting_note_entries(meeting_id);",
    )
    .map_err(|e| e.to_string())?;

    // One-time back-fill: materialize every meeting's existing non-empty notes
    // as a single authorless entry (created_at = the meeting's) so historical
    // notes appear in the log. Guarded by a settings flag so it converts pre-A7
    // rows exactly once and never races cloud-pulled entries on later restarts.
    // The NOT EXISTS guard is a belt-and-braces double-insert guard for that run.
    if get_setting(conn, "note_entries_backfilled").as_deref() != Some("1") {
        conn.execute(
            "INSERT INTO meeting_note_entries(id, meeting_id, author_id, author_name, text, created_at, updated_at)
             SELECT 'noteentry-backfill-' || m.id, m.id, NULL, '', m.notes, m.created_at, m.created_at
             FROM meetings m
             WHERE trim(m.notes) <> ''
               AND NOT EXISTS (SELECT 1 FROM meeting_note_entries e WHERE e.meeting_id = m.id)",
            [],
        )
        .map_err(|e| e.to_string())?;
        set_setting(conn, "note_entries_backfilled", "1")?;
    }

    // Workflows: reusable prompt pipelines (global templates) + their
    // per-meeting block outputs. Outputs live in their own table so re-running
    // one block is a plain upsert — no read-modify-write races with
    // update_meeting on a JSON column.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            blocks_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_workflow_outputs (
            meeting_id TEXT NOT NULL,
            workflow_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            output TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (meeting_id, workflow_id, block_id)
        );",
    )
    .map_err(|e| e.to_string())?;

    // Action items: extracted per meeting, approved into the global kanban.
    // status: suggested -> approved -> in_progress -> done (kanban shows the
    // last three; suggested lives only in the meeting's Actions tab).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS action_items (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            title TEXT NOT NULL,
            assignee_name TEXT,
            assignee_uid TEXT,
            status TEXT NOT NULL DEFAULT 'suggested',
            due TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    // Chat threads: persisted history for the three chat surfaces (global,
    // folder, meeting). Messages are appended only after a successful
    // generation, so there are never orphan questions. No FK: messages are
    // deleted explicitly with their thread.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_threads (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            scope_id TEXT,
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_threads_scope
            ON chat_threads(scope, scope_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
            ON chat_messages(thread_id, created_at);",
    )
    .map_err(|e| e.to_string())?;

    // Speaker identity (Intelligence Layer, Slice 1). LOCAL ONLY by design:
    // voiceprint embeddings are biometric, so neither table is mirrored to
    // Supabase (also keeps the cloud footprint on the free tier). Observation
    // embeddings are kept so a later "this is X" on a saved meeting can still
    // enrol that voice (the audio itself is long gone by then).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS speakers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            aliases_json TEXT NOT NULL DEFAULT '[]',
            role TEXT,
            voiceprint BLOB,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS speaker_observations (
            id TEXT PRIMARY KEY,
            speaker_id TEXT,
            meeting_id TEXT NOT NULL,
            cluster_label TEXT NOT NULL,
            embedding BLOB,
            confidence REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_speaker_obs_meeting
            ON speaker_observations(meeting_id);
        CREATE INDEX IF NOT EXISTS idx_speaker_obs_speaker
            ON speaker_observations(speaker_id);",
    )
    .map_err(|e| e.to_string())?;

    // External imports (Slice 2; Slice 7 reuses this table for audio via the
    // media_* columns). Local only — imported meetings sync like any other
    // meeting; the provenance row stays with the importing device.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS import_sources (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'transcript',
            format TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            trust_level TEXT NOT NULL DEFAULT 'external-unverified',
            media_duration_ms INTEGER,
            decoded_sample_rate INTEGER,
            imported_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_import_sources_meeting
            ON import_sources(meeting_id);",
    )
    .map_err(|e| e.to_string())?;

    // Knowledge layer (Slice 3). Wiki pages are LLM-compiled Markdown files
    // under <save_root>/wiki/ with an index + per-fact provenance here.
    // meeting_fts is the local full-text index behind retrieval (FTS5 ships
    // in rusqlite's bundled SQLite) — no cloud vector store, per the
    // free-tier constraint; provenance keeps every derived claim auditable.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wiki_pages (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            summary_line TEXT NOT NULL DEFAULT '',
            tags_json TEXT NOT NULL DEFAULT '[]',
            links_json TEXT NOT NULL DEFAULT '[]',
            md_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wiki_fact_provenance (
            id TEXT PRIMARY KEY,
            wiki_page_id TEXT NOT NULL,
            meeting_id TEXT NOT NULL,
            t_ms INTEGER,
            quote TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_prov_page
            ON wiki_fact_provenance(wiki_page_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS meeting_fts USING fts5(
            meeting_id UNINDEXED, title, content
        );",
    )
    .map_err(|e| e.to_string())?;

    // Phase 19: tags + automations (SQLite mirror of docs/sql/phase19). A tag
    // optionally carries one automation (match rules + actions as raw JSON —
    // parsed frontend-side); automation_runs is the idempotency ledger shared
    // with the cloud engine via sync, so a meeting processed there is a no-op
    // here (and vice versa).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#7c6cf5',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_tags (
            meeting_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            added_by TEXT NOT NULL DEFAULT 'manual',
            created_at INTEGER NOT NULL,
            PRIMARY KEY (meeting_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_tags_tag ON meeting_tags(tag_id);
        CREATE TABLE IF NOT EXISTS automations (
            tag_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            match_json TEXT NOT NULL DEFAULT '{}',
            ai_classify_json TEXT NOT NULL DEFAULT '{\"enabled\":false}',
            actions_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs (
            meeting_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            detail_json TEXT,
            ran_by TEXT NOT NULL,
            ran_at INTEGER NOT NULL,
            PRIMARY KEY (meeting_id, tag_id, action)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_status
            ON automation_runs(status, ran_at DESC);",
    )
    .map_err(|e| e.to_string())?;

    // Phase 19: where a meeting came from ('desktop' | 'web' | 'teams' |
    // 'readai' | …) — lets automation rules match on source as a column check
    // instead of id-prefix parsing. Guarded ALTER + one-time backfill from the
    // id conventions (mtg-* native, conn-<provider>-* imports, web-* browser).
    let has_source: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name='source'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !has_source {
        conn.execute("ALTER TABLE meetings ADD COLUMN source TEXT", [])
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "UPDATE meetings SET source = CASE
                WHEN id LIKE 'conn-%' THEN substr(id, 6, instr(substr(id, 6), '-') - 1)
                WHEN id LIKE 'web-%' THEN 'web'
                ELSE 'desktop'
             END WHERE source IS NULL;",
        )
        .map_err(|e| e.to_string())?;
    }

    // Phase 20: reports ("reflect over my meetings"). A report is a saved prompt
    // + a scope (all / folder / tag / date_range) + a cadence; running it
    // resolves the scope to a set of meeting summaries, runs the prompt through
    // the AI front door, and stores the result as a report_outputs row. SQLite
    // mirror of docs/sql/phase20_reports.sql (owner-only there; local-only here,
    // like workflows — the two stores share a shape but do not sync). Outputs
    // cascade-delete with their report (enforced in delete_report).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            scope_type TEXT NOT NULL DEFAULT 'all',
            scope_value TEXT,
            cadence TEXT NOT NULL DEFAULT 'manual',
            model TEXT NOT NULL DEFAULT '',
            last_run_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_outputs (
            id TEXT PRIMARY KEY,
            report_id TEXT NOT NULL,
            title TEXT NOT NULL,
            body_md TEXT NOT NULL DEFAULT '',
            generated_at INTEGER NOT NULL,
            meeting_count INTEGER NOT NULL DEFAULT 0,
            scope_label TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_report_outputs_report
            ON report_outputs(report_id, generated_at DESC);",
    )
    .map_err(|e| e.to_string())?;

    // Issue #284: a connector import whose id collided with ANOTHER account's
    // cloud row is re-keyed locally to a per-owner id (`rekey_meeting`). The
    // old id stays resolvable through this alias table so deep links, wiki
    // citations and anything else still holding it keep opening the meeting.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meeting_id_aliases (
            old_id TEXT PRIMARY KEY,
            new_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_id_aliases_new
            ON meeting_id_aliases(new_id);",
    )
    .map_err(|e| e.to_string())?;

    // Backfill the FTS index once for meetings that predate it.
    let fts_empty: bool = conn
        .query_row("SELECT COUNT(*) FROM meeting_fts", [], |r| r.get::<_, i64>(0))
        .map(|n| n == 0)
        .unwrap_or(true);
    if fts_empty {
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM meetings")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .unwrap_or_default();
        for id in ids {
            if let Ok(m) = get_meeting(conn, &id) {
                let _ = refresh_meeting_fts(conn, &m);
            }
        }
    }
    Ok(())
}

/// Keep the full-text index in step with a meeting. Called from every write
/// path (write_files) and the one-time backfill above.
fn refresh_meeting_fts(conn: &Connection, m: &FullMeeting) -> Result<(), String> {
    conn.execute("DELETE FROM meeting_fts WHERE meeting_id=?1", [m.id.as_str()])
        .map_err(|e| e.to_string())?;
    let mut content = String::new();
    for seg in &m.segments {
        content.push_str(&seg.speaker);
        content.push_str(": ");
        content.push_str(&seg.text);
        content.push('\n');
    }
    content.push_str(&m.summary);
    content.push('\n');
    content.push_str(&m.notes);
    // Enhanced notes (A3): index the polished, cited version too so its phrasing
    // is searchable. Non-empty guard avoids a stray blank line for un-enhanced
    // meetings (the vast majority).
    if !m.enhanced_notes.is_empty() {
        content.push('\n');
        content.push_str(&m.enhanced_notes);
    }
    // Slide text: image captions carry the OCR of captured/imported slides —
    // indexing them makes what was ON SCREEN searchable, not just what was said.
    for img in &m.images {
        if !img.caption.is_empty() {
            content.push('\n');
            content.push_str(&img.caption);
        }
    }
    conn.execute(
        "INSERT INTO meeting_fts(meeting_id, title, content) VALUES(?1, ?2, ?3)",
        rusqlite::params![m.id, m.title, content],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Settings (save folder) ----------

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=?2",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The folder where meeting Markdown is written; defaults to <fallback>/Lalela Meetings.
pub fn save_root(conn: &Connection, fallback: &Path) -> PathBuf {
    match get_setting(conn, "save_folder") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => fallback.join("Lalela Meetings"),
    }
}

// ---------- Task board stages (phase21; cloud-synced per user) ----------
// The ordered custom-stage list is a single JSON blob in the settings KV table.
// It mirrors the cloud `task_stages` row so the same columns are available on
// every device even offline; localStorage on the frontend is a fast cache on
// top. The JSON shape (TaskStage[]) is owned + normalised frontend-side.
const TASK_STAGES_KEY: &str = "tasks.stages";

/// The stored stage-list JSON, or None if the user hasn't customised columns.
pub fn get_task_stages(conn: &Connection) -> Option<String> {
    get_setting(conn, TASK_STAGES_KEY)
}

/// Persist the stage-list JSON (already normalised by the frontend).
pub fn set_task_stages(conn: &Connection, json: &str) -> Result<(), String> {
    set_setting(conn, TASK_STAGES_KEY, json)
}

// ---------- Workspace card (Intelligence Layer, Slice 0) ----------
// A user-editable `workspace.md` at the save root: company one-liner, key
// people, clients, glossary. Injected into AI system prompts (frontend
// `ai.ts`) and mined for transcription bias terms (`asr::biasing`).

pub fn workspace_md_path(save_root: &Path) -> PathBuf {
    save_root.join("workspace.md")
}

/// Read the workspace card; empty string when none exists yet.
pub fn read_workspace_md(save_root: &Path) -> String {
    std::fs::read_to_string(workspace_md_path(save_root)).unwrap_or_default()
}

/// Write the workspace card (creates the save root if needed).
pub fn write_workspace_md(save_root: &Path, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(save_root).map_err(|e| e.to_string())?;
    std::fs::write(workspace_md_path(save_root), content).map_err(|e| e.to_string())
}

/// The custom dictionary (`dictionary.md` at the save root, Slice 0-ext):
/// explicit transcription-bias terms with optional weight / sounds-like.
pub fn dictionary_md_path(save_root: &Path) -> PathBuf {
    save_root.join("dictionary.md")
}

pub fn read_dictionary_md(save_root: &Path) -> String {
    std::fs::read_to_string(dictionary_md_path(save_root)).unwrap_or_default()
}

pub fn write_dictionary_md(save_root: &Path, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(save_root).map_err(|e| e.to_string())?;
    std::fs::write(dictionary_md_path(save_root), content).map_err(|e| e.to_string())
}

// ---------- Projects ----------

pub fn list_projects(conn: &Connection) -> Result<Vec<Project>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,name,created_at,parent_id,is_favorite FROM projects ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                parent_id: r.get(3)?,
                is_favorite: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn create_project(
    conn: &Connection,
    name: &str,
    parent_id: Option<&str>,
) -> Result<Project, String> {
    let p = Project {
        id: gen_id("proj"),
        name: name.trim().to_string(),
        created_at: now_millis(),
        parent_id: parent_id.map(|s| s.to_string()),
        is_favorite: false,
    };
    conn.execute(
        "INSERT INTO projects(id,name,created_at,parent_id) VALUES(?1,?2,?3,?4)",
        rusqlite::params![p.id, p.name, p.created_at, p.parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(p)
}

/// True if `candidate` is `id` itself or one of its descendants — used to
/// refuse folder moves that would create a cycle. Bounded in case of
/// corrupted parent data.
fn is_self_or_descendant(conn: &Connection, id: &str, candidate: &str) -> bool {
    let mut current = Some(candidate.to_string());
    for _ in 0..100 {
        match current {
            Some(ref c) if c == id => return true,
            Some(c) => {
                current = conn
                    .query_row("SELECT parent_id FROM projects WHERE id=?1", [&c], |r| {
                        r.get::<_, Option<String>>(0)
                    })
                    .unwrap_or(None);
            }
            None => return false,
        }
    }
    false
}

/// Re-parent a folder (None = move to root). Refuses moves into itself or a
/// descendant.
pub fn set_project_parent(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    if let Some(target) = parent_id {
        if is_self_or_descendant(conn, id, target) {
            return Err("Cannot move a folder into its own subfolder".into());
        }
    }
    conn.execute(
        "UPDATE projects SET parent_id=?2 WHERE id=?1",
        rusqlite::params![id, parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn rename_project(conn: &Connection, id: &str, name: &str) -> Result<Project, String> {
    // Only the DB name changes: meeting_dir() derives paths from the project
    // name, so FUTURE markdown rewrites land under the new folder name, while
    // existing folders stay where they are (deliberate — no risky disk moves).
    conn.execute(
        "UPDATE projects SET name=?2 WHERE id=?1",
        rusqlite::params![id, name.trim()],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,name,created_at,parent_id,is_favorite FROM projects WHERE id=?1",
        [id],
        |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                parent_id: r.get(3)?,
                is_favorite: r.get::<_, i64>(4)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Delete a project. Its meetings are kept and become Unfiled, its subfolders
/// move up to the deleted folder's parent; markdown folders on disk are
/// untouched.
pub fn delete_project(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE projects SET parent_id = (SELECT parent_id FROM projects WHERE id=?1)
         WHERE parent_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("UPDATE meetings SET project_id=NULL WHERE project_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set (or clear) a folder's local-only "starred" flag (A6). Not synced.
pub fn set_project_favorite(conn: &Connection, id: &str, fav: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE projects SET is_favorite=?2 WHERE id=?1",
        rusqlite::params![id, fav as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Meetings ----------

fn project_name(conn: &Connection, project_id: &Option<String>) -> String {
    match project_id {
        Some(id) => conn
            .query_row("SELECT name FROM projects WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or_else(|_| "Unfiled".to_string()),
        None => "Unfiled".to_string(),
    }
}

/// Max characters in a list-card snippet.
const SNIPPET_LEN: usize = 160;

/// Build a card snippet from a summary head (first 400 chars) and a
/// transcript_json head (first 4 KB). The transcript head is TRUNCATED JSON, so
/// it is never parsed — the `"text":"…"` values are scraped out directly.
fn make_snippet(summary_head: &str, transcript_head: &str) -> String {
    let summary = summary_head.trim();
    let text = if !summary.is_empty() {
        // Strip markdown noise (headings, bullets, emphasis) so the card reads
        // like a sentence.
        summary
            .lines()
            .map(|l| l.trim_start_matches(['#', '*', '-', '>', '`', ' ']))
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        let mut out = String::new();
        let mut rest = transcript_head;
        while let Some(pos) = rest.find("\"text\":\"") {
            rest = &rest[pos + 8..];
            let mut end = 0;
            let bytes = rest.as_bytes();
            while end < bytes.len() {
                if bytes[end] == b'"' && (end == 0 || bytes[end - 1] != b'\\') {
                    break;
                }
                end += 1;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(rest[..end].trim());
            if out.len() >= SNIPPET_LEN {
                break;
            }
            rest = &rest[end..];
        }
        out
    };

    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SNIPPET_LEN {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(SNIPPET_LEN).collect();
        format!("{}…", cut.trim_end())
    }
}

pub fn list_meetings(conn: &Connection, project_id: Option<&str>) -> Result<Vec<MeetingMeta>, String> {
    // Only heads are fetched — transcript_json can be megabytes.
    let (sql, has_filter) = match project_id {
        Some(_) => (
            "SELECT id,title,project_id,created_at,substr(summary,1,400),substr(transcript_json,1,4096),is_favorite FROM meetings WHERE project_id=?1 ORDER BY created_at DESC",
            true,
        ),
        None => (
            "SELECT id,title,project_id,created_at,substr(summary,1,400),substr(transcript_json,1,4096),is_favorite FROM meetings ORDER BY created_at DESC",
            false,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| {
        let summary_head: String = r.get(4)?;
        let transcript_head: String = r.get(5)?;
        Ok(MeetingMeta {
            id: r.get(0)?,
            title: r.get(1)?,
            project_id: r.get(2)?,
            created_at: r.get(3)?,
            has_summary: !summary_head.trim().is_empty(),
            snippet: make_snippet(&summary_head, &transcript_head),
            is_favorite: r.get::<_, i64>(6)? != 0,
        })
    };
    let rows = if has_filter {
        stmt.query_map([project_id.unwrap()], map)
    } else {
        stmt.query_map([], map)
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// List the heads of meetings in ANY of `project_ids` (one `WHERE project_id IN
/// (…)` query) — powers the folder "include subfolders" mode, where the frontend
/// passes a folder plus all its descendant folder ids. An empty slice returns an
/// empty vec without touching the DB. Same head columns / ordering as
/// `list_meetings` so rows render identically.
pub fn list_meetings_in(
    conn: &Connection,
    project_ids: &[String],
) -> Result<Vec<MeetingMeta>, String> {
    if project_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(project_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id,title,project_id,created_at,substr(summary,1,400),substr(transcript_json,1,4096),is_favorite FROM meetings WHERE project_id IN ({placeholders}) ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(project_ids), |r: &rusqlite::Row| {
            let summary_head: String = r.get(4)?;
            let transcript_head: String = r.get(5)?;
            Ok(MeetingMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                has_summary: !summary_head.trim().is_empty(),
                snippet: make_snippet(&summary_head, &transcript_head),
                is_favorite: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Attendees-only projection over EVERY meeting (no LIMIT), newest-first — the
/// lean read behind People & Companies (Wave E2). Returns just id/title/folder/
/// created_at plus each meeting's parsed calendar attendees, deliberately
/// omitting transcript/summary/notes/images so the whole store can be grouped in
/// one query. This replaces the old path, which read each meeting's FULL row via
/// `get_meeting` (one call per meeting) and so was capped at ~2000 rows to stay
/// cheap. Even a 10k-meeting store is a few MB of lean rows.
pub fn list_meeting_attendees(conn: &Connection) -> Result<Vec<MeetingAttendees>, String> {
    // Only these five columns — never the megabyte transcript/summary payloads.
    let mut stmt = conn
        .prepare(
            "SELECT id,title,project_id,created_at,attendees_json FROM meetings ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r: &rusqlite::Row| {
            let attendees_json: Option<String> = r.get(4)?;
            // Malformed/absent attendee JSON degrades to no attendees, never an error.
            let attendees: Vec<Attendee> = attendees_json
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default();
            Ok(MeetingAttendees {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                attendees,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn get_meeting(conn: &Connection, id: &str) -> Result<FullMeeting, String> {
    conn.query_row(
        "SELECT id,title,project_id,created_at,dir_path,transcript_json,notes,summary,images_json,attendees_json,enhanced_notes
         FROM meetings WHERE id=?1",
        [id],
        |r| {
            let transcript_json: String = r.get(5)?;
            let segments: Vec<Segment> = serde_json::from_str(&transcript_json).unwrap_or_default();
            let images_json: String = r.get(8)?;
            let images: Vec<MeetingImage> = serde_json::from_str(&images_json).unwrap_or_default();
            let attendees_json: Option<String> = r.get(9)?;
            let attendees: Option<Vec<Attendee>> =
                attendees_json.and_then(|j| serde_json::from_str(&j).ok());
            Ok(FullMeeting {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                dir_path: r.get(4)?,
                segments,
                notes: r.get(6)?,
                summary: r.get(7)?,
                enhanced_notes: r.get(10)?,
                images,
                attendees,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Serialize attendees for storage; None (and empty lists) stay NULL.
fn attendees_json_of(attendees: &Option<Vec<Attendee>>) -> Result<Option<String>, String> {
    match attendees {
        Some(list) if !list.is_empty() => {
            serde_json::to_string(list).map(Some).map_err(|e| e.to_string())
        }
        _ => Ok(None),
    }
}

/// Insert a new meeting and write its Markdown files under the save root.
pub fn insert_meeting(
    conn: &Connection,
    input: SaveMeetingInput,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    let id = gen_id("mtg");
    let created_at = now_millis();
    let transcript_json = serde_json::to_string(&input.segments).map_err(|e| e.to_string())?;

    let mut meeting = FullMeeting {
        id: id.clone(),
        title: input.title,
        project_id: input.project_id,
        created_at,
        dir_path: None,
        segments: input.segments,
        notes: input.notes,
        summary: input.summary,
        // A new meeting is never enhanced yet; enhancement is an explicit,
        // later action (update_enhanced_notes). The DB column defaults to ''
        // so this stays out of the INSERT column list below.
        enhanced_notes: String::new(),
        images: Vec::new(),
        attendees: input.attendees,
    };

    // Move any images captured during the live recording (staged in app data)
    // into this meeting's `images/` folder and record their relative paths.
    let dir = meeting_dir(conn, &meeting, save_root);
    let images_dir = dir.join("images");
    for inp in &input.images {
        let src = PathBuf::from(&inp.src_path);
        let fname = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(crate::capture::capture_filename);
        let dest = images_dir.join(&fname);
        if crate::capture::move_file(&src, &dest).is_err() {
            continue; // skip images we couldn't move; don't lose the meeting
        }
        meeting.images.push(MeetingImage {
            id: crate::capture::image_id(),
            t_ms: inp.t_ms,
            rel_path: format!("images/{fname}"),
            caption: inp.caption.clone(),
        });
    }
    let images_json = serde_json::to_string(&meeting.images).map_err(|e| e.to_string())?;
    let attendees_json = attendees_json_of(&meeting.attendees)?;

    write_files(conn, &meeting, save_root)?;
    meeting.dir_path = Some(dir.to_string_lossy().to_string());

    conn.execute(
        "INSERT INTO meetings(id,title,project_id,created_at,dir_path,transcript_json,notes,summary,images_json,attendees_json,source)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'desktop')",
        rusqlite::params![
            meeting.id,
            meeting.title,
            meeting.project_id,
            meeting.created_at,
            meeting.dir_path,
            transcript_json,
            meeting.notes,
            meeting.summary,
            images_json,
            attendees_json,
        ],
    )
    .map_err(|e| e.to_string())?;

    // A7: seed the notes LOG. Any notes captured at creation time — the live
    // recording pane's text, or an import's notes — become ONE authorless entry
    // (claimed as yours on first push). `notes` already equals this single
    // entry's text, so no re-derive/rewrite is needed here.
    if !meeting.notes.trim().is_empty() {
        conn.execute(
            "INSERT INTO meeting_note_entries(id,meeting_id,author_id,author_name,text,created_at,updated_at)
             VALUES(?1,?2,NULL,'',?3,?4,?4)",
            rusqlite::params![gen_id("noteentry"), meeting.id, meeting.notes, meeting.created_at],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(meeting)
}

/// Provenance from the id convention: conn-<provider>-<hash> imports keep
/// their provider, web-* are browser recordings, everything else is desktop.
fn source_for_id(id: &str) -> String {
    if let Some(rest) = id.strip_prefix("conn-") {
        if let Some((provider, _)) = rest.split_once('-') {
            if !provider.is_empty() {
                return provider.to_string();
            }
        }
    }
    if id.starts_with("web-") {
        return "web".to_string();
    }
    "desktop".to_string()
}

/// Replace a meeting's image list (used when capturing into a saved meeting or
/// removing an image), then rewrite its Markdown files.
pub fn update_images(
    conn: &Connection,
    id: &str,
    images: &[MeetingImage],
    save_root: &Path,
) -> Result<FullMeeting, String> {
    let images_json = serde_json::to_string(images).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE meetings SET images_json=?2 WHERE id=?1",
        rusqlite::params![id, images_json],
    )
    .map_err(|e| e.to_string())?;
    let meeting = get_meeting(conn, id)?;
    let dir = write_files(conn, &meeting, save_root)?;
    conn.execute(
        "UPDATE meetings SET dir_path=?2 WHERE id=?1",
        rusqlite::params![id, dir.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    get_meeting(conn, id)
}

/// Update editable fields and rewrite the Markdown files.
pub fn update_meeting(
    conn: &Connection,
    id: &str,
    title: &str,
    notes: &str,
    summary: &str,
    project_id: Option<&str>,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    // Folder picked in the meeting view = a hand sort (auto-sort ledger).
    let before = crate::autosort::current_project(conn, id)?;
    conn.execute(
        "UPDATE meetings SET title=?2, notes=?3, summary=?4, project_id=?5 WHERE id=?1",
        rusqlite::params![id, title, notes, summary, project_id],
    )
    .map_err(|e| e.to_string())?;
    crate::autosort::note_user_folder_change(conn, id, before, project_id)?;
    let meeting = get_meeting(conn, id)?;
    let dir = write_files(conn, &meeting, save_root)?;
    conn.execute(
        "UPDATE meetings SET dir_path=?2 WHERE id=?1",
        rusqlite::params![id, dir.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    get_meeting(conn, id)
}

/// Set (or clear) a meeting's AI-enhanced notes (Wave A3) and rewrite its
/// Markdown files (notes.md gains an `## Enhanced (AI)` section). The user's
/// own `notes` are never touched — enhancement is a separate, idempotently
/// re-runnable field derived from notes + transcript.
pub fn update_enhanced_notes(
    conn: &Connection,
    id: &str,
    text: &str,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    conn.execute(
        "UPDATE meetings SET enhanced_notes=?2 WHERE id=?1",
        rusqlite::params![id, text],
    )
    .map_err(|e| e.to_string())?;
    let meeting = get_meeting(conn, id)?;
    let dir = write_files(conn, &meeting, save_root)?;
    conn.execute(
        "UPDATE meetings SET dir_path=?2 WHERE id=?1",
        rusqlite::params![id, dir.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    get_meeting(conn, id)
}

// ---------- Notes log entries (A7) ----------

/// Derive a meeting's `notes` from its entry log: the entry texts in
/// chronological order (created_at, then id), blank-line separated. Wholly-empty
/// entries drop out. This is the single source of the derived-notes bridge —
/// notes.md, FTS, Enhance (A3) and cloud sync all read this same `notes` field.
fn derive_notes(conn: &Connection, meeting_id: &str) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT text FROM meeting_note_entries WHERE meeting_id=?1
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let texts: Vec<String> = stmt
        .query_map([meeting_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(texts
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Re-derive `meetings.notes` from the entry log, then rewrite the Markdown
/// files (notes.md + `## Enhanced (AI)`) and refresh FTS. Called after every
/// entry mutation (add/edit/delete) and cloud entry pull.
fn rederive_notes_and_write(
    conn: &Connection,
    meeting_id: &str,
    save_root: &Path,
) -> Result<(), String> {
    let notes = derive_notes(conn, meeting_id)?;
    conn.execute(
        "UPDATE meetings SET notes=?2 WHERE id=?1",
        rusqlite::params![meeting_id, notes],
    )
    .map_err(|e| e.to_string())?;
    // Rewrite files + refresh FTS only when the meeting exists locally.
    if let Ok(m) = get_meeting(conn, meeting_id) {
        let dir = write_files(conn, &m, save_root)?;
        conn.execute(
            "UPDATE meetings SET dir_path=?2 WHERE id=?1",
            rusqlite::params![meeting_id, dir.to_string_lossy().to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn row_to_note_entry(r: &rusqlite::Row) -> rusqlite::Result<NoteEntry> {
    Ok(NoteEntry {
        id: r.get(0)?,
        meeting_id: r.get(1)?,
        author_id: r.get(2)?,
        author_name: r.get(3)?,
        text: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn list_note_entries(conn: &Connection, meeting_id: &str) -> Result<Vec<NoteEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,meeting_id,author_id,author_name,text,created_at,updated_at
             FROM meeting_note_entries WHERE meeting_id=?1
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([meeting_id], row_to_note_entry)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Append an entry to a meeting's notes log, stamped with the caller's author
/// identity (None = signed out). Re-derives `notes`, rewrites files, and returns
/// the fresh entry list.
pub fn add_note_entry(
    conn: &Connection,
    meeting_id: &str,
    author_id: Option<&str>,
    author_name: &str,
    text: &str,
    save_root: &Path,
) -> Result<Vec<NoteEntry>, String> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO meeting_note_entries(id,meeting_id,author_id,author_name,text,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?6)",
        rusqlite::params![gen_id("noteentry"), meeting_id, author_id, author_name, text, now],
    )
    .map_err(|e| e.to_string())?;
    rederive_notes_and_write(conn, meeting_id, save_root)?;
    list_note_entries(conn, meeting_id)
}

/// Edit one entry's text. Author enforcement is client-side (this device's DB is
/// single-user); real cross-user enforcement is the cloud RLS (phase26).
pub fn update_note_entry(
    conn: &Connection,
    id: &str,
    text: &str,
    save_root: &Path,
) -> Result<Vec<NoteEntry>, String> {
    let meeting_id: String = conn
        .query_row(
            "SELECT meeting_id FROM meeting_note_entries WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE meeting_note_entries SET text=?2, updated_at=?3 WHERE id=?1",
        rusqlite::params![id, text, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    rederive_notes_and_write(conn, &meeting_id, save_root)?;
    list_note_entries(conn, &meeting_id)
}

/// Delete one entry. Returns the fresh entry list for its meeting.
pub fn delete_note_entry(
    conn: &Connection,
    id: &str,
    save_root: &Path,
) -> Result<Vec<NoteEntry>, String> {
    let meeting_id: String = conn
        .query_row(
            "SELECT meeting_id FROM meeting_note_entries WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_note_entries WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    rederive_notes_and_write(conn, &meeting_id, save_root)?;
    list_note_entries(conn, &meeting_id)
}

/// Claim this device's authorless entries for a meeting as the signed-in user,
/// just before pushing them to the cloud (RLS forbids inserting a null author).
/// Only fills author_name when it was blank, so a real name is never clobbered.
pub fn claim_note_entries(
    conn: &Connection,
    meeting_id: &str,
    author_id: &str,
    author_name: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE meeting_note_entries
            SET author_id=?2,
                author_name=CASE WHEN author_name='' THEN ?3 ELSE author_name END
          WHERE meeting_id=?1 AND author_id IS NULL",
        rusqlite::params![meeting_id, author_id, author_name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Upsert entries pulled from the cloud, last-write-wins on updated_at, then
/// re-derive notes + rewrite files for every touched meeting. Upsert-only: a
/// cloud row that vanished (deleted elsewhere) is not tombstoned locally in v1.
pub fn upsert_note_entries(
    conn: &Connection,
    entries: &[NoteEntry],
    save_root: &Path,
) -> Result<(), String> {
    let mut affected: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in entries {
        conn.execute(
            "INSERT INTO meeting_note_entries(id,meeting_id,author_id,author_name,text,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
                author_id=excluded.author_id,
                author_name=excluded.author_name,
                text=excluded.text,
                updated_at=excluded.updated_at
             WHERE excluded.updated_at >= meeting_note_entries.updated_at",
            rusqlite::params![
                e.id,
                e.meeting_id,
                e.author_id,
                e.author_name,
                e.text,
                e.created_at,
                e.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        affected.insert(e.meeting_id.clone());
    }
    for mid in affected {
        rederive_notes_and_write(conn, &mid, save_root)?;
    }
    Ok(())
}

/// Move a meeting to another project (None = Unfiled) and rewrite its
/// markdown under the new project's folder. Used by drag-and-drop.
pub fn set_meeting_project(
    conn: &Connection,
    meeting_id: &str,
    project_id: Option<&str>,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    conn.execute(
        "UPDATE meetings SET project_id=?2 WHERE id=?1",
        rusqlite::params![meeting_id, project_id],
    )
    .map_err(|e| e.to_string())?;
    let meeting = get_meeting(conn, meeting_id)?;
    let dir = write_files(conn, &meeting, save_root)?;
    conn.execute(
        "UPDATE meetings SET dir_path=?2 WHERE id=?1",
        rusqlite::params![meeting_id, dir.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    get_meeting(conn, meeting_id)
}

/// Set (or clear) a meeting's local-only "starred" flag (A6). Not synced, and
/// deliberately does NOT rewrite the Markdown files — favouriting is a device
/// preference, not meeting content.
pub fn set_meeting_favorite(conn: &Connection, id: &str, fav: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE meetings SET is_favorite=?2 WHERE id=?1",
        rusqlite::params![id, fav as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert-or-update a meeting by id (used to import meetings pulled from the cloud).
pub fn upsert_meeting(
    conn: &Connection,
    m: &FullMeeting,
    save_root: &Path,
) -> Result<(), String> {
    let transcript_json = serde_json::to_string(&m.segments).map_err(|e| e.to_string())?;
    let images_json = serde_json::to_string(&m.images).map_err(|e| e.to_string())?;
    let attendees_json = attendees_json_of(&m.attendees)?;
    // A re-import that changes the folder (e.g. moved on web) is a hand sort.
    let before = crate::autosort::current_project(conn, &m.id)?;
    let dir = write_files(conn, m, save_root)?;
    conn.execute(
        "INSERT INTO meetings(id,title,project_id,created_at,dir_path,transcript_json,notes,summary,images_json,attendees_json,source,enhanced_notes)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET
           title=?2, project_id=?3, dir_path=?5, transcript_json=?6, notes=?7, summary=?8, images_json=?9, attendees_json=?10, source=?11, enhanced_notes=?12",
        rusqlite::params![
            m.id,
            m.title,
            m.project_id,
            m.created_at,
            dir.to_string_lossy().to_string(),
            transcript_json,
            m.notes,
            m.summary,
            images_json,
            attendees_json,
            source_for_id(&m.id),
            m.enhanced_notes,
        ],
    )
    .map_err(|e| e.to_string())?;
    crate::autosort::note_user_folder_change(conn, &m.id, before, m.project_id.as_deref())?;
    Ok(())
}

/// A user-initiated move (drag-and-drop, move menus, queue actions, the
/// automations "move to folder" action — everything behind the
/// `move_meeting_to_project` command). Same as `set_meeting_project`, plus the
/// auto-sort ledger learns it's now hand-sorted. Auto-sort itself calls
/// `set_meeting_project` directly.
pub fn move_meeting_by_user(
    conn: &Connection,
    meeting_id: &str,
    project_id: Option<&str>,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    // One transaction: if the Markdown rewrite fails, the folder change AND
    // the ledger mark roll back together, so a retry still sees the change.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let before = crate::autosort::current_project(&tx, meeting_id)?;
    let m = set_meeting_project(&tx, meeting_id, project_id, save_root)?;
    crate::autosort::note_user_folder_change(&tx, meeting_id, before, project_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(m)
}

pub fn delete_meeting(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM meetings WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_fts WHERE meeting_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_note_entries WHERE meeting_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_workflow_outputs WHERE meeting_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM action_items WHERE meeting_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_messages WHERE thread_id IN
            (SELECT id FROM chat_threads WHERE scope='meeting' AND scope_id=?1)",
        [id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_threads WHERE scope='meeting' AND scope_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    // Old ids re-keyed onto this meeting (#284) must not resolve to nothing.
    conn.execute("DELETE FROM meeting_id_aliases WHERE new_id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Meeting id re-key (issue #284) ----------

/// Every local table column that holds a meeting id, as (table, column, extra
/// WHERE clause). `rekey_meeting` rewrites all of them; a new table that
/// stores a meeting id belongs here too (the re-key test enumerates them).
const MEETING_ID_COLUMNS: &[(&str, &str, &str)] = &[
    ("meeting_fts", "meeting_id", ""),
    ("meeting_note_entries", "meeting_id", ""),
    ("meeting_workflow_outputs", "meeting_id", ""),
    ("action_items", "meeting_id", ""),
    ("chat_threads", "scope_id", " AND scope='meeting'"),
    ("speaker_observations", "meeting_id", ""),
    ("import_sources", "meeting_id", ""),
    ("wiki_fact_provenance", "meeting_id", ""),
    ("meeting_tags", "meeting_id", ""),
    ("automation_runs", "meeting_id", ""),
    ("meeting_sort", "meeting_id", ""),
    ("folder_rule_items", "meeting_id", ""),
];

/// The id a meeting is stored under now: `id` itself when it exists, else the
/// id it was re-keyed to (alias), else `id` unchanged (callers then fail with
/// their usual "not found").
pub fn resolve_meeting_id(conn: &Connection, id: &str) -> String {
    let exists = conn
        .prepare("SELECT 1 FROM meetings WHERE id=?1")
        .and_then(|mut s| s.exists([id]))
        .unwrap_or(false);
    if exists {
        return id.to_string();
    }
    conn.query_row(
        "SELECT new_id FROM meeting_id_aliases WHERE old_id=?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| id.to_string())
}

/// Chat threads scoped to a meeting store its id in `scope_id`; resolve it
/// like any other meeting id. Other scopes pass through untouched.
pub fn resolve_chat_scope_id(conn: &Connection, scope: &str, scope_id: Option<String>) -> Option<String> {
    match scope_id {
        Some(id) if scope == "meeting" => Some(resolve_meeting_id(conn, &id)),
        other => other,
    }
}

/// Every old id that now resolves to another meeting (for import dedupe: a
/// connector import must not re-create a meeting under the id it moved off).
pub fn list_meeting_id_aliases(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT old_id FROM meeting_id_aliases ORDER BY old_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Move a meeting to a new id (#284: a connector import whose id is taken in
/// the cloud by ANOTHER account's row is re-keyed to a per-owner id so it can
/// be backed up). One transaction rewrites the meeting row and every child row
/// that references it, and records `old_id → new_id` as an alias — so a crash
/// leaves either the old meeting or the new one, never half of each.
///
/// The on-disk Markdown folder is NOT touched: its path is derived from the
/// folder/created_at/title (`meeting_dir`), never from the id, and images are
/// referenced relative to it — so nothing on disk names the id.
///
/// Refuses (Err) when `old_id` doesn't exist, when `new_id` already exists
/// locally (the per-owner copy is already here — merging two local copies is
/// not something to do silently), or when `new_id` is itself an alias.
pub fn rekey_meeting(conn: &Connection, old_id: &str, new_id: &str) -> Result<FullMeeting, String> {
    if old_id == new_id {
        return Err("rekey: old and new id are the same".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let has = |id: &str| -> Result<bool, String> {
        tx.prepare("SELECT 1 FROM meetings WHERE id=?1")
            .and_then(|mut s| s.exists([id]))
            .map_err(|e| e.to_string())
    };
    if !has(old_id)? {
        return Err(format!("rekey: meeting {old_id} not found"));
    }
    if has(new_id)? {
        return Err(format!("rekey: meeting {new_id} already exists locally"));
    }
    let new_is_alias = tx
        .prepare("SELECT 1 FROM meeting_id_aliases WHERE old_id=?1")
        .and_then(|mut s| s.exists([new_id]))
        .map_err(|e| e.to_string())?;
    if new_is_alias {
        return Err(format!("rekey: {new_id} is already an alias"));
    }
    tx.execute(
        "UPDATE meetings SET id=?2 WHERE id=?1",
        rusqlite::params![old_id, new_id],
    )
    .map_err(|e| e.to_string())?;
    for (table, column, extra) in MEETING_ID_COLUMNS {
        // OR REPLACE: a stray child row already keyed by the new id (e.g. an
        // automation run synced down early) must not abort the move — the
        // moving meeting's own row wins. FTS5 tables take a plain UPDATE.
        let verb = if *table == "meeting_fts" { "UPDATE" } else { "UPDATE OR REPLACE" };
        let sql = format!("{verb} {table} SET {column}=?2 WHERE {column}=?1{extra}");
        tx.execute(&sql, rusqlite::params![old_id, new_id])
            .map_err(|e| format!("rekey {table}: {e}"))?;
    }
    // Chains collapse: anything that pointed at the old id now points at the new.
    tx.execute(
        "UPDATE meeting_id_aliases SET new_id=?2 WHERE new_id=?1",
        rusqlite::params![old_id, new_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO meeting_id_aliases(old_id,new_id,created_at) VALUES(?1,?2,?3)
         ON CONFLICT(old_id) DO UPDATE SET new_id=?2",
        rusqlite::params![old_id, new_id, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    let moved = get_meeting(&tx, new_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}

// ---------- Workflows (prompt pipelines) ----------

/// One step of a workflow: a prompt run against either the transcript or an
/// earlier block's output, OR a "send" that pushes the meeting to a connected
/// MCP destination (T8). The send config is kept opaque here (a JSON blob) so
/// the store stays destination-agnostic — the frontend owns its shape.
#[derive(Serialize, Deserialize, Clone)]
pub struct WorkflowBlock {
    pub id: String,
    pub name: String,
    /// Block kind: None/"prompt" (default) or "send". Renamed from the TS
    /// `type` field (a Rust keyword).
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,
    /// The runnable prompt text (always inlined, even when copied from the
    /// prompt library). Empty for send blocks.
    #[serde(default)]
    pub prompt_text: String,
    /// Prompt-library id it was copied from — display only.
    #[serde(default)]
    pub prompt_ref: Option<String>,
    /// "transcript" or the id of an EARLIER block in the same workflow.
    pub input: String,
    /// Model id override; None = the user's current model.
    #[serde(default)]
    pub model: Option<String>,
    /// Send blocks only: the push config (destination + target + mode). Kept as
    /// an opaque JSON value — round-tripped verbatim, never interpreted here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub blocks: Vec<WorkflowBlock>,
    pub created_at: i64,
}

#[derive(Serialize, Clone)]
pub struct WorkflowOutput {
    pub block_id: String,
    pub output: String,
    pub updated_at: i64,
}

pub fn list_workflows(conn: &Connection) -> Result<Vec<Workflow>, String> {
    let mut stmt = conn
        .prepare("SELECT id,name,blocks_json,created_at FROM workflows ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let blocks_json: String = r.get(2)?;
            Ok(Workflow {
                id: r.get(0)?,
                name: r.get(1)?,
                blocks: serde_json::from_str(&blocks_json).unwrap_or_default(),
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Upsert a workflow template (empty id → a new one is generated).
pub fn save_workflow(conn: &Connection, mut w: Workflow) -> Result<Workflow, String> {
    if w.id.is_empty() {
        w.id = gen_id("wf");
        w.created_at = now_millis();
    }
    let blocks_json = serde_json::to_string(&w.blocks).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workflows(id,name,blocks_json,created_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=?2, blocks_json=?3",
        rusqlite::params![w.id, w.name, blocks_json, w.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(w)
}

pub fn delete_workflow(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM workflows WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_workflow_outputs WHERE workflow_id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Tags + automations (phase 19) ----------

#[derive(Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MeetingTag {
    pub meeting_id: String,
    pub tag_id: String,
    pub added_by: String,
}

/// Rule + actions config for a tag (one automation per tag). The JSON payloads
/// mirror the cloud jsonb columns and are parsed/validated frontend-side.
#[derive(Serialize, Deserialize, Clone)]
pub struct Automation {
    pub tag_id: String,
    pub enabled: bool,
    pub match_json: String,
    pub ai_classify_json: String,
    pub actions_json: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AutomationRun {
    pub meeting_id: String,
    pub tag_id: String,
    pub action: String,
    pub status: String,
    pub detail_json: Option<String>,
    pub ran_by: String,
    pub ran_at: i64,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare("SELECT id,name,color,created_at FROM tags ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Upsert a tag (empty id → a new one is generated).
pub fn save_tag(conn: &Connection, mut t: Tag) -> Result<Tag, String> {
    if t.id.is_empty() {
        t.id = gen_id("tag");
        t.created_at = now_millis();
    }
    conn.execute(
        "INSERT INTO tags(id,name,color,created_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=?2, color=?3",
        rusqlite::params![t.id, t.name, t.color, t.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(t)
}

pub fn delete_tag(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM tags WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_tags WHERE tag_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM automations WHERE tag_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM automation_runs WHERE tag_id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_meeting_tags(conn: &Connection, meeting_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag_id FROM meeting_tags WHERE meeting_id=?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([meeting_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Replace a meeting's tag set (the manual chips editor semantics).
pub fn set_meeting_tags(
    conn: &Connection,
    meeting_id: &str,
    tag_ids: &[String],
    added_by: &str,
) -> Result<(), String> {
    conn.execute("DELETE FROM meeting_tags WHERE meeting_id=?1", [meeting_id])
        .map_err(|e| e.to_string())?;
    let now = now_millis();
    for tag_id in tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO meeting_tags(meeting_id,tag_id,added_by,created_at)
             VALUES(?1,?2,?3,?4)",
            rusqlite::params![meeting_id, tag_id, added_by, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Additive tag from the automation engine; returns false if already present.
pub fn add_meeting_tag(
    conn: &Connection,
    meeting_id: &str,
    tag_id: &str,
    added_by: &str,
) -> Result<bool, String> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO meeting_tags(meeting_id,tag_id,added_by,created_at)
             VALUES(?1,?2,?3,?4)",
            rusqlite::params![meeting_id, tag_id, added_by, now_millis()],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// All meeting↔tag pairs — cheap enough locally and lets the meeting list
/// render chips without a query per row.
pub fn list_meeting_tags(conn: &Connection) -> Result<Vec<MeetingTag>, String> {
    let mut stmt = conn
        .prepare("SELECT meeting_id,tag_id,added_by FROM meeting_tags")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MeetingTag {
                meeting_id: r.get(0)?,
                tag_id: r.get(1)?,
                added_by: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn list_automations(conn: &Connection) -> Result<Vec<Automation>, String> {
    let mut stmt = conn
        .prepare("SELECT tag_id,enabled,match_json,ai_classify_json,actions_json FROM automations")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Automation {
                tag_id: r.get(0)?,
                enabled: r.get::<_, i64>(1)? != 0,
                match_json: r.get(2)?,
                ai_classify_json: r.get(3)?,
                actions_json: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn upsert_automation(conn: &Connection, a: &Automation) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automations(tag_id,enabled,match_json,ai_classify_json,actions_json,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(tag_id) DO UPDATE SET
           enabled=?2, match_json=?3, ai_classify_json=?4, actions_json=?5, updated_at=?6",
        rusqlite::params![
            a.tag_id,
            a.enabled as i64,
            a.match_json,
            a.ai_classify_json,
            a.actions_json,
            now_millis(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_automation(conn: &Connection, tag_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM automations WHERE tag_id=?1", [tag_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Idempotency ledger insert. Returns false when the (meeting, tag, action)
/// row already exists — i.e. another engine (cloud or a previous run) got
/// there first and this action must be skipped, not treated as an error.
pub fn record_automation_run(conn: &Connection, run: &AutomationRun) -> Result<bool, String> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO automation_runs(meeting_id,tag_id,action,status,detail_json,ran_by,ran_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                run.meeting_id,
                run.tag_id,
                run.action,
                run.status,
                run.detail_json,
                run.ran_by,
                if run.ran_at > 0 { run.ran_at } else { now_millis() },
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Status flip for approvals: pending_approval → done / dismissed / failed.
pub fn update_automation_run_status(
    conn: &Connection,
    meeting_id: &str,
    tag_id: &str,
    action: &str,
    status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_runs SET status=?4 WHERE meeting_id=?1 AND tag_id=?2 AND action=?3",
        rusqlite::params![meeting_id, tag_id, action, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn has_automation_run(
    conn: &Connection,
    meeting_id: &str,
    tag_id: &str,
    action: &str,
) -> Result<bool, String> {
    conn.prepare(
        "SELECT 1 FROM automation_runs WHERE meeting_id=?1 AND tag_id=?2 AND action=?3",
    )
    .and_then(|mut s| s.exists(rusqlite::params![meeting_id, tag_id, action]))
    .map_err(|e| e.to_string())
}

/// Runs for one meeting, or the whole history (newest first) when None.
pub fn list_automation_runs(
    conn: &Connection,
    meeting_id: Option<&str>,
) -> Result<Vec<AutomationRun>, String> {
    let sql = match meeting_id {
        Some(_) => {
            "SELECT meeting_id,tag_id,action,status,detail_json,ran_by,ran_at
             FROM automation_runs WHERE meeting_id=?1 ORDER BY ran_at DESC"
        }
        None => {
            "SELECT meeting_id,tag_id,action,status,detail_json,ran_by,ran_at
             FROM automation_runs ORDER BY ran_at DESC LIMIT 500"
        }
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<AutomationRun> {
        Ok(AutomationRun {
            meeting_id: r.get(0)?,
            tag_id: r.get(1)?,
            action: r.get(2)?,
            status: r.get(3)?,
            detail_json: r.get(4)?,
            ran_by: r.get(5)?,
            ran_at: r.get(6)?,
        })
    };
    let rows = match meeting_id {
        Some(id) => stmt.query_map([id], map).map_err(|e| e.to_string())?,
        None => stmt.query_map([], map).map_err(|e| e.to_string())?,
    };
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// ---------- Reports (phase 20) ----------

/// A saved report definition. `scope_value` is nullable and interpreted by
/// `scope_type`: folder/project id, tag id, or a `{"from","to"}` JSON string
/// (ISO dates). `model` "" = follow the user's current model. `last_run_at`
/// (epoch millis) is null until the report has run at least once.
#[derive(Serialize, Deserialize, Clone)]
pub struct Report {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub scope_type: String,
    pub scope_value: Option<String>,
    pub cadence: String,
    pub model: String,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One generated report result (immutable once written).
#[derive(Serialize, Deserialize, Clone)]
pub struct ReportOutput {
    pub id: String,
    pub report_id: String,
    pub title: String,
    pub body_md: String,
    pub generated_at: i64,
    pub meeting_count: i64,
    pub scope_label: String,
}

/// A lightweight meeting row for report scope resolution: no transcript is
/// loaded, and the summary is capped, so assembling context over dozens of
/// meetings stays cheap (summaries only — never full transcripts, per the
/// privacy/cost design).
#[derive(Serialize, Clone)]
pub struct ReportMeetingRow {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub created_at: i64,
    pub summary: String,
}

pub fn list_reports(conn: &Connection) -> Result<Vec<Report>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,name,prompt,scope_type,scope_value,cadence,model,last_run_at,created_at,updated_at
             FROM reports ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Report {
                id: r.get(0)?,
                name: r.get(1)?,
                prompt: r.get(2)?,
                scope_type: r.get(3)?,
                scope_value: r.get(4)?,
                cadence: r.get(5)?,
                model: r.get(6)?,
                last_run_at: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Upsert a report definition (empty id → a new one is generated).
pub fn save_report(conn: &Connection, mut rep: Report) -> Result<Report, String> {
    let now = now_millis();
    if rep.id.is_empty() {
        rep.id = gen_id("rep");
        rep.created_at = now;
    }
    rep.updated_at = now;
    conn.execute(
        "INSERT INTO reports(id,name,prompt,scope_type,scope_value,cadence,model,last_run_at,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
           name=?2, prompt=?3, scope_type=?4, scope_value=?5, cadence=?6, model=?7, updated_at=?10",
        rusqlite::params![
            rep.id,
            rep.name,
            rep.prompt,
            rep.scope_type,
            rep.scope_value,
            rep.cadence,
            rep.model,
            rep.last_run_at,
            rep.created_at,
            rep.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(rep)
}

pub fn delete_report(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM report_outputs WHERE report_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM reports WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stamp a report's last_run_at (epoch millis). Called after a run — including
/// runs that produced no output (empty scope) so due-checks don't loop.
pub fn touch_report_last_run(conn: &Connection, id: &str, ran_at: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET last_run_at=?2 WHERE id=?1",
        rusqlite::params![id, ran_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_report_outputs(conn: &Connection, report_id: &str) -> Result<Vec<ReportOutput>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,report_id,title,body_md,generated_at,meeting_count,scope_label
             FROM report_outputs WHERE report_id=?1 ORDER BY generated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([report_id], |r| {
            Ok(ReportOutput {
                id: r.get(0)?,
                report_id: r.get(1)?,
                title: r.get(2)?,
                body_md: r.get(3)?,
                generated_at: r.get(4)?,
                meeting_count: r.get(5)?,
                scope_label: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Insert a generated result (empty id → a new one is generated).
pub fn insert_report_output(conn: &Connection, mut out: ReportOutput) -> Result<ReportOutput, String> {
    if out.id.is_empty() {
        out.id = gen_id("repout");
    }
    if out.generated_at == 0 {
        out.generated_at = now_millis();
    }
    conn.execute(
        "INSERT INTO report_outputs(id,report_id,title,body_md,generated_at,meeting_count,scope_label)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            out.id,
            out.report_id,
            out.title,
            out.body_md,
            out.generated_at,
            out.meeting_count,
            out.scope_label,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn delete_report_output(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM report_outputs WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// All meetings as lightweight rows (id, title, project_id, created_at, capped
/// summary) for report scope resolution. The frontend applies the scope filter
/// (folder / tag / date range) and the most-recent-N cap — mirroring where the
/// web engine filters, and keeping this a single cheap query with no transcript
/// loads. Summary is capped at 4000 chars here; the assembler trims further.
pub fn list_report_meetings(conn: &Connection) -> Result<Vec<ReportMeetingRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,title,project_id,created_at,substr(summary,1,4000)
             FROM meetings ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ReportMeetingRow {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                summary: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// ---------- Action items ----------

/// One extracted action item. `assignee_uid` is set when the extracted name
/// was matched to a cloud profile (enables shared boards later);
/// `meeting_title`/`project_id` are joined in for board cards, not columns.
#[derive(Serialize, Clone)]
pub struct ActionItem {
    pub id: String,
    pub meeting_id: String,
    pub title: String,
    pub assignee_name: Option<String>,
    pub assignee_uid: Option<String>,
    pub status: String,
    pub due: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub meeting_title: String,
    pub project_id: Option<String>,
}

/// Fresh extraction payload (ids/status/timestamps are assigned here).
#[derive(Deserialize)]
pub struct NewActionItem {
    pub title: String,
    pub assignee_name: Option<String>,
    pub assignee_uid: Option<String>,
    pub due: Option<String>,
}

/// The canonical lifecycle values. A task's `status` is otherwise free text —
/// it holds the current stage id, which may be a user-defined Kanban column
/// (see the frontend `TaskStage`). Only "suggested" is reserved for the
/// meeting's un-approved suggestions and must not become a board column.
const RESERVED_SUGGESTED: &str = "suggested";

const ACTION_ITEM_SELECT: &str =
    "SELECT a.id, a.meeting_id, a.title, a.assignee_name, a.assignee_uid, a.status, a.due,
            a.created_at, a.updated_at, COALESCE(m.title,''), m.project_id
     FROM action_items a LEFT JOIN meetings m ON m.id = a.meeting_id";

fn row_to_action_item(r: &rusqlite::Row) -> rusqlite::Result<ActionItem> {
    Ok(ActionItem {
        id: r.get(0)?,
        meeting_id: r.get(1)?,
        title: r.get(2)?,
        assignee_name: r.get(3)?,
        assignee_uid: r.get(4)?,
        status: r.get(5)?,
        due: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        meeting_title: r.get(9)?,
        project_id: r.get(10)?,
    })
}

/// `meeting_id = None` → every item (the kanban); `Some` → that meeting's.
pub fn list_action_items(
    conn: &Connection,
    meeting_id: Option<&str>,
) -> Result<Vec<ActionItem>, String> {
    let (sql, params): (String, Vec<&str>) = match meeting_id {
        Some(id) => (
            format!("{ACTION_ITEM_SELECT} WHERE a.meeting_id=?1 ORDER BY a.created_at"),
            vec![id],
        ),
        None => (format!("{ACTION_ITEM_SELECT} ORDER BY a.created_at"), vec![]),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), row_to_action_item)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Replace a meeting's *suggested* items with a fresh extraction. Items the
/// user already approved (or moved on the board) are never touched, so
/// re-generating is safe. Returns the meeting's full list.
pub fn replace_suggested_action_items(
    conn: &Connection,
    meeting_id: &str,
    items: Vec<NewActionItem>,
) -> Result<Vec<ActionItem>, String> {
    conn.execute(
        "DELETE FROM action_items WHERE meeting_id=?1 AND status='suggested'",
        [meeting_id],
    )
    .map_err(|e| e.to_string())?;
    let now = now_millis();
    for it in items {
        conn.execute(
            "INSERT INTO action_items(id,meeting_id,title,assignee_name,assignee_uid,status,due,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,'suggested',?6,?7,?7)",
            rusqlite::params![gen_id("act"), meeting_id, it.title.trim(), it.assignee_name, it.assignee_uid, it.due, now],
        )
        .map_err(|e| e.to_string())?;
    }
    list_action_items(conn, Some(meeting_id))
}

/// Insert ONE manually-created action item (not from AI extraction). Lands
/// with the given `status` (a stage id, e.g. "approved" to go straight to the
/// board). Returns the created row joined with its meeting title / project.
pub fn add_action_item(
    conn: &Connection,
    meeting_id: &str,
    title: &str,
    assignee_name: Option<&str>,
    assignee_uid: Option<&str>,
    due: Option<&str>,
    status: &str,
) -> Result<ActionItem, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("action item title is required".into());
    }
    // Same rule as update: a non-empty stage id, never the reserved "suggested"
    // (a manual task is a real to-do, not a suggestion awaiting approval).
    let status = status.trim();
    if status.is_empty() || status == RESERVED_SUGGESTED {
        return Err(format!("invalid action item status: {status}"));
    }
    let id = gen_id("act");
    let now = now_millis();
    conn.execute(
        "INSERT INTO action_items(id,meeting_id,title,assignee_name,assignee_uid,status,due,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",
        rusqlite::params![id, meeting_id, title, assignee_name, assignee_uid, status, due, now],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("{ACTION_ITEM_SELECT} WHERE a.id=?1"),
        [id.as_str()],
        row_to_action_item,
    )
    .map_err(|e| e.to_string())
}

/// Full-value update (the frontend always sends the complete row).
pub fn update_action_item(
    conn: &Connection,
    id: &str,
    title: &str,
    assignee_name: Option<&str>,
    assignee_uid: Option<&str>,
    due: Option<&str>,
    status: &str,
) -> Result<ActionItem, String> {
    // Status is free text (a stage id) so custom Kanban columns work; it just
    // has to be non-empty. "suggested" is allowed here so a still-suggested
    // item's title / assignee / due can be edited before it's approved — the
    // board query filters out `status = 'suggested'` and the cloud mirror skips
    // it, so an approved task can never be hidden through this path.
    let status = status.trim();
    if status.is_empty() {
        return Err("action item status is required".into());
    }
    conn.execute(
        "UPDATE action_items SET title=?2, assignee_name=?3, assignee_uid=?4, due=?5, status=?6, updated_at=?7 WHERE id=?1",
        rusqlite::params![id, title.trim(), assignee_name, assignee_uid, due, status, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("{ACTION_ITEM_SELECT} WHERE a.id=?1"),
        [id],
        row_to_action_item,
    )
    .map_err(|e| e.to_string())
}

pub fn delete_action_item(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM action_items WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_workflow_outputs(
    conn: &Connection,
    meeting_id: &str,
    workflow_id: &str,
) -> Result<Vec<WorkflowOutput>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT block_id,output,updated_at FROM meeting_workflow_outputs
             WHERE meeting_id=?1 AND workflow_id=?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([meeting_id, workflow_id], |r| {
            Ok(WorkflowOutput {
                block_id: r.get(0)?,
                output: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Persist one block's output and refresh the meeting's workflows.md.
pub fn set_workflow_output(
    conn: &Connection,
    meeting_id: &str,
    workflow_id: &str,
    block_id: &str,
    output: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meeting_workflow_outputs(meeting_id,workflow_id,block_id,output,updated_at)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(meeting_id,workflow_id,block_id) DO UPDATE SET output=?4, updated_at=?5",
        rusqlite::params![meeting_id, workflow_id, block_id, output, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    write_workflows_md(conn, meeting_id)
}

/// Regenerate `<meeting_dir>/workflows.md` with every block output this
/// meeting has, grouped by workflow. Kept as its own file so the main
/// transcript/summary/notes writers stay untouched.
fn write_workflows_md(conn: &Connection, meeting_id: &str) -> Result<(), String> {
    let dir: Option<String> = conn
        .query_row("SELECT dir_path FROM meetings WHERE id=?1", [meeting_id], |r| r.get(0))
        .unwrap_or(None);
    let Some(dir) = dir else { return Ok(()) }; // meeting not saved to disk yet

    let workflows = list_workflows(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT workflow_id,block_id,output FROM meeting_workflow_outputs
             WHERE meeting_id=?1 AND output != '' ORDER BY workflow_id, updated_at",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([meeting_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let path = Path::new(&dir).join("workflows.md");
    if rows.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let mut md = String::from("# Workflow outputs\n\n");
    for (wf_id, block_id, output) in &rows {
        let wf = workflows.iter().find(|w| &w.id == wf_id);
        let wf_name = wf.map(|w| w.name.as_str()).unwrap_or("Workflow");
        let block_name = wf
            .and_then(|w| w.blocks.iter().find(|b| &b.id == block_id))
            .map(|b| b.name.as_str())
            .unwrap_or("Block");
        md.push_str(&format!("## {wf_name} — {block_name}\n\n{output}\n\n"));
    }
    fs::write(&path, md).map_err(|e| e.to_string())
}

pub fn search_meetings(conn: &Connection, query: &str) -> Result<Vec<MeetingMeta>, String> {
    let like = format!("%{}%", query);
    let mut stmt = conn
        .prepare(
            "SELECT id,title,project_id,created_at,substr(summary,1,400),substr(transcript_json,1,4096),is_favorite FROM meetings
             WHERE title LIKE ?1 OR transcript_json LIKE ?1 OR summary LIKE ?1 OR notes LIKE ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([like], |r| {
            let summary_head: String = r.get(4)?;
            let transcript_head: String = r.get(5)?;
            Ok(MeetingMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                has_summary: !summary_head.trim().is_empty(),
                snippet: make_snippet(&summary_head, &transcript_head),
                is_favorite: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// ---------- File writing ----------

fn stamp(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

/// notes.md: the user's own notes verbatim, with an `## Enhanced (AI)` section
/// appended when A3 enhancement has been run. The user's notes always come
/// first and are never altered.
fn notes_markdown(m: &FullMeeting) -> String {
    let mut out = format!("# {} — Notes\n\n{}\n", m.title, m.notes);
    if !m.enhanced_notes.trim().is_empty() {
        out.push_str(&format!("\n## Enhanced (AI)\n\n{}\n", m.enhanced_notes));
    }
    out
}

/// Transcript Markdown with images interleaved at their anchored timestamp.
/// Images are referenced by relative path (link, not base64) to keep the text
/// corpus token-light and portable.
fn transcript_markdown(m: &FullMeeting) -> String {
    // (t_ms, ordering-key, rendered block). order: 0 = transcript line, 1 = image,
    // so an image anchored to the same timestamp appears just after the line.
    let mut items: Vec<(i64, u8, String)> = Vec::new();
    for seg in &m.segments {
        items.push((
            seg.t0_ms.max(0),
            0,
            format!("**[{}] {}:** {}\n\n", stamp(seg.t0_ms), seg.speaker, seg.text),
        ));
    }
    for img in &m.images {
        let caption = if img.caption.trim().is_empty() {
            "Screen capture".to_string()
        } else {
            img.caption.clone()
        };
        items.push((
            img.t_ms.max(0),
            1,
            format!("![{}]({})\n\n*{} · [{}]*\n\n", caption, img.rel_path, caption, stamp(img.t_ms)),
        ));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut s = format!("# {}\n\n", m.title);
    for (_, _, block) in items {
        s.push_str(&block);
    }
    s
}

/// Deterministic folder for a meeting: <root>/<Project>/<created_at> <title>.
fn meeting_dir(conn: &Connection, m: &FullMeeting, save_root: &Path) -> PathBuf {
    let proj = sanitize(&project_name(conn, &m.project_id));
    let folder_name = format!("{} {}", m.created_at, sanitize(&m.title));
    save_root.join(proj).join(folder_name)
}

/// Write summary.md / transcript.md / notes.md into <root>/<Project>/<date title>/.
fn write_files(conn: &Connection, m: &FullMeeting, save_root: &Path) -> Result<PathBuf, String> {
    // Every meeting write flows through here — keep the retrieval index warm.
    let _ = refresh_meeting_fts(conn, m);
    let dir = meeting_dir(conn, m, save_root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    fs::write(dir.join("transcript.md"), transcript_markdown(m)).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("summary.md"),
        if m.summary.trim().is_empty() {
            format!("# {}\n\n_No summary generated yet._\n", m.title)
        } else {
            format!("# {}\n\n{}\n", m.title, m.summary)
        },
    )
    .map_err(|e| e.to_string())?;
    fs::write(dir.join("notes.md"), notes_markdown(m)).map_err(|e| e.to_string())?;

    Ok(dir)
}

// ---------- Document export (DOCX / PDF) ----------
//
// Both formats render the same thing: title, Summary, Notes, then the
// transcript with the meeting's captured frames interleaved at their
// timestamps. They share the assembly (`export_body`), the image decode
// (`load_capture`) and the fit-to-page arithmetic (`fit_within`); only the
// emitting differs.

/// One element of an export body, in reading order.
#[cfg(desktop)]
enum BodyItem<'a> {
    Line(String),
    Image(&'a MeetingImage),
}

/// Transcript lines and captured frames merged into one timestamp-ordered
/// stream. On a tie the transcript line comes first, so a frame always lands
/// under the words that were being spoken when it was grabbed.
#[cfg(desktop)]
fn export_body(m: &FullMeeting) -> Vec<BodyItem<'_>> {
    let mut items: Vec<(i64, u8, BodyItem)> = Vec::new();
    for seg in &m.segments {
        let line = format!("[{}] {}: {}", stamp(seg.t0_ms), seg.speaker, seg.text);
        items.push((seg.t0_ms.max(0), 0, BodyItem::Line(line)));
    }
    for img in &m.images {
        items.push((img.t_ms.max(0), 1, BodyItem::Image(img)));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    items.into_iter().map(|(_, _, item)| item).collect()
}

/// The caption printed under a frame.
#[cfg(desktop)]
fn image_caption(img: &MeetingImage) -> String {
    let caption = if img.caption.trim().is_empty() {
        "Screen capture"
    } else {
        img.caption.trim()
    };
    format!("{caption} [{}]", stamp(img.t_ms))
}

/// Decode one captured frame from the meeting folder.
///
/// Auto-captures are saved as lossy WebP (`image_proc::to_webp`), but the
/// `image` crate here is built WITHOUT WebP support — so fall back to libwebp,
/// which is already linked for the encode side. Older meetings hold PNG/JPEG
/// and take the first branch.
///
/// Returns None for anything missing or undecodable: one bad frame must never
/// cost the user the whole export. It used to cost them the whole *app* —
/// `docx_rs::Pic::new` unwraps this decode internally, so the first WebP frame
/// panicked and aborted the process (macOS crash report: SIGABRT in
/// `Pic::new` ← `export_docx`).
#[cfg(desktop)]
fn load_capture(base: Option<&Path>, img: &MeetingImage) -> Option<image::DynamicImage> {
    let bytes = fs::read(base?.join(&img.rel_path)).ok()?;
    image::load_from_memory(&bytes)
        .ok()
        .or_else(|| webp::Decoder::new(&bytes).decode().map(|d| d.to_image()))
}

/// Scale `w`×`h` down to fit inside `max_w`×`max_h`, preserving aspect ratio.
/// Never scales up, never returns a zero edge.
#[cfg(desktop)]
fn fit_within(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (max_w, max_h);
    }
    let scale = (max_w as f64 / w as f64)
        .min(max_h as f64 / h as f64)
        .min(1.0);
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

/// docx-rs defaults to A4 (11906 twips wide) with 1701-twip side margins, so a
/// paragraph has 8504 twips ≈ 5.9" of text width. `Pic` declares its size in px
/// at 96 DPI (`from_px` = px × 9525 EMU), which caps an inline image at
/// 8504/1440 × 96 ≈ 567 px. Passing the source resolution straight through —
/// what `Pic::new` does — declared a 1280 px frame as 13.3" wide, which is why
/// captures ran off the right-hand edge of the page.
#[cfg(desktop)]
const DOCX_MAX_IMG_W_PX: u32 = 560;

/// Leave room under a full-width frame for its caption.
#[cfg(desktop)]
const DOCX_MAX_IMG_H_PX: u32 = 660;

/// Frames are re-encoded at ~144 DPI of their printed size — crisp in print and
/// when zoomed, without carrying the full 1600 px original into every export.
///
/// This is the main lever on DOCX size, because `encode_png` has no choice but
/// PNG and PNG is a poor fit for photographic frames: the 70-frame video import
/// this was fixed against weighs 48 MB at 192 DPI and 28 MB at 144. Exporting
/// the same meeting as PDF, where JPEG streams are allowed, gives 8 MB.
#[cfg(desktop)]
const DOCX_IMG_DPI: f32 = 144.0;

/// `Pic` display sizes are px at 96 DPI (see [`DOCX_MAX_IMG_W_PX`]).
#[cfg(desktop)]
const DOCX_DISPLAY_DPI: f32 = 96.0;

/// Re-encode a frame as PNG, downscaled to fit `max_w`×`max_h`. PNG because
/// docx-rs hardcodes `media/<id>.png` and an `image/png` content type for every
/// picture part — JPEG bytes under a .png name are not a conformant DOCX.
#[cfg(desktop)]
fn encode_png(img: &image::DynamicImage, max_w: u32, max_h: u32) -> Option<Vec<u8>> {
    use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    let scaled = if img.width() > max_w || img.height() > max_h {
        img.resize(max_w, max_h, image::imageops::FilterType::CatmullRom)
    } else {
        img.clone()
    };
    let rgb = scaled.to_rgb8();
    let mut buf = Vec::new();
    // `Default` rather than `Best`: a 70-frame export runs the encoder 70 times
    // and Best buys ~5% for several seconds of extra work.
    PngEncoder::new_with_quality(&mut buf, CompressionType::Default, PngFilter::Adaptive)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(buf)
}

#[cfg(desktop)]
pub fn export_docx(m: &FullMeeting, out_path: &Path) -> Result<(), String> {
    use docx_rs::*;

    let mut docx = Docx::new()
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(&m.title).bold().size(36)),
        )
        .add_paragraph(Paragraph::new());

    if !m.summary.trim().is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new().add_run(Run::new().add_text("Summary").bold().size(28)),
        );
        for line in m.summary.lines() {
            docx = docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(line)));
        }
        docx = docx.add_paragraph(Paragraph::new());
    }

    if !m.notes.trim().is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new().add_run(Run::new().add_text("Notes").bold().size(28)),
        );
        for line in m.notes.lines() {
            docx = docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(line)));
        }
        docx = docx.add_paragraph(Paragraph::new());
    }

    docx = docx.add_paragraph(
        Paragraph::new().add_run(Run::new().add_text("Transcript").bold().size(28)),
    );

    let base = m.dir_path.as_ref().map(PathBuf::from);
    for item in export_body(m) {
        match item {
            BodyItem::Line(line) => {
                docx = docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(&line)));
            }
            BodyItem::Image(img) => {
                if let Some(src) = load_capture(base.as_deref(), img) {
                    let (w, h) = fit_within(
                        src.width(),
                        src.height(),
                        DOCX_MAX_IMG_W_PX,
                        DOCX_MAX_IMG_H_PX,
                    );
                    // `new_with_dimensions` takes the DISPLAY size in px; the
                    // buffer stays higher-resolution and Word scales it down.
                    let oversample = DOCX_IMG_DPI / DOCX_DISPLAY_DPI;
                    let px = |n: u32| ((n as f32 * oversample).round() as u32).max(1);
                    if let Some(png) = encode_png(&src, px(w), px(h)) {
                        docx = docx.add_paragraph(
                            Paragraph::new()
                                .add_run(Run::new().add_image(Pic::new_with_dimensions(png, w, h))),
                        );
                    }
                }
                docx = docx.add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(image_caption(img)).italic().size(18),
                    ),
                );
            }
        }
    }

    let file = fs::File::create(out_path).map_err(|e| e.to_string())?;
    docx.build().pack(file).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- PDF export ----------

/// Adobe's standard advance widths for Helvetica, ASCII 0x20–0x7E, in 1/1000
/// em. The 14 built-in PDF fonts carry no metrics in the file — the viewer
/// supplies them — so a writer that wants to wrap text has to keep its own copy.
#[cfg(desktop)]
const HELVETICA_W: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// The same table for Helvetica-Bold (headings).
#[cfg(desktop)]
const HELVETICA_BOLD_W: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/// Width of `text` set in Helvetica at `size` pt.
///
/// Built-in fonts are WinAnsi-encoded, so anything outside ASCII (curly quotes,
/// em dashes, accented letters) still renders — it just gets the average
/// advance here instead of its exact one. `PDF_WRAP_SAFETY` absorbs the error.
#[cfg(desktop)]
fn text_width_pt(text: &str, size: f32, bold: bool) -> f32 {
    let table = if bold { &HELVETICA_BOLD_W } else { &HELVETICA_W };
    let mils: u32 = text
        .chars()
        .map(|c| {
            let i = c as u32;
            if (0x20..0x7f).contains(&i) {
                table[(i - 0x20) as usize] as u32
            } else {
                556
            }
        })
        .sum();
    mils as f32 * size / 1000.0
}

/// Wrap to 98% of the measured column so an approximated non-ASCII advance can
/// never push a line past the margin.
#[cfg(desktop)]
const PDF_WRAP_SAFETY: f32 = 0.98;

/// Greedy word wrap. A word too long for a whole line (a URL, a run-on token)
/// is hard-split rather than allowed to overflow the margin.
#[cfg(desktop)]
fn wrap_text(text: &str, size: f32, bold: bool, max_w: f32) -> Vec<String> {
    let limit = max_w * PDF_WRAP_SAFETY;
    let mut out = Vec::new();
    let mut line = String::new();

    let flush = |line: &mut String, out: &mut Vec<String>| {
        if !line.is_empty() {
            out.push(std::mem::take(line));
        }
    };

    for word in text.split_whitespace() {
        let candidate = if line.is_empty() {
            word.to_string()
        } else {
            format!("{line} {word}")
        };
        if text_width_pt(&candidate, size, bold) <= limit {
            line = candidate;
            continue;
        }
        flush(&mut line, &mut out);
        // The word alone still may not fit — break it character by character.
        let mut chunk = String::new();
        for ch in word.chars() {
            let mut next = chunk.clone();
            next.push(ch);
            if !chunk.is_empty() && text_width_pt(&next, size, bold) > limit {
                out.push(std::mem::take(&mut chunk));
            }
            chunk.push(ch);
        }
        line = chunk;
    }
    flush(&mut line, &mut out);
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// A4 portrait, 20 mm margins — the same geometry the DOCX export inherits from
/// docx-rs, so the two files paginate comparably.
#[cfg(desktop)]
const PDF_PAGE_W_MM: f32 = 210.0;
#[cfg(desktop)]
const PDF_PAGE_H_MM: f32 = 297.0;
#[cfg(desktop)]
const PDF_MARGIN_MM: f32 = 20.0;
#[cfg(desktop)]
const PDF_BODY_PT: f32 = 10.0;
#[cfg(desktop)]
const PDF_LINE_PT: f32 = 13.5;

/// Frames are resampled to ~150 DPI of their printed size before embedding:
/// enough for a screenshot to stay legible on paper, far less than the 1600 px
/// original.
#[cfg(desktop)]
const PDF_IMG_DPI: f32 = 150.0;

/// A single-column page builder: a cursor that walks down the content box and
/// starts a new page when the next block will not fit.
#[cfg(desktop)]
struct PdfBuilder {
    doc: printpdf::PdfDocument,
    pages: Vec<printpdf::PdfPage>,
    ops: Vec<printpdf::Op>,
    /// Points consumed from the top of the content box on the current page.
    y: f32,
    content_w: f32,
    content_h: f32,
    margin: f32,
    page_h: f32,
}

#[cfg(desktop)]
impl PdfBuilder {
    fn new(title: &str) -> Self {
        use printpdf::{Mm, PdfDocument};
        let margin = Mm(PDF_MARGIN_MM).into_pt().0;
        let page_w = Mm(PDF_PAGE_W_MM).into_pt().0;
        let page_h = Mm(PDF_PAGE_H_MM).into_pt().0;
        Self {
            doc: PdfDocument::new(title),
            pages: Vec::new(),
            ops: Vec::new(),
            y: 0.0,
            content_w: page_w - margin * 2.0,
            content_h: page_h - margin * 2.0,
            margin,
            page_h,
        }
    }

    /// Close the current page and start a fresh one.
    fn new_page(&mut self) {
        use printpdf::{Mm, PdfPage};
        self.pages.push(PdfPage::new(
            Mm(PDF_PAGE_W_MM),
            Mm(PDF_PAGE_H_MM),
            std::mem::take(&mut self.ops),
        ));
        self.y = 0.0;
    }

    /// Break the page if `height` pt will not fit in what is left of this one.
    /// A block taller than a whole page still gets its own page (and is then
    /// scaled to fit by the caller).
    fn ensure(&mut self, height: f32) {
        if self.y > 0.0 && self.y + height > self.content_h {
            self.new_page();
        }
    }

    /// Vertical whitespace — collapsed at the top of a page.
    fn gap(&mut self, height: f32) {
        if self.y > 0.0 {
            self.y += height;
        }
    }

    /// Draw `text`, wrapped to the column, breaking pages as needed.
    fn text(&mut self, text: &str, size: f32, bold: bool) {
        use printpdf::{BuiltinFont, Op, PdfFontHandle, Point, Pt, TextItem};
        let font = if bold {
            BuiltinFont::HelveticaBold
        } else {
            BuiltinFont::Helvetica
        };
        let leading = (size * 1.35).max(PDF_LINE_PT * size / PDF_BODY_PT);
        for line in wrap_text(text, size, bold, self.content_w) {
            self.ensure(leading);
            // PDF origin is bottom-left; `y` counts down from the content top.
            let baseline = self.page_h - self.margin - self.y - size;
            self.ops.extend([
                Op::StartTextSection,
                Op::SetFont {
                    font: PdfFontHandle::Builtin(font),
                    size: Pt(size),
                },
                Op::SetTextCursor {
                    // `Point::new` takes Mm; the fields themselves are Pt.
                    pos: Point {
                        x: Pt(self.margin),
                        y: Pt(baseline),
                    },
                },
                Op::ShowText {
                    items: vec![TextItem::Text(line)],
                },
                Op::EndTextSection,
            ]);
            self.y += leading;
        }
    }

    /// Place a captured frame, scaled to fit the column (and, if it is a tall
    /// one, the page).
    fn image(&mut self, img: &image::DynamicImage) {
        use printpdf::{
            Op, Pt, RawImage, RawImageData, RawImageFormat, XObjectTransform,
        };

        // Printed size first: fit the column, and leave a couple of lines of a
        // page for the caption that follows.
        let max_h = self.content_h - PDF_LINE_PT * 2.0;
        let (disp_w, disp_h) = {
            let (w, h) = (img.width() as f32, img.height() as f32);
            let scale = (self.content_w / w).min(max_h / h).min(1.0);
            (w * scale, h * scale)
        };

        // Then resample to ~150 DPI of that printed size (72 pt = 1 inch).
        let target_px = (disp_w / 72.0 * PDF_IMG_DPI).round().max(1.0) as u32;
        let resampled = if img.width() > target_px {
            img.resize(
                target_px,
                u32::MAX,
                image::imageops::FilterType::CatmullRom,
            )
        } else {
            img.clone()
        };
        let rgb = resampled.to_rgb8();
        let (px_w, px_h) = (rgb.width() as usize, rgb.height() as usize);
        if px_w == 0 || px_h == 0 {
            return;
        }

        let id = self.doc.add_image(&RawImage {
            pixels: RawImageData::U8(rgb.into_raw()),
            width: px_w,
            height: px_h,
            data_format: RawImageFormat::RGB8,
            tag: Vec::new(),
        });

        self.ensure(disp_h);
        // `dpi: 72` makes one source pixel one point, so `scale` maps the
        // resampled bitmap onto the printed size computed above.
        let scale = disp_w / px_w as f32;
        let bottom = self.page_h - self.margin - self.y - disp_h;
        self.ops.push(Op::UseXobject {
            id,
            transform: XObjectTransform {
                translate_x: Some(Pt(self.margin)),
                translate_y: Some(Pt(bottom)),
                scale_x: Some(scale),
                scale_y: Some(scale),
                dpi: Some(72.0),
                ..Default::default()
            },
        });
        self.y += disp_h;
    }

    fn save(mut self, out_path: &Path) -> Result<(), String> {
        use printpdf::{
            ImageCompression, ImageOptimizationOptions, PdfSaveOptions,
        };
        self.new_page();
        let opts = PdfSaveOptions {
            // DCTDecode (JPEG) streams rather than the default Flate: on a
            // 70-frame export that is 6 MB instead of 54 MB, with no visible
            // difference on a screenshot.
            image_optimization: Some(ImageOptimizationOptions {
                format: Some(ImageCompression::Jpeg),
                quality: Some(0.8),
                max_image_size: None,
                auto_optimize: Some(true),
                convert_to_greyscale: Some(false),
                dither_greyscale: None,
            }),
            ..Default::default()
        };
        let pages = std::mem::take(&mut self.pages);
        let bytes = self
            .doc
            .with_pages(pages)
            .save(&opts, &mut Vec::new());
        fs::write(out_path, bytes).map_err(|e| e.to_string())
    }
}

/// Export a meeting to PDF — same content as [`export_docx`], laid out here
/// rather than by Word.
#[cfg(desktop)]
pub fn export_pdf(m: &FullMeeting, out_path: &Path) -> Result<(), String> {
    let mut pdf = PdfBuilder::new(&m.title);

    pdf.text(&m.title, 18.0, true);
    pdf.gap(PDF_LINE_PT);

    for (heading, body) in [("Summary", &m.summary), ("Notes", &m.notes)] {
        if body.trim().is_empty() {
            continue;
        }
        pdf.gap(PDF_LINE_PT);
        pdf.text(heading, 14.0, true);
        for line in body.lines() {
            pdf.text(line, PDF_BODY_PT, false);
        }
    }

    pdf.gap(PDF_LINE_PT);
    pdf.text("Transcript", 14.0, true);

    let base = m.dir_path.as_ref().map(PathBuf::from);
    for item in export_body(m) {
        match item {
            BodyItem::Line(line) => pdf.text(&line, PDF_BODY_PT, false),
            BodyItem::Image(img) => {
                if let Some(src) = load_capture(base.as_deref(), img) {
                    pdf.gap(PDF_LINE_PT * 0.5);
                    pdf.image(&src);
                }
                pdf.text(&image_caption(img), 8.0, false);
                pdf.gap(PDF_LINE_PT * 0.5);
            }
        }
    }

    pdf.save(out_path)
}

// ---------- Chat threads (persisted chat history) ----------

#[derive(Serialize, Clone)]
pub struct ChatThreadRow {
    pub id: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
pub struct ChatMessageRow {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

/// Threads for one chat surface, most recently used first. `scope_id IS ?2`
/// matches NULL for the global scope.
pub fn list_chat_threads(
    conn: &Connection,
    scope: &str,
    scope_id: Option<&str>,
) -> Result<Vec<ChatThreadRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,scope,scope_id,title,created_at,updated_at FROM chat_threads
             WHERE scope=?1 AND scope_id IS ?2 ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![scope, scope_id], |r| {
            Ok(ChatThreadRow {
                id: r.get(0)?,
                scope: r.get(1)?,
                scope_id: r.get(2)?,
                title: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn create_chat_thread(
    conn: &Connection,
    scope: &str,
    scope_id: Option<&str>,
    title: &str,
) -> Result<ChatThreadRow, String> {
    let id = gen_id("cht");
    let now = now_millis();
    conn.execute(
        "INSERT INTO chat_threads(id,scope,scope_id,title,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?5)",
        rusqlite::params![id, scope, scope_id, title, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(ChatThreadRow {
        id,
        scope: scope.to_string(),
        scope_id: scope_id.map(str::to_string),
        title: title.to_string(),
        created_at: now,
        updated_at: now,
    })
}

pub fn list_chat_messages(
    conn: &Connection,
    thread_id: &str,
) -> Result<Vec<ChatMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,thread_id,role,content,created_at FROM chat_messages
             WHERE thread_id=?1 ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([thread_id], |r| {
            Ok(ChatMessageRow {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Append one message and bump the thread's recency.
pub fn append_chat_message(
    conn: &Connection,
    thread_id: &str,
    role: &str,
    content: &str,
) -> Result<ChatMessageRow, String> {
    let id = gen_id("chm");
    let now = now_millis();
    conn.execute(
        "INSERT INTO chat_messages(id,thread_id,role,content,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![id, thread_id, role, content, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE chat_threads SET updated_at=?1 WHERE id=?2",
        rusqlite::params![now, thread_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(ChatMessageRow {
        id,
        thread_id: thread_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        created_at: now,
    })
}

pub fn rename_chat_thread(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_threads SET title=?1 WHERE id=?2",
        rusqlite::params![title, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_chat_thread(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM chat_messages WHERE thread_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chat_threads WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Speaker identity (Intelligence Layer, Slice 1) ----------
// Voiceprints are biometric: local SQLite only, never mirrored to the cloud.
// Enrolment has ONE source — the user's explicit "this is X" confirmation
// (enroll_speaker_from_meeting). Auto-matching only READS voiceprints.

use crate::speakers::{self, Speaker};

/// A diarized cluster carried from stop_recording to save_meeting: its final
/// transcript label, the matched speaker (if any) and the voice embedding so
/// a later manual "this is X" can still enrol it.
#[derive(Clone)]
pub struct PendingObservation {
    pub label: String,
    pub speaker_id: Option<String>,
    pub embedding: Vec<f32>,
    pub confidence: f32,
}

fn speaker_from_row(r: &rusqlite::Row) -> rusqlite::Result<Speaker> {
    let aliases_json: String = r.get(2)?;
    let voiceprint: Option<Vec<u8>> = r.get(4)?;
    Ok(Speaker {
        id: r.get(0)?,
        name: r.get(1)?,
        aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
        role: r.get(3)?,
        has_voiceprint: voiceprint.map_or(false, |v| !v.is_empty()),
        meeting_count: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

pub fn list_speakers(conn: &Connection) -> Result<Vec<Speaker>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.name, s.aliases_json, s.role, s.voiceprint,
                    (SELECT COUNT(DISTINCT o.meeting_id) FROM speaker_observations o
                      WHERE o.speaker_id = s.id),
                    s.created_at, s.updated_at
               FROM speakers s ORDER BY s.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| speaker_from_row(r)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Enrolled voiceprints for matching: (id, name, embedding).
pub fn speakers_with_voiceprints(conn: &Connection) -> Result<Vec<(String, String, Vec<f32>)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, voiceprint FROM speakers WHERE voiceprint IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let blob: Vec<u8> = r.get(2)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, speakers::blob_to_embedding(&blob)))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// All names + aliases, fed into transcription biasing (Slice 0).
pub fn speaker_bias_names(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT name, aliases_json FROM speakers") else {
        return vec![];
    };
    let mut out: Vec<String> = Vec::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            out.push(row.0);
            if let Ok(aliases) = serde_json::from_str::<Vec<String>>(&row.1) {
                out.extend(aliases);
            }
        }
    }
    out
}

/// Find a speaker by exact name or alias (case-insensitive), else create one.
pub fn get_or_create_speaker(conn: &Connection, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("speaker name is empty".into());
    }
    let mut stmt = conn
        .prepare("SELECT id, name, aliases_json FROM speakers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows.flatten() {
        let aliases: Vec<String> = serde_json::from_str(&row.2).unwrap_or_default();
        if row.1.eq_ignore_ascii_case(name)
            || aliases.iter().any(|a| a.eq_ignore_ascii_case(name))
        {
            return Ok(row.0);
        }
    }
    let id = gen_id("spk");
    let now = now_millis();
    conn.execute(
        "INSERT INTO speakers(id, name, aliases_json, source, created_at, updated_at)
         VALUES(?1, ?2, '[]', 'manual', ?3, ?3)",
        rusqlite::params![id, name, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Rename; the old name is kept as an alias so imports/matches still resolve.
pub fn rename_speaker(conn: &Connection, id: &str, new_name: &str) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("speaker name is empty".into());
    }
    let (old_name, aliases_json): (String, String) = conn
        .query_row("SELECT name, aliases_json FROM speakers WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
    if !old_name.eq_ignore_ascii_case(new_name)
        && !aliases.iter().any(|a| a.eq_ignore_ascii_case(&old_name))
    {
        aliases.push(old_name);
    }
    aliases.retain(|a| !a.eq_ignore_ascii_case(new_name));
    conn.execute(
        "UPDATE speakers SET name=?2, aliases_json=?3, updated_at=?4 WHERE id=?1",
        rusqlite::params![id, new_name, serde_json::to_string(&aliases).unwrap_or_default(), now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_speaker(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE speaker_observations SET speaker_id=NULL WHERE speaker_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM speakers WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Merge `merged_id` into `keep_id`: union aliases (+ merged name), average
/// voiceprints when both exist, repoint observations, delete the duplicate.
pub fn merge_speakers(conn: &Connection, keep_id: &str, merged_id: &str) -> Result<(), String> {
    if keep_id == merged_id {
        return Err("cannot merge a speaker into itself".into());
    }
    let get = |id: &str| -> Result<(String, String, Option<Vec<u8>>), String> {
        conn.query_row(
            "SELECT name, aliases_json, voiceprint FROM speakers WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())
    };
    let (keep_name, keep_aliases, keep_vp) = get(keep_id)?;
    let (merged_name, merged_aliases, merged_vp) = get(merged_id)?;

    let mut aliases: Vec<String> = serde_json::from_str(&keep_aliases).unwrap_or_default();
    let mut extra: Vec<String> = serde_json::from_str(&merged_aliases).unwrap_or_default();
    extra.push(merged_name);
    for a in extra {
        if !a.eq_ignore_ascii_case(&keep_name)
            && !aliases.iter().any(|x| x.eq_ignore_ascii_case(&a))
        {
            aliases.push(a);
        }
    }
    let vp: Option<Vec<u8>> = match (keep_vp, merged_vp) {
        (Some(a), Some(b)) => Some(speakers::embedding_to_blob(&speakers::merge_voiceprint(
            &speakers::blob_to_embedding(&a),
            &speakers::blob_to_embedding(&b),
        ))),
        (a, b) => a.or(b),
    };
    conn.execute(
        "UPDATE speakers SET aliases_json=?2, voiceprint=?3, updated_at=?4 WHERE id=?1",
        rusqlite::params![keep_id, serde_json::to_string(&aliases).unwrap_or_default(), vp, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE speaker_observations SET speaker_id=?2 WHERE speaker_id=?1",
        rusqlite::params![merged_id, keep_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM speakers WHERE id=?1", [merged_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the clusters observed in a just-saved meeting.
pub fn record_observations(
    conn: &Connection,
    meeting_id: &str,
    observations: &[PendingObservation],
) -> Result<(), String> {
    let now = now_millis();
    for o in observations {
        conn.execute(
            "INSERT INTO speaker_observations(id, speaker_id, meeting_id, cluster_label, embedding, confidence, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                gen_id("obs"),
                o.speaker_id,
                meeting_id,
                o.label,
                speakers::embedding_to_blob(&o.embedding),
                o.confidence,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// THE write-back loop (IL-2 approval point): the user confirmed that
/// `cluster_label` in `meeting_id` is speaker `speaker_id`. Links the
/// observation and folds its embedding into the speaker's voiceprint
/// (creates it on first confirmation). This is the ONLY place voiceprints
/// are written.
pub fn enroll_speaker_from_meeting(
    conn: &Connection,
    meeting_id: &str,
    cluster_label: &str,
    speaker_id: &str,
) -> Result<bool, String> {
    let obs: Option<(String, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT id, embedding FROM speaker_observations
              WHERE meeting_id=?1 AND cluster_label=?2 ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![meeting_id, cluster_label],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((obs_id, embedding_blob)) = obs else {
        return Ok(false); // no observation (voiceprints off / pre-Slice-1 meeting)
    };
    conn.execute(
        "UPDATE speaker_observations SET speaker_id=?2 WHERE id=?1",
        rusqlite::params![obs_id, speaker_id],
    )
    .map_err(|e| e.to_string())?;
    let Some(blob) = embedding_blob.filter(|b| !b.is_empty()) else {
        return Ok(false);
    };
    let observed = speakers::blob_to_embedding(&blob);
    let current: Option<Vec<u8>> = conn
        .query_row("SELECT voiceprint FROM speakers WHERE id=?1", [speaker_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let updated = match current.filter(|b| !b.is_empty()) {
        Some(vp) => speakers::merge_voiceprint(&speakers::blob_to_embedding(&vp), &observed),
        None => observed,
    };
    conn.execute(
        "UPDATE speakers SET voiceprint=?2, updated_at=?3 WHERE id=?1",
        rusqlite::params![speaker_id, speakers::embedding_to_blob(&updated), now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Relabel every segment with speaker `from` to `to` in a saved meeting,
/// rewrite its Markdown, and keep observations pointing at the new label.
pub fn relabel_meeting_speaker(
    conn: &Connection,
    meeting_id: &str,
    from: &str,
    to: &str,
    save_root: &Path,
) -> Result<FullMeeting, String> {
    let mut meeting = get_meeting(conn, meeting_id)?;
    for seg in meeting.segments.iter_mut() {
        if seg.speaker == from {
            seg.speaker = to.to_string();
        }
    }
    let transcript_json = serde_json::to_string(&meeting.segments).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE meetings SET transcript_json=?2 WHERE id=?1",
        rusqlite::params![meeting_id, transcript_json],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE speaker_observations SET cluster_label=?3 WHERE meeting_id=?1 AND cluster_label=?2",
        rusqlite::params![meeting_id, from, to],
    )
    .map_err(|e| e.to_string())?;
    let meeting = get_meeting(conn, meeting_id)?;
    write_files(conn, &meeting, save_root)?;
    get_meeting(conn, meeting_id)
}

// ---------- Import provenance (Intelligence Layer, Slice 2) ----------

/// Provenance for an imported meeting, shown as a trust badge in the UI.
/// The media_* fields are set for audio imports only (Slice 7).
#[derive(Debug, Clone, Serialize)]
pub struct ImportSource {
    pub id: String,
    pub meeting_id: String,
    pub kind: String,
    pub format: String,
    pub original_filename: String,
    pub trust_level: String,
    pub media_duration_ms: Option<i64>,
    pub decoded_sample_rate: Option<i64>,
    pub imported_at: i64,
}

pub fn record_import_source(
    conn: &Connection,
    meeting_id: &str,
    kind: &str,
    format: &str,
    original_filename: &str,
    trust_level: &str,
    media_duration_ms: Option<i64>,
    decoded_sample_rate: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO import_sources(id, meeting_id, kind, format, original_filename, trust_level, media_duration_ms, decoded_sample_rate, imported_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            gen_id("imp"),
            meeting_id,
            kind,
            format,
            original_filename,
            trust_level,
            media_duration_ms,
            decoded_sample_rate,
            now_millis()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every original filename ever recorded for an import — the bulk folder
/// import uses this to flag files that were already brought in.
pub fn list_import_filenames(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT original_filename FROM import_sources")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_import_source(conn: &Connection, meeting_id: &str) -> Option<ImportSource> {
    conn.query_row(
        "SELECT id, meeting_id, kind, format, original_filename, trust_level, media_duration_ms, decoded_sample_rate, imported_at
           FROM import_sources WHERE meeting_id=?1 ORDER BY imported_at DESC LIMIT 1",
        [meeting_id],
        |r| {
            Ok(ImportSource {
                id: r.get(0)?,
                meeting_id: r.get(1)?,
                kind: r.get(2)?,
                format: r.get(3)?,
                original_filename: r.get(4)?,
                trust_level: r.get(5)?,
                media_duration_ms: r.get(6)?,
                decoded_sample_rate: r.get(7)?,
                imported_at: r.get(8)?,
            })
        },
    )
    .ok()
}

/// Entity resolution for imported speaker labels (Slice 2): a parsed name
/// that matches a directory entry (name OR alias, case-insensitive) is
/// normalised to the canonical name. Unknown names pass through untouched —
/// imports never create directory entries and NEVER enrol voiceprints
/// (no audio exists).
pub fn canonicalize_speaker_name(conn: &Connection, name: &str) -> String {
    let Ok(mut stmt) = conn.prepare("SELECT name, aliases_json FROM speakers") else {
        return name.to_string();
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    if let Ok(rows) = rows {
        for (canonical, aliases_json) in rows.flatten() {
            if canonical.eq_ignore_ascii_case(name) {
                return canonical;
            }
            let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
            if aliases.iter().any(|a| a.eq_ignore_ascii_case(name)) {
                return canonical;
            }
        }
    }
    name.to_string()
}

// ---------- Knowledge layer (Intelligence Layer, Slice 3) ----------
// Rolling project briefs, the LLM-compiled wiki (Markdown files + provenance
// rows), and local full-text retrieval. Everything on-device; the only
// network use is the LLM call the FRONTEND makes to compile briefs/pages.

/// One retrieval hit: a meeting whose transcript/summary matches the query.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptHit {
    pub meeting_id: String,
    pub title: String,
    pub snippet: String,
    pub created_at: i64,
}

/// FTS5-backed retrieval with a metadata pre-filter (project scope). The
/// free-text query is sanitised into quoted OR-terms so user questions can't
/// break FTS syntax.
pub fn search_transcripts(
    conn: &Connection,
    query: &str,
    project_id: Option<&str>,
    limit: usize,
) -> Result<Vec<TranscriptHit>, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| w.len() >= 2)
        .take(12)
        .map(|w| format!("\"{w}\""))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let fts_query = terms.join(" OR ");
    let sql = format!(
        "SELECT f.meeting_id, m.title, snippet(meeting_fts, 2, '**', '**', ' … ', 12), m.created_at
           FROM meeting_fts f
           JOIN meetings m ON m.id = f.meeting_id
          WHERE meeting_fts MATCH ?1 {}
          ORDER BY bm25(meeting_fts)
          LIMIT {}",
        if project_id.is_some() { "AND m.project_id = ?2" } else { "" },
        limit.clamp(1, 20)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<TranscriptHit> {
        Ok(TranscriptHit {
            meeting_id: r.get(0)?,
            title: r.get(1)?,
            snippet: r.get(2)?,
            created_at: r.get(3)?,
        })
    };
    let rows = match project_id {
        Some(pid) => stmt
            .query_map(rusqlite::params![fts_query, pid], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>(),
        None => stmt
            .query_map(rusqlite::params![fts_query], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>(),
    };
    rows.map_err(|e| e.to_string())
}

/// Set-variant of [`search_transcripts`]: the same FTS5 retrieval, but scoped to a
/// SET of folders (`m.project_id IN (…)`) instead of one — powers folder chat
/// grounding in "include subfolders" mode, where the frontend passes a folder plus
/// all its descendant folder ids (see `descendantProjectIds`). Query sanitisation,
/// snippet shape and bm25 ordering are identical to `search_transcripts`, so hits
/// render the same. An empty folder slice (or empty query) returns no hits without
/// touching the DB.
pub fn search_transcripts_in(
    conn: &Connection,
    query: &str,
    project_ids: &[String],
    limit: usize,
) -> Result<Vec<TranscriptHit>, String> {
    if project_ids.is_empty() {
        return Ok(vec![]);
    }
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| w.len() >= 2)
        .take(12)
        .map(|w| format!("\"{w}\""))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let fts_query = terms.join(" OR ");
    let placeholders = std::iter::repeat("?")
        .take(project_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT f.meeting_id, m.title, snippet(meeting_fts, 2, '**', '**', ' … ', 12), m.created_at
           FROM meeting_fts f
           JOIN meetings m ON m.id = f.meeting_id
          WHERE meeting_fts MATCH ? AND m.project_id IN ({placeholders})
          ORDER BY bm25(meeting_fts)
          LIMIT {}",
        limit.clamp(1, 20)
    );
    // Positional binding via params_from_iter (never string interpolation): the
    // FTS query first, then every folder id fills the `IN (…)` placeholders.
    let mut params: Vec<String> = Vec::with_capacity(project_ids.len() + 1);
    params.push(fts_query);
    params.extend(project_ids.iter().cloned());
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |r: &rusqlite::Row| {
            Ok(TranscriptHit {
                meeting_id: r.get(0)?,
                title: r.get(1)?,
                snippet: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The rolling brief lives next to the project's meeting folders.
pub fn project_brief_path(
    conn: &Connection,
    project_id: &str,
    save_root: &Path,
) -> Result<PathBuf, String> {
    let name: String = conn
        .query_row("SELECT name FROM projects WHERE id=?1", [project_id], |r| r.get(0))
        .map_err(|_| "project not found".to_string())?;
    Ok(save_root.join(sanitize(&name)).join("brief.md"))
}

pub fn read_project_brief(
    conn: &Connection,
    project_id: &str,
    save_root: &Path,
) -> Result<String, String> {
    let path = project_brief_path(conn, project_id, save_root)?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

pub fn write_project_brief(
    conn: &Connection,
    project_id: &str,
    content: &str,
    save_root: &Path,
) -> Result<(), String> {
    let path = project_brief_path(conn, project_id, save_root)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// One LLM-compiled wiki page, as produced by the frontend compile step.
#[derive(Debug, Clone, Deserialize)]
pub struct WikiPageInput {
    pub kind: String, // person | project | topic
    pub title: String,
    #[serde(default)]
    pub summary_line: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<String>,
    pub content_md: String,
    #[serde(default)]
    pub facts: Vec<WikiFactInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WikiFactInput {
    pub quote: String,
    #[serde(default)]
    pub t_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WikiPageRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary_line: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    pub updated_at: i64,
    pub fact_count: i64,
}

fn wiki_slug(kind: &str, title: &str) -> String {
    let t: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let t = t.trim_matches('-').to_string();
    format!("{kind}-{}", if t.is_empty() { "untitled".into() } else { t })
}

/// Upsert LLM-compiled pages for a meeting. Pages are keyed by kind+title
/// slug (re-compiles update the same page); every fact writes a provenance
/// row pointing back to the meeting (+ optional timestamp). Pages without a
/// single fact are REJECTED — no unsourced wiki claims.
pub fn upsert_wiki_pages(
    conn: &Connection,
    meeting_id: &str,
    pages: Vec<WikiPageInput>,
    save_root: &Path,
) -> Result<usize, String> {
    let wiki_dir = save_root.join("wiki");
    fs::create_dir_all(&wiki_dir).map_err(|e| e.to_string())?;
    let now = now_millis();
    let mut written = 0usize;

    for page in pages {
        if page.facts.is_empty() {
            continue; // provenance-less pages are dropped, per the invariant
        }
        let kind = match page.kind.as_str() {
            "person" | "project" | "topic" => page.kind.clone(),
            _ => "topic".to_string(),
        };
        let id = wiki_slug(&kind, &page.title);
        let rel_path = format!("wiki/{id}.md");
        let body = format!(
            "# {}\n\n_{}_\n\n{}\n",
            page.title.trim(),
            page.summary_line.trim(),
            page.content_md.trim()
        );
        fs::write(save_root.join(&rel_path), body).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO wiki_pages(id, kind, title, summary_line, tags_json, links_json, md_path, updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET
               summary_line=?4, tags_json=?5, links_json=?6, md_path=?7, updated_at=?8",
            rusqlite::params![
                id,
                kind,
                page.title.trim(),
                page.summary_line.trim(),
                serde_json::to_string(&page.tags).unwrap_or_default(),
                serde_json::to_string(&page.links).unwrap_or_default(),
                rel_path,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        // Re-compiles replace this meeting's contribution instead of stacking dupes.
        conn.execute(
            "DELETE FROM wiki_fact_provenance WHERE wiki_page_id=?1 AND meeting_id=?2",
            rusqlite::params![id, meeting_id],
        )
        .map_err(|e| e.to_string())?;
        for fact in &page.facts {
            conn.execute(
                "INSERT INTO wiki_fact_provenance(id, wiki_page_id, meeting_id, t_ms, quote, created_at)
                 VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![gen_id("fact"), id, meeting_id, fact.t_ms, fact.quote, now],
            )
            .map_err(|e| e.to_string())?;
        }
        written += 1;
    }
    Ok(written)
}

pub fn list_wiki_pages(conn: &Connection) -> Result<Vec<WikiPageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.kind, p.title, p.summary_line, p.tags_json, p.links_json, p.updated_at,
                    (SELECT COUNT(*) FROM wiki_fact_provenance f WHERE f.wiki_page_id = p.id)
               FROM wiki_pages p ORDER BY p.kind, p.title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let tags: String = r.get(4)?;
            let links: String = r.get(5)?;
            Ok(WikiPageRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                summary_line: r.get(3)?,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
                links: serde_json::from_str(&links).unwrap_or_default(),
                updated_at: r.get(6)?,
                fact_count: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// A provenance row joined with its meeting title, for the "sources" list.
#[derive(Debug, Clone, Serialize)]
pub struct WikiFact {
    pub meeting_id: String,
    pub meeting_title: String,
    pub t_ms: Option<i64>,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WikiPageDetail {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary_line: String,
    pub content_md: String,
    pub facts: Vec<WikiFact>,
}

pub fn get_wiki_page(
    conn: &Connection,
    id: &str,
    save_root: &Path,
) -> Result<WikiPageDetail, String> {
    let (kind, title, summary_line, md_path): (String, String, String, String) = conn
        .query_row(
            "SELECT kind, title, summary_line, md_path FROM wiki_pages WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "wiki page not found".to_string())?;
    let content_md = fs::read_to_string(save_root.join(&md_path)).unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT f.meeting_id, COALESCE(m.title, '(deleted meeting)'), f.t_ms, f.quote
               FROM wiki_fact_provenance f
               LEFT JOIN meetings m ON m.id = f.meeting_id
              WHERE f.wiki_page_id=?1 ORDER BY f.created_at",
        )
        .map_err(|e| e.to_string())?;
    let facts = stmt
        .query_map([id], |r| {
            Ok(WikiFact {
                meeting_id: r.get(0)?,
                meeting_title: r.get(1)?,
                t_ms: r.get(2)?,
                quote: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(WikiPageDetail { id: id.to_string(), kind, title, summary_line, content_md, facts })
}

#[cfg(test)]
mod knowledge_tests {
    use super::*;

    fn test_db(name: &str) -> (Connection, std::path::PathBuf) {
        // Unique per test NAME, not just per nanosecond — parallel test
        // threads can hit the same timestamp and then race migrate().
        let dir = std::env::temp_dir().join(format!("lalela-store-test-{name}-{}", gen_id("t")));
        fs::create_dir_all(&dir).unwrap();
        let conn = open(&dir.join("test.db")).unwrap();
        (conn, dir)
    }

    fn add_meeting(conn: &Connection, root: &Path, title: &str, text: &str) -> String {
        let m = insert_meeting(
            conn,
            SaveMeetingInput {
                title: title.into(),
                project_id: None,
                segments: vec![crate::transcribe::Segment {
                    t0_ms: 0,
                    t1_ms: 1000,
                    text: text.into(),
                    speaker: "Me".into(),
                }],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: None,
            },
            root,
        )
        .unwrap();
        m.id
    }

    #[test]
    fn attendees_roundtrip_and_stay_null_when_absent() {
        let (conn, dir) = test_db("attendees");
        let plain = add_meeting(&conn, &dir, "No calendar", "hello");
        assert!(get_meeting(&conn, &plain).unwrap().attendees.is_none());

        let m = insert_meeting(
            &conn,
            SaveMeetingInput {
                title: "Calendar matched".into(),
                project_id: None,
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: Some(vec![Attendee {
                    name: Some("Thandi Mokoena".into()),
                    email: Some("thandi@example.com".into()),
                }]),
            },
            &dir,
        )
        .unwrap();
        let loaded = get_meeting(&conn, &m.id).unwrap();
        let attendees = loaded.attendees.clone().expect("attendees survive the roundtrip");
        assert_eq!(attendees.len(), 1);
        assert_eq!(attendees[0].name.as_deref(), Some("Thandi Mokoena"));
        assert_eq!(attendees[0].email.as_deref(), Some("thandi@example.com"));

        // upsert (cloud pull-down / Teams import path) preserves them too.
        upsert_meeting(&conn, &loaded, &dir).unwrap();
        assert!(get_meeting(&conn, &m.id).unwrap().attendees.is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn import_source_media_columns_roundtrip() {
        let (conn, dir) = test_db("impaudio");
        // Audio imports (Slice 7) carry duration + sample-rate provenance.
        let id = add_meeting(&conn, &dir, "Imported call", "hello from an audio import");
        record_import_source(
            &conn, &id, "audio", "mp3", "call.mp3", "verified-audio",
            Some(93_000), Some(44_100),
        )
        .unwrap();
        let src = get_import_source(&conn, &id).unwrap();
        assert_eq!(src.kind, "audio");
        assert_eq!(src.trust_level, "verified-audio");
        assert_eq!(src.media_duration_ms, Some(93_000));
        assert_eq!(src.decoded_sample_rate, Some(44_100));

        // Text imports (Slice 2) keep the media columns empty.
        let id2 = add_meeting(&conn, &dir, "Imported notes", "typed notes");
        record_import_source(
            &conn, &id2, "transcript", "vtt", "notes.vtt", "external-unverified", None, None,
        )
        .unwrap();
        let src2 = get_import_source(&conn, &id2).unwrap();
        assert_eq!(src2.media_duration_ms, None);
        assert_eq!(src2.decoded_sample_rate, None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fts_search_finds_and_scopes_and_forgets_deleted() {
        let (conn, dir) = test_db("fts");
        let id = add_meeting(&conn, &dir, "Auxo kickoff", "We agreed to ship the importer by Friday.");
        add_meeting(&conn, &dir, "Unrelated", "Coffee machine maintenance schedule.");

        let hits = search_transcripts(&conn, "importer Friday deadline?", None, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Auxo kickoff");
        assert!(hits[0].snippet.contains("**"), "snippet should highlight matches");

        // Project pre-filter excludes unfiled meetings when scoped.
        let scoped = search_transcripts(&conn, "importer", Some("proj-none"), 5).unwrap();
        assert!(scoped.is_empty());

        delete_meeting(&conn, &id).unwrap();
        assert!(search_transcripts(&conn, "importer", None, 5).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn list_meetings_in_covers_a_folder_set_and_ignores_others() {
        let (conn, dir) = test_db("listin");
        let parent = create_project(&conn, "Parent", None).unwrap();
        let child = create_project(&conn, "Child", Some(parent.id.as_str())).unwrap();

        let in_parent = insert_meeting(
            &conn,
            SaveMeetingInput {
                title: "In parent".into(),
                project_id: Some(parent.id.clone()),
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: None,
            },
            &dir,
        )
        .unwrap()
        .id;
        let in_child = insert_meeting(
            &conn,
            SaveMeetingInput {
                title: "In child".into(),
                project_id: Some(child.id.clone()),
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: None,
            },
            &dir,
        )
        .unwrap()
        .id;
        // An unfiled meeting must never leak into a folder-set query.
        add_meeting(&conn, &dir, "Unfiled", "no folder");

        // The recursive set (parent ∪ child) returns exactly the two filed ones.
        let both = list_meetings_in(&conn, &[parent.id.clone(), child.id.clone()]).unwrap();
        let ids: std::collections::HashSet<_> = both.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(in_parent.as_str()));
        assert!(ids.contains(in_child.as_str()));

        // Direct-only (parent alone) excludes the child's meeting.
        let parent_only = list_meetings_in(&conn, &[parent.id.clone()]).unwrap();
        assert_eq!(parent_only.len(), 1);
        assert_eq!(parent_only[0].id, in_parent);

        // Empty set → empty result, no DB error.
        assert!(list_meetings_in(&conn, &[]).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn search_transcripts_in_scopes_fts_to_the_folder_set() {
        let (conn, dir) = test_db("ftsin");
        let parent = create_project(&conn, "Parent", None).unwrap();
        let child = create_project(&conn, "Child", Some(parent.id.as_str())).unwrap();

        let filed = |title: &str, text: &str, pid: &str| -> String {
            insert_meeting(
                &conn,
                SaveMeetingInput {
                    title: title.into(),
                    project_id: Some(pid.to_string()),
                    segments: vec![crate::transcribe::Segment {
                        t0_ms: 0,
                        t1_ms: 1000,
                        text: text.into(),
                        speaker: "Me".into(),
                    }],
                    notes: String::new(),
                    summary: String::new(),
                    images: vec![],
                    attendees: None,
                },
                &dir,
            )
            .unwrap()
            .id
        };

        let p = filed("Parent kickoff", "We must ship the importer by Friday.", &parent.id);
        let c = filed("Child sync", "The importer migration is nearly done.", &child.id);
        // An unfiled meeting with the same keyword must never leak into a scoped set.
        add_meeting(&conn, &dir, "Unfiled note", "importer chatter, no folder");

        // Recursive set (parent ∪ child) surfaces both filed hits, not the unfiled one.
        let both =
            search_transcripts_in(&conn, "importer", &[parent.id.clone(), child.id.clone()], 10)
                .unwrap();
        let ids: std::collections::HashSet<_> = both.iter().map(|h| h.meeting_id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(p.as_str()));
        assert!(ids.contains(c.as_str()));
        assert!(both.iter().all(|h| h.snippet.contains("**")), "snippets highlight matches");

        // Direct-only (parent alone) excludes the child's hit.
        let parent_only = search_transcripts_in(&conn, "importer", &[parent.id.clone()], 10).unwrap();
        assert_eq!(parent_only.len(), 1);
        assert_eq!(parent_only[0].meeting_id, p);

        // Empty set / empty query → empty, no DB error.
        assert!(search_transcripts_in(&conn, "importer", &[], 10).unwrap().is_empty());
        assert!(search_transcripts_in(&conn, "", &[parent.id.clone()], 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn list_meeting_attendees_projects_every_meeting_with_its_attendees() {
        let (conn, dir) = test_db("attproj");
        // A plain meeting (no calendar match) still appears — with empty attendees.
        let plain = add_meeting(&conn, &dir, "No calendar", "hello");
        // Two calendar-matched meetings carry attendees.
        let m1 = insert_meeting(
            &conn,
            SaveMeetingInput {
                title: "Kickoff".into(),
                project_id: None,
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: Some(vec![Attendee {
                    name: Some("Thandi Mokoena".into()),
                    email: Some("thandi@acme.com".into()),
                }]),
            },
            &dir,
        )
        .unwrap()
        .id;
        let m2 = insert_meeting(
            &conn,
            SaveMeetingInput {
                title: "Review".into(),
                project_id: None,
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: Some(vec![
                    Attendee { name: Some("Sipho".into()), email: Some("sipho@acme.com".into()) },
                    Attendee { name: Some("Lena".into()), email: None },
                ]),
            },
            &dir,
        )
        .unwrap()
        .id;

        let all = list_meeting_attendees(&conn).unwrap();
        assert_eq!(all.len(), 3, "every meeting is projected — nothing is capped out");

        let by_id: std::collections::HashMap<_, _> =
            all.iter().map(|m| (m.id.as_str(), m)).collect();
        assert!(
            by_id[plain.as_str()].attendees.is_empty(),
            "a no-calendar meeting yields empty attendees, not an error"
        );
        assert_eq!(by_id[m1.as_str()].attendees.len(), 1);
        assert_eq!(by_id[m1.as_str()].attendees[0].email.as_deref(), Some("thandi@acme.com"));
        assert_eq!(by_id[m1.as_str()].title, "Kickoff");
        assert_eq!(by_id[m2.as_str()].attendees.len(), 2);
        assert_eq!(by_id[m2.as_str()].attendees[1].name.as_deref(), Some("Lena"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn brief_roundtrip_under_the_project_folder() {
        let (conn, dir) = test_db("brief");
        let project = create_project(&conn, "Client X", None).unwrap();
        assert_eq!(read_project_brief(&conn, &project.id, &dir).unwrap(), "");
        write_project_brief(&conn, &project.id, "## State\nOn track.", &dir).unwrap();
        assert!(read_project_brief(&conn, &project.id, &dir).unwrap().contains("On track"));
        assert!(dir.join("Client X").join("brief.md").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn wiki_upsert_writes_files_rows_and_provenance_and_rejects_unsourced() {
        let (conn, dir) = test_db("wiki");
        let mid = add_meeting(&conn, &dir, "Kickoff", "Auxo will run discovery in July.");

        let pages = vec![
            WikiPageInput {
                kind: "project".into(),
                title: "Auxo Discovery".into(),
                summary_line: "Discovery engagement for Auxo".into(),
                tags: vec!["client".into()],
                links: vec![],
                content_md: "Runs in July.".into(),
                facts: vec![WikiFactInput { quote: "Auxo will run discovery in July.".into(), t_ms: Some(0) }],
            },
            WikiPageInput {
                kind: "topic".into(),
                title: "Unsourced".into(),
                summary_line: String::new(),
                tags: vec![],
                links: vec![],
                content_md: "No facts.".into(),
                facts: vec![],
            },
        ];
        let written = upsert_wiki_pages(&conn, &mid, pages, &dir).unwrap();
        assert_eq!(written, 1, "the provenance-less page must be dropped");

        let listed = list_wiki_pages(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fact_count, 1);

        let detail = get_wiki_page(&conn, &listed[0].id, &dir).unwrap();
        assert!(detail.content_md.contains("Runs in July"));
        assert_eq!(detail.facts.len(), 1);
        assert_eq!(detail.facts[0].meeting_title, "Kickoff");
        assert!(dir.join("wiki").join(format!("{}.md", detail.id)).exists());

        // Re-compile from the same meeting: same page id, provenance replaced not duplicated.
        let again = vec![WikiPageInput {
            kind: "project".into(),
            title: "Auxo Discovery".into(),
            summary_line: "Updated".into(),
            tags: vec![],
            links: vec![],
            content_md: "Runs in July and August.".into(),
            facts: vec![WikiFactInput { quote: "updated quote".into(), t_ms: None }],
        }];
        upsert_wiki_pages(&conn, &mid, again, &dir).unwrap();
        let listed = list_wiki_pages(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fact_count, 1);
        assert_eq!(listed[0].summary_line, "Updated");
        let _ = fs::remove_dir_all(dir);
    }

    fn meeting_with_notes(conn: &Connection, root: &Path, title: &str, notes: &str) -> FullMeeting {
        insert_meeting(
            conn,
            SaveMeetingInput {
                title: title.into(),
                project_id: None,
                segments: vec![],
                notes: notes.into(),
                summary: String::new(),
                images: vec![],
                attendees: None,
            },
            root,
        )
        .unwrap()
    }

    #[test]
    fn note_log_derives_notes_and_rewrites_files() {
        let (conn, dir) = test_db("notelog");
        // A7: creating a meeting with notes seeds ONE authorless entry, and
        // meetings.notes equals that entry's text (the derived-notes bridge).
        let m = meeting_with_notes(&conn, &dir, "Standup", "first line");
        let entries = list_note_entries(&conn, &m.id).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].author_id.is_none(), "seed entry is authorless");
        assert_eq!(get_meeting(&conn, &m.id).unwrap().notes, "first line");

        // Add an authored entry → derived notes is the chronological concat.
        let entries = add_note_entry(&conn, &m.id, Some("uid-1"), "Alice", "second line", &dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].author_name, "Alice");
        assert_eq!(get_meeting(&conn, &m.id).unwrap().notes, "first line\n\nsecond line");

        // Edit the second entry → notes reflows.
        let second = entries[1].id.clone();
        update_note_entry(&conn, &second, "second edited", &dir).unwrap();
        assert_eq!(get_meeting(&conn, &m.id).unwrap().notes, "first line\n\nsecond edited");

        // Delete the first entry → notes reflows again, and notes.md mirrors it.
        let first = entries[0].id.clone();
        let remaining = delete_note_entry(&conn, &first, &dir).unwrap();
        assert_eq!(remaining.len(), 1);
        let after = get_meeting(&conn, &m.id).unwrap();
        assert_eq!(after.notes, "second edited");
        let md = fs::read_to_string(Path::new(&after.dir_path.unwrap()).join("notes.md")).unwrap();
        assert!(md.contains("second edited"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn note_entries_claim_and_lww_upsert() {
        let (conn, dir) = test_db("noteclaim");
        let m = meeting_with_notes(&conn, &dir, "Sync", "seed");
        // Claim the authorless seed entry as the signed-in user (first push).
        claim_note_entries(&conn, &m.id, "uid-1", "Alice").unwrap();
        let entries = list_note_entries(&conn, &m.id).unwrap();
        assert_eq!(entries[0].author_id.as_deref(), Some("uid-1"));
        assert_eq!(entries[0].author_name, "Alice");

        // LWW: a newer remote copy wins; an older one is ignored.
        let mut newer = entries[0].clone();
        newer.text = "seed edited remotely".into();
        newer.updated_at += 1000;
        upsert_note_entries(&conn, std::slice::from_ref(&newer), &dir).unwrap();
        assert_eq!(list_note_entries(&conn, &m.id).unwrap()[0].text, "seed edited remotely");
        assert_eq!(get_meeting(&conn, &m.id).unwrap().notes, "seed edited remotely");

        let mut stale = newer.clone();
        stale.text = "STALE".into();
        stale.updated_at -= 5000;
        upsert_note_entries(&conn, &[stale], &dir).unwrap();
        assert_eq!(list_note_entries(&conn, &m.id).unwrap()[0].text, "seed edited remotely");

        // A brand-new remote entry from a teammate reflows the derived notes.
        let extra = NoteEntry {
            id: "noteentry-remote-1".into(),
            meeting_id: m.id.clone(),
            author_id: Some("uid-2".into()),
            author_name: "Bob".into(),
            text: "bob's note".into(),
            created_at: newer.created_at + 10,
            updated_at: newer.updated_at + 10,
        };
        upsert_note_entries(&conn, &[extra], &dir).unwrap();
        assert_eq!(
            get_meeting(&conn, &m.id).unwrap().notes,
            "seed edited remotely\n\nbob's note"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn note_entries_backfill_is_once_and_idempotent() {
        let (conn, dir) = test_db("notebackfill");
        // Simulate a pre-A7 meeting: notes present, entries wiped, flag cleared
        // (the state the first post-upgrade migrate() sees).
        let m = meeting_with_notes(&conn, &dir, "Legacy", "legacy notes");
        conn.execute("DELETE FROM meeting_note_entries", []).unwrap();
        set_setting(&conn, "note_entries_backfilled", "0").unwrap();

        migrate(&conn).unwrap();
        let entries = list_note_entries(&conn, &m.id).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].author_id.is_none());
        assert_eq!(entries[0].text, "legacy notes");
        assert_eq!(entries[0].created_at, m.created_at);

        // Re-running migrate() must not duplicate (flag now set).
        migrate(&conn).unwrap();
        assert_eq!(list_note_entries(&conn, &m.id).unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}

// ---------- Export layout (DOCX / PDF) ----------
//
// The regression these guard: captures are WebP, `docx_rs::Pic::new` decodes
// with an `image` build that has no WebP support and `.expect()`s the result —
// so exporting any meeting that held a captured frame aborted the process.
// Sizing came along for the ride: `Pic::new` declares the source resolution as
// the print size, so a 1280 px frame claimed to be 13" wide on a 5.9" page.

#[cfg(all(test, desktop))]
mod export_tests {
    use super::*;

    #[test]
    fn fit_within_shrinks_to_the_narrower_bound_and_keeps_ratio() {
        // Width-bound: a 16:9 frame wider than the column.
        assert_eq!(fit_within(1280, 720, 560, 660), (560, 315));
        // Height-bound: a tall screenshot must not run off the bottom.
        assert_eq!(fit_within(1000, 4000, 560, 660), (165, 660));
        // Never scales up — a small frame keeps its own size.
        assert_eq!(fit_within(200, 100, 560, 660), (200, 100));
        // Degenerate input can't panic or divide by zero.
        assert_eq!(fit_within(0, 0, 560, 660), (560, 660));
    }

    #[test]
    fn every_capture_fits_the_docx_text_column() {
        // docx-rs' A4 default leaves 8504 twips of text width; `Pic` sizes are
        // px at 96 DPI. Anything wider than this overhangs the page.
        let max_px = 8504 * 96 / 1440;
        for (w, h) in [(1280u32, 720u32), (1600, 900), (3024, 1964), (640, 480)] {
            let (fw, _) = fit_within(w, h, DOCX_MAX_IMG_W_PX, DOCX_MAX_IMG_H_PX);
            assert!(fw <= max_px, "{w}x{h} rendered {fw}px wide, page fits {max_px}px");
        }
    }

    #[test]
    fn wrapped_lines_stay_inside_the_column() {
        let col = 470.0; // A4 minus 20 mm margins, in pt
        let text = "Lalela transcribes the meeting on device, so the audio never leaves the Mac.";
        for line in wrap_text(text, PDF_BODY_PT, false, col) {
            assert!(text_width_pt(&line, PDF_BODY_PT, false) <= col, "overflow: {line:?}");
        }
    }

    #[test]
    fn an_unbreakable_token_is_split_rather_than_overflowing() {
        let col = 100.0;
        let url = "https://example.com/".repeat(8);
        let lines = wrap_text(&url, PDF_BODY_PT, false, col);
        assert!(lines.len() > 1, "a long URL should wrap onto several lines");
        for line in &lines {
            assert!(text_width_pt(line, PDF_BODY_PT, false) <= col, "overflow: {line:?}");
        }
        // Hard-splitting must not drop characters.
        assert_eq!(lines.concat(), url);
    }

    #[test]
    fn wrapping_never_returns_nothing() {
        // Blank transcript lines still need a line box, or the page cursor
        // stops advancing and paragraphs pile up on one baseline.
        assert_eq!(wrap_text("", PDF_BODY_PT, false, 470.0), vec![String::new()]);
        assert_eq!(wrap_text("   ", PDF_BODY_PT, false, 470.0), vec![String::new()]);
    }

    #[test]
    fn a_webp_capture_decodes_where_the_image_crate_alone_cannot() {
        let dir = std::env::temp_dir().join("lalela-export-webp-test");
        fs::create_dir_all(dir.join("images")).unwrap();
        let frame = image::DynamicImage::new_rgb8(320, 180);
        let bytes = crate::image_proc::to_webp(&frame).unwrap();
        fs::write(dir.join("images/cap-1.webp"), &bytes).unwrap();

        // The `image` crate is built without WebP — this is exactly the decode
        // that panicked inside `Pic::new`.
        assert!(image::load_from_memory(&bytes).is_err());

        let img = MeetingImage {
            id: "img1".into(),
            t_ms: 0,
            rel_path: "images/cap-1.webp".into(),
            caption: String::new(),
        };
        let loaded = load_capture(Some(&dir), &img).expect("webp capture should load");
        assert_eq!((loaded.width(), loaded.height()), (320, 180));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_or_corrupt_capture_is_skipped_not_fatal() {
        let dir = std::env::temp_dir().join("lalela-export-bad-test");
        fs::create_dir_all(dir.join("images")).unwrap();
        fs::write(dir.join("images/junk.webp"), b"not an image at all").unwrap();

        let missing = MeetingImage {
            id: "a".into(),
            t_ms: 0,
            rel_path: "images/gone.webp".into(),
            caption: String::new(),
        };
        let junk = MeetingImage {
            id: "b".into(),
            t_ms: 0,
            rel_path: "images/junk.webp".into(),
            caption: String::new(),
        };
        assert!(load_capture(Some(&dir), &missing).is_none());
        assert!(load_capture(Some(&dir), &junk).is_none());
        // A meeting that was never saved to a folder has no base path at all.
        assert!(load_capture(None, &junk).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn body_interleaves_frames_under_the_line_being_spoken() {
        let mut m = FullMeeting {
            id: "m1".into(),
            title: "T".into(),
            project_id: None,
            created_at: 0,
            dir_path: None,
            segments: vec![
                Segment { t0_ms: 0, t1_ms: 1000, speaker: "A".into(), text: "one".into() },
                Segment { t0_ms: 5000, t1_ms: 6000, speaker: "A".into(), text: "two".into() },
            ],
            notes: String::new(),
            summary: String::new(),
            enhanced_notes: String::new(),
            images: vec![MeetingImage {
                id: "i".into(),
                t_ms: 5000,
                rel_path: "images/x.webp".into(),
                caption: String::new(),
            }],
            attendees: None,
        };
        let kinds: Vec<&str> = export_body(&m)
            .iter()
            .map(|i| match i {
                BodyItem::Line(_) => "line",
                BodyItem::Image(_) => "image",
            })
            .collect();
        // The frame shares a timestamp with "two" and must follow it.
        assert_eq!(kinds, ["line", "line", "image"]);

        // A frame anchored before every line still comes out first.
        m.images[0].t_ms = 0;
        let kinds: Vec<&str> = export_body(&m)
            .iter()
            .map(|i| match i {
                BodyItem::Line(_) => "line",
                BodyItem::Image(_) => "image",
            })
            .collect();
        assert_eq!(kinds, ["line", "image", "line"]);
    }
}

#[cfg(test)]
mod rekey_tests {
    use super::*;

    fn test_db(name: &str) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lalela-rekey-test-{name}-{}", gen_id("t")));
        fs::create_dir_all(&dir).unwrap();
        let conn = open(&dir.join("test.db")).unwrap();
        (conn, dir)
    }

    fn import(conn: &Connection, root: &Path, id: &str, text: &str) {
        let m = FullMeeting {
            id: id.into(),
            title: "Weekly sync".into(),
            project_id: None,
            created_at: 1_700_000_000_000,
            dir_path: None,
            segments: vec![crate::transcribe::Segment {
                t0_ms: 0,
                t1_ms: 1000,
                text: text.into(),
                speaker: "Thandi".into(),
            }],
            notes: "my notes".into(),
            summary: "a summary".into(),
            enhanced_notes: String::new(),
            images: vec![],
            attendees: None,
        };
        upsert_meeting(conn, &m, root).unwrap();
    }

    fn count(conn: &Connection, sql: &str, id: &str) -> i64 {
        conn.query_row(sql, [id], |r| r.get(0)).unwrap()
    }

    /// One child row in every table that references a meeting id.
    fn seed_children(conn: &Connection, id: &str) {
        for sql in [
            "INSERT INTO meeting_note_entries(id,meeting_id,author_id,author_name,text,created_at,updated_at) VALUES('ne1',?1,NULL,'','n',1,1)",
            "INSERT INTO meeting_workflow_outputs(meeting_id,workflow_id,block_id,output,updated_at) VALUES(?1,'w','b','o',1)",
            "INSERT INTO action_items(id,meeting_id,title,created_at,updated_at) VALUES('ai1',?1,'Do it',1,1)",
            "INSERT INTO chat_threads(id,scope,scope_id,title,created_at,updated_at) VALUES('ct1','meeting',?1,'t',1,1)",
            "INSERT INTO speaker_observations(id,meeting_id,cluster_label,created_at) VALUES('so1',?1,'S0',1)",
            "INSERT INTO import_sources(id,meeting_id,format,original_filename,imported_at) VALUES('is1',?1,'vtt','a.vtt',1)",
            "INSERT INTO wiki_fact_provenance(id,wiki_page_id,meeting_id,quote,created_at) VALUES('wf1','topic-x',?1,'q',1)",
            "INSERT INTO meeting_tags(meeting_id,tag_id,created_at) VALUES(?1,'tag1',1)",
            "INSERT INTO automation_runs(meeting_id,tag_id,action,status,ran_by,ran_at) VALUES(?1,'tag1','tag','done','desktop',1)",
            "INSERT INTO meeting_sort(meeting_id,status,updated_at) VALUES(?1,'sorted',1)",
            "INSERT INTO folder_rule_items(rule_id,meeting_id,action,status,at) VALUES('r1',?1,'summarise','done',1)",
        ] {
            conn.execute(sql, [id]).unwrap();
        }
    }

    fn child_rows(conn: &Connection, id: &str) -> i64 {
        MEETING_ID_COLUMNS
            .iter()
            .map(|(t, c, extra)| {
                count(conn, &format!("SELECT COUNT(*) FROM {t} WHERE {c}=?1{extra}"), id)
            })
            .sum()
    }

    #[test]
    fn every_meeting_id_column_is_rekeyed() {
        // Guard: a new table with a meeting_id column must join MEETING_ID_COLUMNS.
        let (conn, _dir) = test_db("columns");
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for t in tables {
            let has: bool = conn
                .prepare(&format!(
                    "SELECT 1 FROM pragma_table_info('{t}') WHERE name='meeting_id'"
                ))
                .and_then(|mut s| s.exists([]))
                .unwrap_or(false);
            if has {
                assert!(
                    MEETING_ID_COLUMNS.iter().any(|(name, _, _)| *name == t),
                    "table {t} has meeting_id but rekey_meeting ignores it"
                );
            }
        }
    }

    #[test]
    fn rekey_moves_row_children_fts_and_keeps_an_alias() {
        let (conn, dir) = test_db("move");
        let old = "conn-teams-63798078569f1569";
        let new = "conn-teams-0123456789abcdef";
        import(&conn, &dir, old, "quarterly pipeline review");
        seed_children(&conn, old);
        let before = get_meeting(&conn, old).unwrap();
        let expected_children = child_rows(&conn, old);
        // 11 seeded child rows + the meeting's FTS row.
        assert!(expected_children >= 12, "got {expected_children}");

        let moved = rekey_meeting(&conn, old, new).unwrap();
        assert_eq!(moved.id, new);
        assert_eq!(moved.title, before.title);
        assert_eq!(moved.notes, before.notes);
        // Folder is derived from folder/created_at/title, never the id.
        assert_eq!(moved.dir_path, before.dir_path);
        let dir_path = PathBuf::from(moved.dir_path.clone().unwrap());
        assert!(dir_path.join("transcript.md").exists());

        assert!(get_meeting(&conn, old).is_err());
        assert_eq!(child_rows(&conn, old), 0);
        assert_eq!(child_rows(&conn, new), expected_children);
        // The source column survives the move (still a Teams import).
        let source: String = conn
            .query_row("SELECT source FROM meetings WHERE id=?1", [new], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "teams");
        // Search finds it under the new id.
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM meeting_fts WHERE meeting_fts MATCH 'pipeline' AND meeting_id=?1",
                [new],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
        // Old id resolves through the alias; import dedupe sees it.
        assert_eq!(resolve_meeting_id(&conn, old), new);
        assert_eq!(resolve_meeting_id(&conn, new), new);
        assert_eq!(resolve_meeting_id(&conn, "nope"), "nope");
        assert_eq!(list_meeting_id_aliases(&conn).unwrap(), vec![old.to_string()]);
    }

    #[test]
    fn rekey_refuses_and_changes_nothing_when_target_exists() {
        let (conn, dir) = test_db("refuse");
        let old = "conn-teams-aaaaaaaaaaaaaaaa";
        let new = "conn-teams-bbbbbbbbbbbbbbbb";
        import(&conn, &dir, old, "one");
        import(&conn, &dir, new, "two");
        seed_children(&conn, old);
        let n = child_rows(&conn, old);
        assert!(rekey_meeting(&conn, old, new).is_err());
        assert!(get_meeting(&conn, old).is_ok());
        assert_eq!(child_rows(&conn, old), n);
        assert!(list_meeting_id_aliases(&conn).unwrap().is_empty());
        // Missing source / same id also refuse.
        assert!(rekey_meeting(&conn, "conn-teams-missing", "conn-teams-x").is_err());
        assert!(rekey_meeting(&conn, old, old).is_err());
    }

    #[test]
    fn alias_chains_collapse_and_delete_clears_them() {
        let (conn, dir) = test_db("chain");
        import(&conn, &dir, "conn-teams-a", "x");
        rekey_meeting(&conn, "conn-teams-a", "conn-teams-b").unwrap();
        rekey_meeting(&conn, "conn-teams-b", "conn-teams-c").unwrap();
        assert_eq!(resolve_meeting_id(&conn, "conn-teams-a"), "conn-teams-c");
        assert_eq!(resolve_meeting_id(&conn, "conn-teams-b"), "conn-teams-c");
        // Re-keying onto an existing alias is refused (it would shadow it).
        import(&conn, &dir, "conn-teams-d", "y");
        assert!(rekey_meeting(&conn, "conn-teams-d", "conn-teams-a").is_err());
        delete_meeting(&conn, "conn-teams-c").unwrap();
        assert!(list_meeting_id_aliases(&conn).unwrap().is_empty());
    }

    /// The commands resolve an incoming meeting id with `resolve_meeting_id`
    /// (or `resolve_chat_scope_id`) before touching per-meeting data. This is
    /// that exact sequence for the notes log: a view still holding the OLD id
    /// must read the moved entries (not "" — which would wipe notes on save)
    /// and must append to the moved meeting, never write an orphan.
    #[test]
    fn old_id_reaches_the_notes_log_and_chat_after_rekey() {
        let (conn, dir) = test_db("aliases");
        let old = "conn-teams-oldoldoldoldold1";
        let new = "conn-teams-newnewnewnewnew1";
        import(&conn, &dir, old, "x");
        add_note_entry(&conn, old, None, "", "first note", &dir).unwrap();
        rekey_meeting(&conn, old, new).unwrap();

        let via_old = list_note_entries(&conn, &resolve_meeting_id(&conn, old)).unwrap();
        assert_eq!(via_old.len(), 1);
        assert_eq!(via_old[0].meeting_id, new);

        add_note_entry(&conn, &resolve_meeting_id(&conn, old), None, "", "second note", &dir)
            .unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM meeting_note_entries WHERE meeting_id=?1", old), 0);
        assert_eq!(list_note_entries(&conn, new).unwrap().len(), 2);
        assert!(get_meeting(&conn, new).unwrap().notes.contains("second note"));

        assert_eq!(
            resolve_chat_scope_id(&conn, "meeting", Some(old.into())),
            Some(new.to_string())
        );
        assert_eq!(
            resolve_chat_scope_id(&conn, "folder", Some(old.into())),
            Some(old.to_string())
        );
        assert_eq!(resolve_chat_scope_id(&conn, "global", None), None);
    }

    #[test]
    fn rekey_replaces_a_stray_child_row_already_on_the_new_id() {
        let (conn, dir) = test_db("stray");
        import(&conn, &dir, "conn-teams-old", "x");
        seed_children(&conn, "conn-teams-old");
        conn.execute(
            "INSERT INTO automation_runs(meeting_id,tag_id,action,status,ran_by,ran_at) VALUES('conn-teams-new','tag1','tag','failed','cloud',0)",
            [],
        )
        .unwrap();
        rekey_meeting(&conn, "conn-teams-old", "conn-teams-new").unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM automation_runs WHERE meeting_id='conn-teams-new' AND tag_id='tag1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "done");
    }
}
