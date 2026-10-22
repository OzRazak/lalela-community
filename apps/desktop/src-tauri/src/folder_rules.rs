//! Folder automations (2026-10): scheduled rules that run over the meetings of
//! one folder (a `projects` row; a meeting's folder is `meetings.project_id`).
//! "Every Monday at 08:00, write a digest of this week's Coaching — Michelle
//! meetings", or "every Friday, extract tasks and send new PPS meetings to
//! Atlas". Design note: `docs/FOLDER-AUTOMATIONS.md`.
//!
//! Three local tables, all LOCAL ONLY (they never sync, like reports/workflows):
//!
//! `folder_rules`      — the rule. `config` is JSON owned by the frontend
//!                       (schedule, window, actions; see `lib/folderRulesCore.ts`)
//!                       so the schedule/actions can grow without migrations.
//!                       `last_run_at` = start of the last successful run (the
//!                       "new since last run" baseline); `last_period` = the
//!                       last scheduled period that completed.
//! `folder_rule_runs`  — run history AND the idempotency ledger: UNIQUE
//!                       (rule_id, period_key). A scheduled run claims its
//!                       period key first; a second claim for the same period
//!                       (another tick, a relaunch, a missed-run catch-up) is
//!                       refused, so a period runs once. Manual runs use a
//!                       unique `manual:<millis>` key.
//! `folder_rule_items` — per-meeting ledger for per-meeting actions (task
//!                       extraction, sends) so a meeting is processed once per
//!                       rule + action, even across overlapping windows.
//!
//! Digest outputs reuse `report_outputs` with `report_id = <rule id>` (same
//! immutable shape as Reports), surfaced per folder by `folder_reports`.
//! The scheduler, scope resolution and AI calls are frontend-side
//! (`lib/folderRules.ts`), mirroring Reports.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn gen_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}")
}

/// A failed scheduled run is retried on later ticks up to this many attempts
/// per period, then left failed until the next period.
const MAX_ATTEMPTS: i64 = 3;
/// A run still "running" after this long is treated as abandoned (the app quit
/// or crashed mid-run) and may be re-claimed.
const STALE_RUNNING_MS: i64 = 2 * 60 * 60 * 1000;

