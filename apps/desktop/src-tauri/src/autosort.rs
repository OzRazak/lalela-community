//! Auto-sort meetings into folders (2026-10). The folders ARE the existing
//! `projects` tree and a meeting's folder IS `meetings.project_id` (one folder
//! per meeting) — this module only adds the audit/queue ledger beside it:
//!
//! `meeting_sort` — one row per meeting the sorter (or the user, via the
//! "To sort" queue / a hand move) has a decision for:
//!   status  'auto'    — the classifier filed it (folder_id = where it went)
//!           'review'  — waiting in the "To sort" queue (folder_id = suggestion)
//!           'manual'  — the user chose the folder by hand (never overwritten)
//!           'skipped' — the user skipped it in the queue (left Unfiled)
//!   + confidence / title_mismatch / reason / suggested_new_folder / run_id /
//!     model, so every auto-sort can be audited and a whole run undone.
//!
//! The classifier itself runs frontend-side through the one AI front door
//! (`src/lib/autoSort.ts`); Rust owns the guarded writes so the "never
//! overwrite a folder set by hand" rule is enforced in one place, atomically.
//!
//! LOCAL ONLY: the ledger never syncs. The folder itself (`project_id`) rides
//! the existing meeting push, so the cloud and the web app see the result.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::store::{self, FullMeeting};

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Idempotent schema for the sort ledger. Called from `store::open`.
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meeting_sort (
            meeting_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            folder_id TEXT,
            suggested_new_folder TEXT,
            confidence REAL,
            title_mismatch INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT '',
            run_id TEXT,
            model TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_sort_status
            ON meeting_sort(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_meeting_sort_run ON meeting_sort(run_id);",
    )
    .map_err(|e| e.to_string())
}

/// One classifier decision handed over by the frontend batch / new-meeting hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortDecision {
    pub meeting_id: String,
    /// "auto" (file it now) or "review" (queue it). Anything else is refused.
    pub status: String,
    pub folder_id: Option<String>,
    pub suggested_new_folder: Option<String>,
    pub confidence: f64,
    pub title_mismatch: bool,
    pub reason: String,
    pub run_id: Option<String>,
    pub model: Option<String>,
}

