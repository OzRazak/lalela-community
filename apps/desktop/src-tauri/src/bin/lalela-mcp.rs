//! Lalela MCP server (stdio). Exposes the user's meetings to MCP clients like
//! Claude Desktop / Cursor. Self-contained: reads the same SQLite index the app
//! writes, speaks newline-delimited JSON-RPC 2.0. No AI/audio deps.
//!
//! DB path: $LALELA_DB, else ~/Library/Application Support/<bundle id>/lalela.db
//! (`digital.auxo.lalela` official, `io.github.ozrazak.lalela-community` Community).

use std::io::{BufRead, Write};

use rusqlite::Connection;
use serde_json::{json, Value};

fn db_path() -> String {
    if let Ok(p) = std::env::var("LALELA_DB") {
        return p;
    }
    // Pre-rename MCP configs may still set CLIO_DB; honor it as a fallback.
    if let Ok(p) = std::env::var("CLIO_DB") {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{home}/Library/Application Support/{APP_IDENTIFIER}/lalela.db")
}

/// Bundle identifier = app-data folder name. Must match tauri.conf.json
/// (official) / tauri.community.conf.json (Community edition, build.rs cfg).
#[cfg(not(lalela_community))]
const APP_IDENTIFIER: &str = "digital.auxo.lalela";
#[cfg(lalela_community)]
const APP_IDENTIFIER: &str = "io.github.ozrazak.lalela-community";

fn open() -> Option<Connection> {
    Connection::open(db_path()).ok()
}

fn fmt_ts(ms: i64) -> String {
    // Seconds since epoch as a coarse, dependency-free label.
    format!("epoch_ms={ms}")
}

fn transcript_text(json_str: &str) -> String {
    let v: Value = serde_json::from_str(json_str).unwrap_or(Value::Null);
    let mut out = String::new();
    if let Some(arr) = v.as_array() {
        for seg in arr {
            let t0 = seg.get("t0_ms").and_then(|x| x.as_i64()).unwrap_or(0);
            let total = t0.max(0) / 1000;
            let stamp = format!("{}:{:02}", total / 60, total % 60);
            let spk = seg.get("speaker").and_then(|x| x.as_str()).unwrap_or("?");
            let text = seg.get("text").and_then(|x| x.as_str()).unwrap_or("");
            out.push_str(&format!("[{stamp}] {spk}: {text}\n"));
        }
    }
    out
}

fn tool_search(conn: &Connection, query: &str) -> String {
    let like = format!("%{query}%");
    let mut stmt = match conn.prepare(
        "SELECT id,title,created_at,summary FROM meetings
         WHERE title LIKE ?1 OR transcript_json LIKE ?1 OR summary LIKE ?1 OR notes LIKE ?1
         ORDER BY created_at DESC LIMIT 20",
    ) {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };
    let rows = stmt
        .query_map([like], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let created: i64 = r.get(2)?;
            let summary: String = r.get(3)?;
            Ok(format!(
                "- {title} (id={id}, {}, has_summary={})",
                fmt_ts(created),
                !summary.trim().is_empty()
            ))
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(v) if v.is_empty() => "No matching meetings.".into(),
        Ok(v) => v.join("\n"),
        Err(e) => format!("error: {e}"),
    }
}

fn tool_list(conn: &Connection) -> String {
    let mut stmt = match conn
        .prepare("SELECT id,title,created_at FROM meetings ORDER BY created_at DESC LIMIT 50")
    {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let created: i64 = r.get(2)?;
            Ok(format!("- {title} (id={id}, {})", fmt_ts(created)))
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(v) if v.is_empty() => "No meetings yet.".into(),
        Ok(v) => v.join("\n"),
        Err(e) => format!("error: {e}"),
    }
}

fn tool_get(conn: &Connection, id: &str) -> String {
    let row = conn.query_row(
        "SELECT title,created_at,summary,notes,transcript_json FROM meetings WHERE id=?1",
        [id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        },
    );
    match row {
        Ok((title, created, summary, notes, transcript)) => format!(
            "# {title}\n({})\n\n## Summary\n{}\n\n## Notes\n{}\n\n## Transcript\n{}",
            fmt_ts(created),
            if summary.trim().is_empty() { "(none)" } else { &summary },
            if notes.trim().is_empty() { "(none)" } else { &notes },
            transcript_text(&transcript)
        ),
        Err(e) => format!("error: {e}"),
    }
}

fn tool_projects(conn: &Connection) -> String {
    let mut stmt = match conn.prepare("SELECT id,name FROM projects ORDER BY name") {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };
    let rows = stmt
        .query_map([], |r| {
            Ok(format!("- {} (id={})", r.get::<_, String>(1)?, r.get::<_, String>(0)?))
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(v) if v.is_empty() => "No projects.".into(),
        Ok(v) => v.join("\n"),
        Err(e) => format!("error: {e}"),
    }
}

fn tools_schema() -> Value {
    json!({
        "tools": [
            {
                "name": "search_meetings",
                "description": "Full-text search the user's meetings (title, transcript, summary, notes). Returns matching meetings with their ids.",
                "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
            },
            {
                "name": "list_meetings",
                "description": "List the user's most recent meetings with their ids.",
                "inputSchema": {"type": "object", "properties": {}}
            },
            {
                "name": "get_meeting",
                "description": "Get a meeting's full summary, notes and transcript by id.",
                "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
            },
            {
                "name": "list_projects",
                "description": "List the user's projects.",
                "inputSchema": {"type": "object", "properties": {}}
            }
        ]
    })
}

fn call_tool(conn: &Connection, name: &str, args: &Value) -> String {
    match name {
        "search_meetings" => tool_search(conn, args.get("query").and_then(|v| v.as_str()).unwrap_or("")),
        "list_meetings" => tool_list(conn),
        "get_meeting" => tool_get(conn, args.get("id").and_then(|v| v.as_str()).unwrap_or("")),
        "list_projects" => tool_projects(conn),
        other => format!("error: unknown tool '{other}'"),
    }
}

fn send(out: &mut impl Write, value: Value) {
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

        // Notifications (no id) get no response.
        let is_notification = id.is_none();

        match method {
            "initialize" => send(
                &mut stdout,
                json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "lalela", "version": "0.1.0"}
                    }
                }),
            ),
            "tools/list" => send(
                &mut stdout,
                json!({"jsonrpc": "2.0", "id": id, "result": tools_schema()}),
            ),
            "tools/call" => {
                let name = msg
                    .get("params")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let empty = json!({});
                let args = msg
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .unwrap_or(&empty);
                let text = match open() {
                    Some(conn) => call_tool(&conn, name, args),
                    None => "error: could not open Lalela database (is the app installed and has it recorded a meeting?)".into(),
                };
                send(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {"content": [{"type": "text", "text": text}]}
                    }),
                );
            }
            "ping" => send(&mut stdout, json!({"jsonrpc": "2.0", "id": id, "result": {}})),
            _ if !is_notification => send(
                &mut stdout,
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}}),
            ),
            _ => {}
        }
    }
}