/// Idempotent schema. Called from `store::open`.
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS folder_rules (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config TEXT NOT NULL DEFAULT '{}',
            last_run_at INTEGER,
            last_period TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_folder_rules_project ON folder_rules(project_id);
        CREATE TABLE IF NOT EXISTS folder_rule_runs (
            id TEXT PRIMARY KEY,
            rule_id TEXT NOT NULL,
            period_key TEXT NOT NULL,
            trigger TEXT NOT NULL DEFAULT 'schedule',
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            meeting_count INTEGER NOT NULL DEFAULT 0,
            output_id TEXT,
            detail TEXT NOT NULL DEFAULT '{}',
            attempts INTEGER NOT NULL DEFAULT 1,
            UNIQUE(rule_id, period_key)
        );
        CREATE INDEX IF NOT EXISTS idx_folder_rule_runs_rule
            ON folder_rule_runs(rule_id, started_at DESC);
        CREATE TABLE IF NOT EXISTS folder_rule_items (
            rule_id TEXT NOT NULL,
            meeting_id TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '{}',
            at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(rule_id, meeting_id, action)
        );",
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRule {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub enabled: bool,
    /// Frontend-owned JSON (schedule + window + actions).
    pub config: String,
    pub last_run_at: Option<i64>,
    pub last_period: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRuleRun {
    pub id: String,
    pub rule_id: String,
    pub period_key: String,
    /// "schedule" | "manual"
    pub trigger: String,
    /// "running" | "done" | "empty" | "failed"
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub meeting_count: i64,
    pub output_id: Option<String>,
    /// JSON tally/error written by the runner.
    pub detail: String,
    pub attempts: i64,
}

/// A lightweight in-folder meeting row (no transcript, capped summary) plus
/// the time it was FILED into its folder: the auto-sort / hand-move ledger's
/// `meeting_sort.updated_at` when the meeting has an auto/manual row, else its
/// `created_at` (recorded straight into the folder).
#[derive(Debug, Clone, Serialize)]
pub struct FolderRuleMeeting {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub created_at: i64,
    pub filed_at: i64,
    pub summary: String,
}

/// A digest output joined with its rule (the folder view's "Folder reports").
#[derive(Debug, Clone, Serialize)]
pub struct FolderReport {
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub project_id: String,
    pub title: String,
    pub body_md: String,
    pub generated_at: i64,
    pub meeting_count: i64,
    pub scope_label: String,
}

const RULE_COLS: &str =
    "id,project_id,name,enabled,config,last_run_at,last_period,created_at,updated_at";
const RUN_COLS: &str = "id,rule_id,period_key,trigger,status,started_at,finished_at,meeting_count,output_id,detail,attempts";

fn map_rule(r: &rusqlite::Row) -> rusqlite::Result<FolderRule> {
    Ok(FolderRule {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        enabled: r.get::<_, i64>(3)? != 0,
        config: r.get(4)?,
        last_run_at: r.get(5)?,
        last_period: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

fn map_run(r: &rusqlite::Row) -> rusqlite::Result<FolderRuleRun> {
    Ok(FolderRuleRun {
        id: r.get(0)?,
        rule_id: r.get(1)?,
        period_key: r.get(2)?,
        trigger: r.get(3)?,
        status: r.get(4)?,
        started_at: r.get(5)?,
        finished_at: r.get(6)?,
        meeting_count: r.get(7)?,
        output_id: r.get(8)?,
        detail: r.get(9)?,
        attempts: r.get(10)?,
    })
}

/// Rules for one folder, or every rule (`None`, used by the scheduler).
pub fn list_rules(conn: &Connection, project_id: Option<&str>) -> Result<Vec<FolderRule>, String> {
    let sql = match project_id {
        Some(_) => format!("SELECT {RULE_COLS} FROM folder_rules WHERE project_id=?1 ORDER BY created_at"),
        None => format!("SELECT {RULE_COLS} FROM folder_rules ORDER BY created_at"),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match project_id {
        Some(p) => stmt.query_map([p], map_rule),
        None => stmt.query_map([], map_rule),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Upsert (empty id → create). Never touches last_run_at / last_period: those
/// are owned by the run ledger (`finish_run`).
pub fn save_rule(conn: &Connection, mut rule: FolderRule) -> Result<FolderRule, String> {
    let now = now_millis();
    if rule.id.is_empty() {
        rule.id = gen_id("frule");
        rule.created_at = now;
        rule.last_run_at = None;
        rule.last_period = None;
    }
    rule.updated_at = now;
    conn.execute(
        "INSERT INTO folder_rules(id,project_id,name,enabled,config,last_run_at,last_period,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET
           project_id=?2, name=?3, enabled=?4, config=?5, updated_at=?9",
        rusqlite::params![
            rule.id,
            rule.project_id,
            rule.name,
            rule.enabled as i64,
            rule.config,
            rule.last_run_at,
            rule.last_period,
            rule.created_at,
            rule.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    get_rule(conn, &rule.id)?.ok_or_else(|| "rule vanished after save".to_string())
}

pub fn get_rule(conn: &Connection, id: &str) -> Result<Option<FolderRule>, String> {
    conn.query_row(
        &format!("SELECT {RULE_COLS} FROM folder_rules WHERE id=?1"),
        [id],
        map_rule,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Delete a rule with its run history, item ledger and digest outputs.
pub fn delete_rule(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for sql in [
        "DELETE FROM report_outputs WHERE report_id=?1",
        "DELETE FROM folder_rule_items WHERE rule_id=?1",
        "DELETE FROM folder_rule_runs WHERE rule_id=?1",
        "DELETE FROM folder_rules WHERE id=?1",
    ] {
        tx.execute(sql, [id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn get_run(conn: &Connection, rule_id: &str, period_key: &str) -> Result<Option<FolderRuleRun>, String> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM folder_rule_runs WHERE rule_id=?1 AND period_key=?2"),
        [rule_id, period_key],
        map_run,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Result of a claim: the run to execute, or why there is none.
#[derive(Debug, Clone, Serialize)]
pub struct ClaimOutcome {
    pub run: Option<FolderRuleRun>,
    /// True when refused because another run of this rule (any trigger,
    /// any period) is still in flight — the UI says "already running".
    pub busy: bool,
}

/// Rule-level in-flight guard + period claim. Refuses (busy) while any run of
/// the rule is "running" and younger than the stale cutoff, so Run now can't
/// overlap a scheduled run or another Run now. Older "running" rows are
/// abandoned runs (app quit mid-run): they are closed as failed and taken over.
pub fn claim_run(
    conn: &Connection,
    rule_id: &str,
    period_key: &str,
    trigger: &str,
    now: i64,
) -> Result<ClaimOutcome, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let in_flight: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM folder_rule_runs
             WHERE rule_id=?1 AND status='running' AND started_at >= ?2",
            rusqlite::params![rule_id, now - STALE_RUNNING_MS],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if in_flight > 0 {
        return Ok(ClaimOutcome { run: None, busy: true });
    }
    // Close abandoned runs of OTHER periods (this period's stale row is
    // re-claimed below, keeping its attempt count).
    tx.execute(
        "UPDATE folder_rule_runs
         SET status='failed', finished_at=?3,
             detail='{\"error\":\"Abandoned: the app quit while this run was in progress.\"}'
         WHERE rule_id=?1 AND status='running' AND started_at < ?2 AND period_key<>?4",
        rusqlite::params![rule_id, now - STALE_RUNNING_MS, now, period_key],
    )
    .map_err(|e| e.to_string())?;
    let run = claim_period(&tx, rule_id, period_key, trigger, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ClaimOutcome { run, busy: false })
}

/// Claim one period. Returns the new/re-claimed run, or `None` when the period
/// is already done / empty / out of retries — "a period runs once".
fn claim_period(
    conn: &Connection,
    rule_id: &str,
    period_key: &str,
    trigger: &str,
    now: i64,
) -> Result<Option<FolderRuleRun>, String> {
    let id = gen_id("frrun");
    let inserted = conn
        .execute(
            "INSERT INTO folder_rule_runs(id,rule_id,period_key,trigger,status,started_at,attempts)
             VALUES(?1,?2,?3,?4,'running',?5,1)
             ON CONFLICT(rule_id, period_key) DO NOTHING",
            rusqlite::params![id, rule_id, period_key, trigger, now],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 1 {
        return get_run(conn, rule_id, period_key);
    }
    let Some(existing) = get_run(conn, rule_id, period_key)? else {
        return Ok(None);
    };
    let retryable = (existing.status == "failed" && existing.attempts < MAX_ATTEMPTS)
        || (existing.status == "running" && now - existing.started_at > STALE_RUNNING_MS);
    if !retryable {
        return Ok(None);
    }
    // Guard the re-claim on the state we just read, so two racing ticks can't
    // both re-claim the same failed period.
    let changed = conn
        .execute(
            "UPDATE folder_rule_runs
             SET status='running', started_at=?3, finished_at=NULL, attempts=attempts+1
             WHERE rule_id=?1 AND period_key=?2 AND status=?4 AND attempts=?5",
            rusqlite::params![rule_id, period_key, now, existing.status, existing.attempts],
        )
        .map_err(|e| e.to_string())?;
    if changed == 1 {
        get_run(conn, rule_id, period_key)
    } else {
        Ok(None)
    }
}

/// Close a run. A "done"/"empty" run advances the rule's `last_run_at` (the
/// "new since last run" baseline) to the run's start; a scheduled one also
/// records `last_period`. A "failed" run leaves the rule untouched so the
/// window does not skip meetings.
pub fn finish_run(
    conn: &Connection,
    run_id: &str,
    status: &str,
    meeting_count: i64,
    output_id: Option<&str>,
    detail: &str,
) -> Result<(), String> {
    if !matches!(status, "done" | "empty" | "failed") {
        return Err(format!("unknown run status: {status}"));
    }
    let run = conn
        .query_row(
            &format!("SELECT {RUN_COLS} FROM folder_rule_runs WHERE id=?1"),
            [run_id],
            map_run,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such run: {run_id}"))?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE folder_rule_runs SET status=?2, finished_at=?3, meeting_count=?4, output_id=?5, detail=?6
         WHERE id=?1",
        rusqlite::params![run_id, status, now_millis(), meeting_count, output_id, detail],
    )
    .map_err(|e| e.to_string())?;
    if status != "failed" {
        if run.trigger == "schedule" {
            tx.execute(
                "UPDATE folder_rules SET last_run_at=?2, last_period=?3 WHERE id=?1",
                rusqlite::params![run.rule_id, run.started_at, run.period_key],
            )
        } else {
            tx.execute(
                "UPDATE folder_rules SET last_run_at=?2 WHERE id=?1",
                rusqlite::params![run.rule_id, run.started_at],
            )
        }
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Run history, newest first: one rule's, or every rule's (`None`).
pub fn list_runs(conn: &Connection, rule_id: Option<&str>, limit: i64) -> Result<Vec<FolderRuleRun>, String> {
    let sql = match rule_id {
        Some(_) => format!(
            "SELECT {RUN_COLS} FROM folder_rule_runs WHERE rule_id=?1 ORDER BY started_at DESC LIMIT ?2"
        ),
        None => format!("SELECT {RUN_COLS} FROM folder_rule_runs ORDER BY started_at DESC LIMIT ?1"),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match rule_id {
        Some(r) => stmt.query_map(rusqlite::params![r, limit], map_run),
        None => stmt.query_map(rusqlite::params![limit], map_run),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Meetings filed in any of `project_ids`, newest first, with their filed-at.
pub fn folder_meetings(conn: &Connection, project_ids: &[String]) -> Result<Vec<FolderRuleMeeting>, String> {
    if project_ids.is_empty() {
        return Ok(vec![]);
    }
    let marks = vec!["?"; project_ids.len()].join(",");
    let sql = format!(
        "SELECT m.id, m.title, m.project_id, m.created_at,
                COALESCE((SELECT s.updated_at FROM meeting_sort s
                          WHERE s.meeting_id=m.id AND s.status IN ('auto','manual')), m.created_at),
                substr(m.summary,1,4000)
         FROM meetings m WHERE m.project_id IN ({marks}) ORDER BY m.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(project_ids.iter()), |r| {
            Ok(FolderRuleMeeting {
                id: r.get(0)?,
                title: r.get(1)?,
                project_id: r.get(2)?,
                created_at: r.get(3)?,
                filed_at: r.get(4)?,
                summary: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Meeting ids SETTLED for one rule + action: "done", or "gave_up" after
/// MAX_ATTEMPTS failures. Settled items are never attempted again.
pub fn items_done(conn: &Connection, rule_id: &str, action: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT meeting_id FROM folder_rule_items
             WHERE rule_id=?1 AND action=?2 AND status IN ('done','gave_up')",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([rule_id, action], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Meetings with UNFINISHED items for this rule ("failed" with attempts left,
/// or "pending", e.g. a send queued while signed out). Later runs carry them
/// forward even after the "since last run" window has moved past them.
pub fn items_unfinished(conn: &Connection, rule_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT meeting_id FROM folder_rule_items
             WHERE rule_id=?1 AND status IN ('failed','pending')",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([rule_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Record one per-meeting outcome and return the stored status. "failed"
/// counts an attempt; the MAX_ATTEMPTS-th failure is stored as "gave_up"
/// (shown in history, never retried). "pending" (blocked, e.g. signed out)
/// doesn't count an attempt. "done" settles the item.
pub fn record_item(
    conn: &Connection,
    rule_id: &str,
    meeting_id: &str,
    action: &str,
    status: &str,
    detail: &str,
) -> Result<String, String> {
    if !matches!(status, "done" | "failed" | "pending") {
        return Err(format!("unknown item status: {status}"));
    }
    let prev_attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM folder_rule_items WHERE rule_id=?1 AND meeting_id=?2 AND action=?3",
            [rule_id, meeting_id, action],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let attempts = if status == "failed" { prev_attempts + 1 } else { prev_attempts };
    let stored = if status == "failed" && attempts >= MAX_ATTEMPTS { "gave_up" } else { status };
    conn.execute(
        "INSERT INTO folder_rule_items(rule_id,meeting_id,action,status,detail,at,attempts)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(rule_id,meeting_id,action) DO UPDATE SET status=?4, detail=?5, at=?6, attempts=?7",
        rusqlite::params![rule_id, meeting_id, action, stored, detail, now_millis(), attempts],
    )
    .map_err(|e| e.to_string())?;
    Ok(stored.to_string())
}

/// Digest outputs of every rule on these folders, newest first.
pub fn folder_reports(conn: &Connection, project_ids: &[String], limit: i64) -> Result<Vec<FolderReport>, String> {
    if project_ids.is_empty() {
        return Ok(vec![]);
    }
    let marks = vec!["?"; project_ids.len()].join(",");
    let sql = format!(
        "SELECT o.id, o.report_id, r.name, r.project_id, o.title, o.body_md, o.generated_at,
                o.meeting_count, o.scope_label
         FROM report_outputs o JOIN folder_rules r ON r.id=o.report_id
         WHERE r.project_id IN ({marks})
         ORDER BY o.generated_at DESC LIMIT {}",
        limit.clamp(1, 500)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(project_ids.iter()), |r| {
            Ok(FolderReport {
                id: r.get(0)?,
                rule_id: r.get(1)?,
                rule_name: r.get(2)?,
                project_id: r.get(3)?,
                title: r.get(4)?,
                body_md: r.get(5)?,
                generated_at: r.get(6)?,
                meeting_count: r.get(7)?,
                scope_label: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn folder_rules_list(
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FolderRule>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    list_rules(&conn, project_id.as_deref())
}

/// One rule as stored now (None when deleted). The runner re-reads the rule
/// right before claiming so a stale snapshot never runs.
#[tauri::command]
pub fn folder_rule_get(id: String, state: State<'_, AppState>) -> Result<Option<FolderRule>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    get_rule(&conn, &id)
}

#[tauri::command]
pub fn folder_rule_save(rule: FolderRule, state: State<'_, AppState>) -> Result<FolderRule, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    save_rule(&conn, rule)
}

#[tauri::command]
pub fn folder_rule_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    delete_rule(&conn, &id)
}

#[tauri::command]
pub fn folder_rule_claim(
    rule_id: String,
    period_key: String,
    trigger: String,
    state: State<'_, AppState>,
) -> Result<ClaimOutcome, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    claim_run(&conn, &rule_id, &period_key, &trigger, now_millis())
}

#[tauri::command]
pub fn folder_rule_finish(
    run_id: String,
    status: String,
    meeting_count: i64,
    output_id: Option<String>,
    detail: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    finish_run(&conn, &run_id, &status, meeting_count, output_id.as_deref(), &detail)
}

#[tauri::command]
pub fn folder_rule_runs(
    rule_id: Option<String>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<FolderRuleRun>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    list_runs(&conn, rule_id.as_deref(), limit)
}

#[tauri::command]
pub fn folder_rule_meetings(
    project_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FolderRuleMeeting>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    folder_meetings(&conn, &project_ids)
}

#[tauri::command]
pub fn folder_rule_items_done(
    rule_id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    items_done(&conn, &rule_id, &action)
}

#[tauri::command]
pub fn folder_rule_record_item(
    rule_id: String,
    meeting_id: String,
    action: String,
    status: String,
    detail: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    let meeting_id = crate::store::resolve_meeting_id(&conn, &meeting_id);
    record_item(&conn, &rule_id, &meeting_id, &action, &status, &detail)
}

#[tauri::command]
pub fn folder_rule_items_unfinished(
    rule_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    items_unfinished(&conn, &rule_id)
}

#[tauri::command]
pub fn folder_reports_list(
    project_ids: Vec<String>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<FolderReport>, String> {
    let conn = state.db.lock().map_err(|_| "db poisoned")?;
    folder_reports(&conn, &project_ids, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn rule(conn: &Connection) -> FolderRule {
        save_rule(
            conn,
            FolderRule {
                id: String::new(),
                project_id: "p1".into(),
                name: "Weekly digest".into(),
                enabled: true,
                config: "{}".into(),
                last_run_at: None,
                last_period: None,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap()
    }

    fn claim(conn: &Connection, rule_id: &str, key: &str, trigger: &str, now: i64) -> Option<FolderRuleRun> {
        claim_run(conn, rule_id, key, trigger, now).unwrap().run
    }

    #[test]
    fn run_now_is_refused_while_a_run_of_the_rule_is_in_flight() {
        let conn = mem();
        let r = rule(&conn);
        let t0 = 10 * STALE_RUNNING_MS;
        let sched = claim(&conn, &r.id, "weekly:2026-10-05", "schedule", t0).unwrap();
        // A manual run (or a second manual run) while the scheduled one runs.
        let busy = claim_run(&conn, &r.id, "manual:1", "manual", t0 + 1000).unwrap();
        assert!(busy.busy && busy.run.is_none());
        finish_run(&conn, &sched.id, "done", 1, None, "{}").unwrap();
        // Free again; the manual run does not consume a scheduled period.
        let manual = claim(&conn, &r.id, "manual:2", "manual", t0 + 2000).unwrap();
        let busy2 = claim_run(&conn, &r.id, "weekly:2026-10-12", "schedule", t0 + 3000).unwrap();
        assert!(busy2.busy);
        finish_run(&conn, &manual.id, "done", 1, None, "{}").unwrap();
        assert!(claim(&conn, &r.id, "weekly:2026-10-12", "schedule", t0 + 4000).is_some());
    }

    #[test]
    fn an_abandoned_run_is_taken_over_after_the_stale_cutoff() {
        let conn = mem();
        let r = rule(&conn);
        let t0 = 10 * STALE_RUNNING_MS;
        let stuck = claim(&conn, &r.id, "manual:1", "manual", t0).unwrap();
        assert!(claim_run(&conn, &r.id, "manual:2", "manual", t0 + STALE_RUNNING_MS - 1).unwrap().busy);
        let next = claim(&conn, &r.id, "manual:3", "manual", t0 + STALE_RUNNING_MS + 1).unwrap();
        assert_ne!(next.id, stuck.id);
        let old = list_runs(&conn, Some(&r.id), 10).unwrap();
        assert_eq!(old.iter().find(|x| x.id == stuck.id).unwrap().status, "failed");
    }

    #[test]
    fn failed_items_are_carried_forward_then_give_up_after_the_cap() {
        let conn = mem();
        let r = rule(&conn);
        assert_eq!(record_item(&conn, &r.id, "m1", "tasks", "failed", "{}").unwrap(), "failed");
        assert_eq!(record_item(&conn, &r.id, "m2", "send:atlas_pack", "pending", "{}").unwrap(), "pending");
        record_item(&conn, &r.id, "m3", "tasks", "done", "{}").unwrap();
        let mut open = items_unfinished(&conn, &r.id).unwrap();
        open.sort();
        assert_eq!(open, vec!["m1".to_string(), "m2".to_string()]);
        // Pending never counts an attempt; failures do, up to the cap.
        for _ in 0..5 {
            record_item(&conn, &r.id, "m2", "send:atlas_pack", "pending", "{}").unwrap();
        }
        assert_eq!(record_item(&conn, &r.id, "m1", "tasks", "failed", "{}").unwrap(), "failed");
        assert_eq!(record_item(&conn, &r.id, "m1", "tasks", "failed", "{}").unwrap(), "gave_up");
        assert_eq!(items_unfinished(&conn, &r.id).unwrap(), vec!["m2".to_string()]);
        let mut settled = items_done(&conn, &r.id, "tasks").unwrap();
        settled.sort();
        assert_eq!(settled, vec!["m1".to_string(), "m3".to_string()]);
        // A pending send that goes through settles.
        record_item(&conn, &r.id, "m2", "send:atlas_pack", "done", "{}").unwrap();
        assert!(items_unfinished(&conn, &r.id).unwrap().is_empty());
    }

    #[test]
    fn get_rule_sees_pauses_and_deletes_made_after_a_snapshot() {
        let conn = mem();
        let r = rule(&conn);
        let snapshot = list_rules(&conn, None).unwrap();
        save_rule(&conn, FolderRule { enabled: false, ..r.clone() }).unwrap();
        assert!(snapshot[0].enabled);
        assert!(!get_rule(&conn, &r.id).unwrap().unwrap().enabled);
        delete_rule_rows_for_test(&conn, &r.id);
        assert!(get_rule(&conn, &r.id).unwrap().is_none());
    }

    // `delete_rule` also clears report_outputs, which the in-memory test DB
    // (folder_rules tables only) doesn't have.
    fn delete_rule_rows_for_test(conn: &Connection, id: &str) {
        conn.execute("DELETE FROM folder_rules WHERE id=?1", [id]).unwrap();
    }

    #[test]
    fn a_period_is_claimed_once() {
        let conn = mem();
        let r = rule(&conn);
        let run = claim(&conn, &r.id, "weekly:2026-10-05", "schedule", 1000).unwrap();
        assert!(claim(&conn, &r.id, "weekly:2026-10-05", "schedule", 2000).is_none());
        finish_run(&conn, &run.id, "done", 3, None, "{}").unwrap();
        assert!(claim(&conn, &r.id, "weekly:2026-10-05", "schedule", 3000).is_none());
        let after = get_rule(&conn, &r.id).unwrap().unwrap();
        assert_eq!(after.last_run_at, Some(1000));
        assert_eq!(after.last_period.as_deref(), Some("weekly:2026-10-05"));
    }

    #[test]
    fn failed_runs_retry_up_to_the_cap_and_do_not_advance_the_window() {
        let conn = mem();
        let r = rule(&conn);
        for attempt in 1..=MAX_ATTEMPTS {
            let run = claim(&conn, &r.id, "daily:2026-10-05", "schedule", attempt).unwrap();
            assert_eq!(run.attempts, attempt);
            finish_run(&conn, &run.id, "failed", 0, None, "{}").unwrap();
        }
        assert!(claim(&conn, &r.id, "daily:2026-10-05", "schedule", 99).is_none());
        assert_eq!(get_rule(&conn, &r.id).unwrap().unwrap().last_run_at, None);
    }

    #[test]
    fn manual_runs_move_the_baseline_but_not_the_period() {
        let conn = mem();
        let r = rule(&conn);
        let run = claim(&conn, &r.id, "manual:5", "manual", 5).unwrap();
        finish_run(&conn, &run.id, "empty", 0, None, "{}").unwrap();
        let after = get_rule(&conn, &r.id).unwrap().unwrap();
        assert_eq!(after.last_run_at, Some(5));
        assert_eq!(after.last_period, None);
    }
}