/// What `record_decision` actually did.
#[derive(Clone, Serialize, Deserialize)]
pub struct RecordOutcome {
    /// "filed" | "queued" | "kept" (left alone: already filed / decided by hand)
    pub result: String,
    /// The meeting after an auto-file (so the caller can push it to the cloud).
    pub meeting: Option<FullMeeting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortRecord {
    pub meeting_id: String,
    pub title: String,
    pub created_at: i64,
    pub project_id: Option<String>,
    pub status: String,
    pub folder_id: Option<String>,
    pub suggested_new_folder: Option<String>,
    pub confidence: Option<f64>,
    pub title_mismatch: bool,
    pub reason: String,
    pub run_id: Option<String>,
    pub updated_at: i64,
    /// Summary head (≤400 chars) for the queue card.
    pub summary_head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SortStats {
    /// Unfiled meetings the batch would still look at.
    pub unsorted: i64,
    pub review: i64,
    pub auto: i64,
    pub manual: i64,
    pub skipped: i64,
    /// Most recent run that still has auto-filed meetings (for "Undo last run").
    pub last_run_id: Option<String>,
    pub last_run_count: i64,
}

/// The meeting's folder: `None` = no such meeting, `Some(None)` = Unfiled.
pub fn current_project(conn: &Connection, meeting_id: &str) -> Result<Option<Option<String>>, String> {
    conn.query_row(
        "SELECT project_id FROM meetings WHERE id=?1",
        [meeting_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn existing_status(conn: &Connection, meeting_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT status FROM meeting_sort WHERE meeting_id=?1",
        [meeting_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn upsert(conn: &Connection, d: &SortDecision, status: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meeting_sort(meeting_id,status,folder_id,suggested_new_folder,confidence,
            title_mismatch,reason,run_id,model,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(meeting_id) DO UPDATE SET status=?2, folder_id=?3, suggested_new_folder=?4,
            confidence=?5, title_mismatch=?6, reason=?7, run_id=?8, model=?9, updated_at=?10",
        rusqlite::params![
            d.meeting_id,
            status,
            d.folder_id,
            d.suggested_new_folder,
            d.confidence,
            d.title_mismatch as i64,
            d.reason,
            d.run_id,
            d.model,
            now_millis()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn folder_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT 1 FROM projects WHERE id=?1", [id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Apply one classifier decision with the hand-set guard:
/// - a meeting that already has a folder, or a 'manual'/'skipped' ledger row,
///   is never touched ("kept");
/// - "auto" files it (rewrites its Markdown under the folder) and logs the row;
/// - "review" (or an "auto" whose folder no longer exists) queues it.
pub fn record_decision(
    conn: &Connection,
    d: &SortDecision,
    save_root: &std::path::Path,
) -> Result<RecordOutcome, String> {
    let kept = || RecordOutcome { result: "kept".into(), meeting: None };
    let Some(project) = current_project(conn, &d.meeting_id)? else {
        return Ok(kept()); // meeting deleted meanwhile
    };
    if project.is_some() {
        return Ok(kept());
    }
    if matches!(
        existing_status(conn, &d.meeting_id)?.as_deref(),
        Some("manual") | Some("skipped")
    ) {
        return Ok(kept());
    }
    let can_file = d.status == "auto"
        && d.folder_id.as_deref().map(|f| folder_exists(conn, f)).unwrap_or(false);
    match d.status.as_str() {
        "auto" if can_file => {
            // Ledger row + folder change commit together: if the Markdown
            // rewrite fails, the transaction rolls back and the meeting stays
            // Unfiled with no row (never "filed but invisible to undo").
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            upsert(&tx, d, "auto")?;
            let folder = d.folder_id.as_deref();
            let meeting = store::set_meeting_project(&tx, &d.meeting_id, folder, save_root)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(RecordOutcome { result: "filed".into(), meeting: Some(meeting) })
        }
        "auto" | "review" => {
            upsert(conn, d, "review")?;
            Ok(RecordOutcome { result: "queued".into(), meeting: None })
        }
        other => Err(format!("unknown sort status: {other}")),
    }
}

/// Record that the user chose this meeting's folder by hand (queue Accept /
/// Pick another / any manual move). Does NOT move the meeting — the caller
/// already did via `move_meeting_to_project`. `folder_id = None` (moved back to
/// Unfiled) clears the ledger row so the meeting is sortable again.
pub fn mark_manual(conn: &Connection, meeting_id: &str, folder_id: Option<&str>) -> Result<(), String> {
    match folder_id {
        None => {
            conn.execute("DELETE FROM meeting_sort WHERE meeting_id=?1", [meeting_id])
                .map_err(|e| e.to_string())?;
        }
        Some(f) => {
            // Keep the classifier's confidence/reason for the audit trail.
            conn.execute(
                "INSERT INTO meeting_sort(meeting_id,status,folder_id,updated_at)
                 VALUES(?1,'manual',?2,?3)
                 ON CONFLICT(meeting_id) DO UPDATE SET status='manual', folder_id=?2, updated_at=?3",
                rusqlite::params![meeting_id, f, now_millis()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Single choke point for USER-initiated folder changes (store::update_meeting,
/// store::upsert_meeting, store::move_meeting_by_user — i.e. the detail-view
/// folder picker, drag-and-drop, list/bulk moves, queue actions, automations'
/// move action and cloud re-imports). If the folder actually changed, the
/// meeting is now hand-sorted, so auto-sort (and its undo) never touches it
/// again. `before = None` (a brand-new meeting) is not a change.
pub fn note_user_folder_change(
    conn: &Connection,
    meeting_id: &str,
    before: Option<Option<String>>,
    after: Option<&str>,
) -> Result<(), String> {
    match before {
        Some(prev) if prev.as_deref() != after => mark_manual(conn, meeting_id, after),
        _ => Ok(()),
    }
}

pub fn skip(conn: &Connection, meeting_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meeting_sort(meeting_id,status,updated_at) VALUES(?1,'skipped',?2)
         ON CONFLICT(meeting_id) DO UPDATE SET status='skipped', updated_at=?2",
        rusqlite::params![meeting_id, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Unfiled meetings the batch should classify, newest first: no folder, and not
/// already queued or skipped. (An 'auto'/'manual' row on an Unfiled meeting is
/// stale — e.g. its folder was deleted — so it counts as unsorted again.)
pub fn candidates(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id FROM meetings m
             WHERE m.project_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM meeting_sort s
                               WHERE s.meeting_id=m.id AND s.status IN ('review','skipped'))
             ORDER BY m.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn map_record(r: &rusqlite::Row) -> rusqlite::Result<SortRecord> {
    Ok(SortRecord {
        meeting_id: r.get(0)?,
        title: r.get(1)?,
        created_at: r.get(2)?,
        project_id: r.get(3)?,
        status: r.get(4)?,
        folder_id: r.get(5)?,
        suggested_new_folder: r.get(6)?,
        confidence: r.get(7)?,
        title_mismatch: r.get::<_, i64>(8)? != 0,
        reason: r.get(9)?,
        run_id: r.get(10)?,
        updated_at: r.get(11)?,
        summary_head: r.get(12)?,
    })
}

const RECORD_COLS: &str = "s.meeting_id, m.title, m.created_at, m.project_id, s.status, s.folder_id,
    s.suggested_new_folder, s.confidence, s.title_mismatch, s.reason, s.run_id, s.updated_at,
    substr(m.summary,1,400)";

/// The "To sort" queue: queued meetings still Unfiled, newest first.
pub fn review_queue(conn: &Connection) -> Result<Vec<SortRecord>, String> {
    let sql = format!(
        "SELECT {RECORD_COLS} FROM meeting_sort s JOIN meetings m ON m.id=s.meeting_id
         WHERE s.status='review' AND m.project_id IS NULL ORDER BY m.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_record).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Recent auto-filed meetings (audit list), newest decision first.
pub fn recent_auto(conn: &Connection, limit: i64) -> Result<Vec<SortRecord>, String> {
    let sql = format!(
        "SELECT {RECORD_COLS} FROM meeting_sort s JOIN meetings m ON m.id=s.meeting_id
         WHERE s.status='auto' ORDER BY s.updated_at DESC LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([limit], map_record).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn stats(conn: &Connection) -> Result<SortStats, String> {
    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())
    };
    let unsorted = candidates(conn)?.len() as i64;
    let review = count(
        "SELECT COUNT(*) FROM meeting_sort s JOIN meetings m ON m.id=s.meeting_id
         WHERE s.status='review' AND m.project_id IS NULL",
    )?;
    let auto = count("SELECT COUNT(*) FROM meeting_sort WHERE status='auto'")?;
    let manual = count("SELECT COUNT(*) FROM meeting_sort WHERE status='manual'")?;
    let skipped = count("SELECT COUNT(*) FROM meeting_sort WHERE status='skipped'")?;
    let last: Option<(String, i64)> = conn
        .query_row(
            "SELECT run_id, COUNT(*) FROM meeting_sort
             WHERE status='auto' AND run_id IS NOT NULL
             GROUP BY run_id ORDER BY MAX(updated_at) DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(SortStats {
        unsorted,
        review,
        auto,
        manual,
        skipped,
        last_run_id: last.as_ref().map(|l| l.0.clone()),
        last_run_count: last.map(|l| l.1).unwrap_or(0),
    })
}

/// One meeting an undo moved back to Unfiled, and the folder the run had
/// chosen (the frontend uses it as the cloud compare-and-set value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevertedSort {
    pub meeting_id: String,
    pub folder_id: String,
}

/// Undo one auto-sort run: every meeting it filed that is STILL in the folder
/// the run put it in goes back to Unfiled and its ledger row is dropped (so it
/// is sortable again). Meetings moved since are left where the user put them
/// and re-marked 'manual'. Returns the reverted meetings (for the cloud push).
pub fn undo_run(
    conn: &Connection,
    run_id: &str,
    save_root: &std::path::Path,
) -> Result<Vec<RevertedSort>, String> {
    let rows: Vec<(String, Option<String>, Option<String>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT s.meeting_id, s.folder_id, m.project_id FROM meeting_sort s
                 JOIN meetings m ON m.id=s.meeting_id
                 WHERE s.status='auto' AND s.run_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([run_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut reverted = Vec::new();
    for (id, folder, current) in rows {
        if folder.is_some() && folder == current {
            // Same all-or-nothing rule as record_decision.
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM meeting_sort WHERE meeting_id=?1", [&id])
                .map_err(|e| e.to_string())?;
            store::set_meeting_project(&tx, &id, None, save_root)?;
            tx.commit().map_err(|e| e.to_string())?;
            reverted.push(RevertedSort { meeting_id: id, folder_id: folder.unwrap_or_default() });
        } else if current.is_some() {
            mark_manual(conn, &id, current.as_deref())?;
        } else {
            conn.execute("DELETE FROM meeting_sort WHERE meeting_id=?1", [&id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(reverted)
}

// ---------- Tauri commands ----------

fn root(state: &State<'_, AppState>, conn: &Connection) -> std::path::PathBuf {
    store::save_root(conn, &state.fallback_root)
}

#[tauri::command]
pub fn autosort_record(
    decision: SortDecision,
    state: State<'_, AppState>,
) -> Result<RecordOutcome, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let r = root(&state, &conn);
    record_decision(&conn, &decision, &r)
}

#[tauri::command]
pub fn autosort_mark_manual(
    meeting_id: String,
    folder_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = crate::store::resolve_meeting_id(&conn, &meeting_id);
    mark_manual(&conn, &meeting_id, folder_id.as_deref())
}

#[tauri::command]
pub fn autosort_skip(meeting_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = crate::store::resolve_meeting_id(&conn, &meeting_id);
    skip(&conn, &meeting_id)
}

#[tauri::command]
pub fn autosort_candidates(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    candidates(&conn)
}

#[tauri::command]
pub fn autosort_review_queue(state: State<'_, AppState>) -> Result<Vec<SortRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    review_queue(&conn)
}

#[tauri::command]
pub fn autosort_recent(limit: i64, state: State<'_, AppState>) -> Result<Vec<SortRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    recent_auto(&conn, limit)
}

#[tauri::command]
pub fn autosort_stats(state: State<'_, AppState>) -> Result<SortStats, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    stats(&conn)
}

#[tauri::command]
pub fn autosort_undo_run(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RevertedSort>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let r = root(&state, &conn);
    undo_run(&conn, &run_id, &r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{create_project, get_meeting, insert_meeting, open, SaveMeetingInput};

    fn test_db(name: &str) -> (Connection, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lalela-autosort-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open(&dir.join("test.db")).unwrap();
        (conn, dir)
    }

    fn add(conn: &Connection, root: &std::path::Path, title: &str, project: Option<String>) -> String {
        insert_meeting(
            conn,
            SaveMeetingInput {
                title: title.into(),
                project_id: project,
                segments: vec![],
                notes: String::new(),
                summary: String::new(),
                images: vec![],
                attendees: None,
            },
            root,
        )
        .unwrap()
        .id
    }

    fn decision(id: &str, status: &str, folder: Option<&str>, run: &str) -> SortDecision {
        SortDecision {
            meeting_id: id.into(),
            status: status.into(),
            folder_id: folder.map(String::from),
            suggested_new_folder: None,
            confidence: 0.9,
            title_mismatch: false,
            reason: "test".into(),
            run_id: Some(run.into()),
            model: None,
        }
    }

    #[test]
    fn auto_files_review_queues_and_hand_set_folders_are_kept() {
        let (conn, dir) = test_db("route");
        let coaching = create_project(&conn, "Coaching", None).unwrap();
        let other = create_project(&conn, "Other", None).unwrap();
        let a = add(&conn, &dir, "A", None);
        let b = add(&conn, &dir, "B", None);
        let hand = add(&conn, &dir, "Hand", Some(other.id.clone()));
        assert_eq!(candidates(&conn).unwrap().len(), 2);

        let out = record_decision(&conn, &decision(&a, "auto", Some(&coaching.id), "r1"), &dir).unwrap();
        assert_eq!(out.result, "filed");
        assert_eq!(get_meeting(&conn, &a).unwrap().project_id.as_deref(), Some(coaching.id.as_str()));

        let out = record_decision(&conn, &decision(&b, "review", Some(&coaching.id), "r1"), &dir).unwrap();
        assert_eq!(out.result, "queued");
        assert!(get_meeting(&conn, &b).unwrap().project_id.is_none());
        assert_eq!(review_queue(&conn).unwrap().len(), 1);

        // A folder set by hand is never overwritten.
        let out = record_decision(&conn, &decision(&hand, "auto", Some(&coaching.id), "r1"), &dir).unwrap();
        assert_eq!(out.result, "kept");
        assert_eq!(get_meeting(&conn, &hand).unwrap().project_id.as_deref(), Some(other.id.as_str()));

        // Nothing left to classify: a is filed, b is queued.
        assert!(candidates(&conn).unwrap().is_empty());
        let s = stats(&conn).unwrap();
        assert_eq!((s.auto, s.review, s.unsorted), (1, 1, 0));
        assert_eq!(s.last_run_id.as_deref(), Some("r1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn auto_with_unknown_folder_falls_back_to_review_and_manual_blocks() {
        let (conn, dir) = test_db("fallback");
        let a = add(&conn, &dir, "A", None);
        let out = record_decision(&conn, &decision(&a, "auto", Some("nope"), "r1"), &dir).unwrap();
        assert_eq!(out.result, "queued");
        skip(&conn, &a).unwrap();
        let out = record_decision(&conn, &decision(&a, "review", None, "r2"), &dir).unwrap();
        assert_eq!(out.result, "kept");
        assert!(candidates(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_user_folder_change_marks_manual_so_undo_leaves_it() {
        let (conn, dir) = test_db("manual");
        let a_folder = create_project(&conn, "A", None).unwrap();
        let b_folder = create_project(&conn, "B", None).unwrap();
        // 1) Move menu / drag-drop / queue: A -> B -> A by hand.
        let m1 = add(&conn, &dir, "M1", None);
        record_decision(&conn, &decision(&m1, "auto", Some(&a_folder.id), "run-1"), &dir).unwrap();
        store::move_meeting_by_user(&conn, &m1, Some(&b_folder.id), &dir).unwrap();
        store::move_meeting_by_user(&conn, &m1, Some(&a_folder.id), &dir).unwrap();
        // 2) Meeting-detail folder picker (update_meeting): A -> B -> A.
        let m2 = add(&conn, &dir, "M2", None);
        record_decision(&conn, &decision(&m2, "auto", Some(&a_folder.id), "run-1"), &dir).unwrap();
        store::update_meeting(&conn, &m2, "M2", "", "", Some(&b_folder.id), &dir).unwrap();
        store::update_meeting(&conn, &m2, "M2", "", "", Some(&a_folder.id), &dir).unwrap();
        // 3) An edit that doesn't change the folder is NOT a hand sort.
        let m3 = add(&conn, &dir, "M3", None);
        record_decision(&conn, &decision(&m3, "auto", Some(&a_folder.id), "run-1"), &dir).unwrap();
        store::update_meeting(&conn, &m3, "M3 renamed", "notes", "", Some(&a_folder.id), &dir).unwrap();
        // 4) Cloud re-import carrying a different folder (moved on web).
        let m4 = add(&conn, &dir, "M4", None);
        record_decision(&conn, &decision(&m4, "auto", Some(&a_folder.id), "run-1"), &dir).unwrap();
        let mut pulled = get_meeting(&conn, &m4).unwrap();
        pulled.project_id = Some(b_folder.id.clone());
        store::upsert_meeting(&conn, &pulled, &dir).unwrap();

        for id in [&m1, &m2, &m4] {
            assert_eq!(existing_status(&conn, id).unwrap().as_deref(), Some("manual"), "{id}");
        }
        assert_eq!(existing_status(&conn, &m3).unwrap().as_deref(), Some("auto"));

        let reverted = undo_run(&conn, "run-1", &dir).unwrap();
        assert_eq!(reverted.len(), 1, "only the untouched auto-sort is undone");
        assert!(get_meeting(&conn, &m3).unwrap().project_id.is_none());
        assert_eq!(get_meeting(&conn, &m1).unwrap().project_id.as_deref(), Some(a_folder.id.as_str()));
        assert_eq!(get_meeting(&conn, &m2).unwrap().project_id.as_deref(), Some(a_folder.id.as_str()));
        assert_eq!(get_meeting(&conn, &m4).unwrap().project_id.as_deref(), Some(b_folder.id.as_str()));
        // Moving back to Unfiled by hand makes it sortable again.
        store::move_meeting_by_user(&conn, &m1, None, &dir).unwrap();
        assert!(existing_status(&conn, &m1).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_manual_move_rolls_back_and_a_retry_still_marks_manual() {
        let (conn, dir) = test_db("manual-rollback");
        let a = create_project(&conn, "A", None).unwrap();
        let b = create_project(&conn, "B", None).unwrap();
        let m = add(&conn, &dir, "M", None);
        record_decision(&conn, &decision(&m, "auto", Some(&a.id), "run-m"), &dir).unwrap();
        let bad_root = dir.join("not-a-dir");
        std::fs::write(&bad_root, b"x").unwrap();
        assert!(store::move_meeting_by_user(&conn, &m, Some(&b.id), &bad_root).is_err());
        assert_eq!(get_meeting(&conn, &m).unwrap().project_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(existing_status(&conn, &m).unwrap().as_deref(), Some("auto"));
        // The retry sees a real change and marks it manual.
        store::move_meeting_by_user(&conn, &m, Some(&b.id), &dir).unwrap();
        assert_eq!(get_meeting(&conn, &m).unwrap().project_id.as_deref(), Some(b.id.as_str()));
        assert_eq!(existing_status(&conn, &m).unwrap().as_deref(), Some("manual"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_markdown_write_rolls_back_the_auto_file() {
        let (conn, dir) = test_db("rollback");
        let f = create_project(&conn, "PPS", None).unwrap();
        let a = add(&conn, &dir, "A", None);
        // A save root that is a FILE: write_files' create_dir_all fails.
        let bad_root = dir.join("not-a-dir");
        std::fs::write(&bad_root, b"x").unwrap();
        let err = record_decision(&conn, &decision(&a, "auto", Some(&f.id), "run-r"), &bad_root);
        assert!(err.is_err());
        assert!(get_meeting(&conn, &a).unwrap().project_id.is_none(), "folder change rolled back");
        assert!(existing_status(&conn, &a).unwrap().is_none(), "no ledger row");
        assert_eq!(candidates(&conn).unwrap(), vec![a.clone()], "still sortable");

        // Same for undo: a failed revert keeps meeting + ledger consistent.
        record_decision(&conn, &decision(&a, "auto", Some(&f.id), "run-r"), &dir).unwrap();
        assert!(undo_run(&conn, "run-r", &bad_root).is_err());
        assert_eq!(get_meeting(&conn, &a).unwrap().project_id.as_deref(), Some(f.id.as_str()));
        assert_eq!(existing_status(&conn, &a).unwrap().as_deref(), Some("auto"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn undo_reverts_only_meetings_still_where_the_run_put_them() {
        let (conn, dir) = test_db("undo");
        let f = create_project(&conn, "PPS", None).unwrap();
        let g = create_project(&conn, "Elsewhere", None).unwrap();
        let a = add(&conn, &dir, "A", None);
        let b = add(&conn, &dir, "B", None);
        record_decision(&conn, &decision(&a, "auto", Some(&f.id), "run-x"), &dir).unwrap();
        record_decision(&conn, &decision(&b, "auto", Some(&f.id), "run-x"), &dir).unwrap();
        // The user moves b by hand after the run.
        store::set_meeting_project(&conn, &b, Some(&g.id), &dir).unwrap();

        let reverted = undo_run(&conn, "run-x", &dir).unwrap();
        assert_eq!(reverted.len(), 1);
        assert!(get_meeting(&conn, &a).unwrap().project_id.is_none());
        assert_eq!(get_meeting(&conn, &b).unwrap().project_id.as_deref(), Some(g.id.as_str()));
        assert_eq!(existing_status(&conn, &b).unwrap().as_deref(), Some("manual"));
        assert_eq!(candidates(&conn).unwrap(), vec![a.clone()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
