//! Demo-data seeder — fills an ISOLATED Lalela data dir with clearly-fictional
//! meetings, tags, automations, run history, and reports so demo videos and
//! screenshots have a lived-in app to show. It NEVER ships in the bundle (it's a
//! cargo example, not a binary target) and NEVER touches the cloud.
//!
//! Run it against a scratch dir — the `LALELA_DATA_DIR` override (see
//! `lalela_lib::paths`) points the whole instance there:
//!
//! ```sh
//! LALELA_DATA_DIR=$HOME/Developer/lalela-demo-data cargo run --example seed_demo
//! # then launch the app against the same dir:
//! LALELA_DATA_DIR=$HOME/Developer/lalela-demo-data pnpm tauri dev
//! ```
//!
//! It refuses to run without `LALELA_DATA_DIR`, and it reuses the app's own
//! `store::` functions to open/migrate the DB and insert every row — so it can
//! never drift from the live schema. Re-running it resets the seed dataset
//! (the target dir is meant to be a throwaway), so it's safely repeatable.
//!
//! All names are invented. No real client, person, or deal appears here.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use lalela_lib::paths;
use lalela_lib::store::{
    self, Attendee, Automation, AutomationRun, NewActionItem, Report, ReportOutput,
    SaveMeetingInput, Tag,
};
use lalela_lib::transcribe::Segment;
use rusqlite::{params, Connection};

const DAY_MS: i64 = 86_400_000;
const MIN_MS: i64 = 60_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One transcript line. Six seconds each is plenty for a readable demo.
fn seg(t0: i64, speaker: &str, text: &str) -> Segment {
    Segment {
        t0_ms: t0,
        t1_ms: t0 + 6_000,
        text: text.to_string(),
        speaker: speaker.to_string(),
    }
}

fn attendee(name: &str, email: &str) -> Attendee {
    Attendee {
        name: Some(name.to_string()),
        email: Some(email.to_string()),
    }
}

/// insert_meeting always stamps `created_at = now`; a demo wants the six
/// meetings spread over the last fortnight. Backdate the row after the real
/// write path has run (folders + FTS are already correct).
fn backdate(conn: &Connection, meeting_id: &str, created_at: i64) {
    conn.execute(
        "UPDATE meetings SET created_at=?2 WHERE id=?1",
        params![meeting_id, created_at],
    )
    .expect("backdate meeting");
}

fn main() {
    let data_dir = paths::data_dir_override().unwrap_or_else(|| {
        eprintln!(
            "refusing to run: set LALELA_DATA_DIR to an isolated scratch dir first, e.g.\n  \
             LALELA_DATA_DIR=$HOME/Developer/lalela-demo-data cargo run --example seed_demo"
        );
        std::process::exit(1);
    });

    println!("Seeding demo data into {}", data_dir.display());

    // The meeting Markdown lives INSIDE the scratch dir so nothing lands in the
    // user's real Documents folder. Pin it explicitly via the save_folder
    // setting so the app reads the meetings back from exactly here.
    let save_root = data_dir.join("Lalela Meetings");
    // Fresh dataset on every run (the target is a throwaway demo dir).
    let _ = std::fs::remove_dir_all(&save_root);

    let conn = store::open(&data_dir.join("lalela.db")).expect("open db");
    reset_seed_tables(&conn);
    store::set_setting(&conn, "save_folder", &save_root.to_string_lossy()).expect("set save_folder");

    // A workspace card so the "who we are" context surfaces in the demo too.
    let _ = store::write_workspace_md(
        &save_root,
        "# Northstar Labs\n\nWe help mid-market teams roll out on-device AI. \
         Key people: Alex Rivera (Sales), Priya Shah (Product), Sam Patel (Engineering).\n",
    );

    // ---- Folders ---- (bind the ids; that's all the seeder needs)
    let sales = store::create_project(&conn, "Sales", None).expect("Sales folder").id;
    let team = store::create_project(&conn, "Team", None).expect("Team folder").id;
    let hiring = store::create_project(&conn, "Hiring", None).expect("Hiring folder").id;

    // ---- Tags ----
    let sales_tag = save_tag(&conn, "Sales Discussion", "#e0723c");
    let standup_tag = save_tag(&conn, "Standup", "#3c8ce0");
    let product_tag = save_tag(&conn, "Product", "#7c6cf5");
    let hiring_tag = save_tag(&conn, "Hiring", "#3ca87a");
    let customer_tag = save_tag(&conn, "Customer", "#c94f8a");

    // ---- Automations ----
    // Sales Discussion: AI-classification trigger → (ask-mode) CRM send.
    store::upsert_automation(
        &conn,
        &Automation {
            tag_id: sales_tag.clone(),
            enabled: true,
            match_json: "{}".to_string(),
            ai_classify_json: serde_json::json!({
                "enabled": true,
                "hint": "A sales conversation with a prospect or customer: discovery, \
                         pricing, renewals, or deal progression."
            })
            .to_string(),
            actions_json: serde_json::json!({
                "sends": [{
                    "destination": "artemis",
                    "mode": "ask",
                    "target": { "type": "deal", "id": "demo-deal-001", "name": "Acme Renewables — Renewal" }
                }]
            })
            .to_string(),
        },
    )
    .expect("sales automation");

    // Standup: title-match trigger → file into the Team folder + draft a summary.
    store::upsert_automation(
        &conn,
        &Automation {
            tag_id: standup_tag.clone(),
            enabled: true,
            match_json: serde_json::json!({
                "title_keywords": ["standup", "stand-up", "daily"]
            })
            .to_string(),
            ai_classify_json: serde_json::json!({ "enabled": false }).to_string(),
            actions_json: serde_json::json!({
                "project_id": team,
                "summary_prompt_text": "Summarise this standup as three short lists: \
                    Yesterday, Today, Blockers. Five bullets max.",
                "summary_model": ""
            })
            .to_string(),
        },
    )
    .expect("standup automation");

    let now = now_ms();

    // ---- Meetings ----
    // Each: (title, project, backdate days, tags[(tag_id, added_by)], attendees, transcript, summary)
    let acme_at = now - 13 * DAY_MS + 9 * 60 * MIN_MS;
    let acme = seed_meeting(
        &conn,
        &save_root,
        "Acme Renewables — Q3 kickoff",
        Some(&sales),
        acme_at,
        &[(&sales_tag, "ai")],
        Some(vec![
            attendee("Alex Rivera", "alex@northstarlabs.example"),
            attendee("Dana Whitfield", "dana@acme-renewables.example"),
        ]),
        vec![
            seg(0, "Alex Rivera", "Thanks for making time — excited to kick off Q3 with the Acme Renewables team."),
            seg(7_000, "Dana Whitfield", "Likewise. We want the rollout live before our board review in September."),
            seg(15_000, "Alex Rivera", "Doable. Let's lock scope today: which teams go first?"),
            seg(23_000, "Dana Whitfield", "Field operations and the analytics group. About 140 seats combined."),
            seg(32_000, "Alex Rivera", "Great. The renewal covers both plus the priority-support add-on."),
            seg(41_000, "Dana Whitfield", "We'll need the updated proposal with the new seat count to sign off."),
            seg(50_000, "Alex Rivera", "I'll send it this week. Any procurement steps we should plan around?"),
            seg(59_000, "Dana Whitfield", "Legal will want the MSA refreshed, and finance signs after that."),
            seg(68_000, "Alex Rivera", "Understood. I'll confirm the Q3 capacity numbers before the proposal goes out."),
            seg(77_000, "Dana Whitfield", "Perfect. Let's aim to have everything signed within three weeks."),
        ],
        "## Acme Renewables — Q3 kickoff\n\n\
         Kickoff for the Acme Renewables renewal (140 seats across field operations and analytics) \
         plus the priority-support add-on. Target: signed before the September board review.\n\n\
         **Decisions**\n- Field ops + analytics go first (~140 seats)\n- Renewal includes priority support\n\n\
         **Next steps**\n- Alex to send the updated proposal with the new seat count\n- Refresh the MSA for legal, then finance sign-off\n",
    );
    add_board_item(&conn, &acme, "Send updated renewal proposal", Some("Alex Rivera"), Some("2026-07-18"), "approved");
    add_board_item(&conn, &acme, "Confirm Q3 capacity numbers", Some("Sam Patel"), None, "in_progress");

    let northwind_at = now - 11 * DAY_MS + 10 * 60 * MIN_MS;
    let northwind = seed_meeting(
        &conn,
        &save_root,
        "Northwind Retail discovery call",
        Some(&sales),
        northwind_at,
        &[(&sales_tag, "ai")],
        Some(vec![
            attendee("Alex Rivera", "alex@northstarlabs.example"),
            attendee("Marcus Fenn", "marcus@northwind-retail.example"),
        ]),
        vec![
            seg(0, "Marcus Fenn", "We're evaluating a few notetakers — privacy is the sticking point for us."),
            seg(8_000, "Alex Rivera", "That's our whole premise: transcription and AI run on-device by default."),
            seg(17_000, "Marcus Fenn", "So nothing leaves the laptop unless we choose to sync?"),
            seg(25_000, "Alex Rivera", "Correct. Sync and sharing are opt-in, and voiceprints never leave the device."),
            seg(34_000, "Marcus Fenn", "Good. We'd also need a security whitepaper for our infosec review."),
            seg(43_000, "Alex Rivera", "I'll share it today. What's your rollout timeline looking like?"),
            seg(52_000, "Marcus Fenn", "If the review passes, we'd pilot with twenty people next month."),
            seg(61_000, "Alex Rivera", "Let's book a technical deep-dive with your infosec lead to speed that up."),
            seg(70_000, "Marcus Fenn", "Works for me. Send the whitepaper and a couple of times."),
        ],
        "## Northwind Retail — discovery call\n\n\
         Discovery with Northwind Retail. Their decision hinges on privacy: on-device processing, \
         opt-in sync, local-only voiceprints. A pilot of ~20 seats follows a passed infosec review.\n\n\
         **Next steps**\n- Share the security whitepaper\n- Schedule a technical deep-dive with their infosec lead\n",
    );
    add_board_item(&conn, &northwind, "Share security whitepaper", Some("Jordan Lee"), Some("2026-07-15"), "approved");
    add_board_item(&conn, &northwind, "Schedule technical deep-dive", Some("Alex Rivera"), None, "done");

    let standup_at = now - 9 * DAY_MS + 9 * 60 * MIN_MS + 30 * MIN_MS;
    let standup = seed_meeting(
        &conn,
        &save_root,
        "Weekly product standup",
        Some(&team),
        standup_at,
        &[(&standup_tag, "rule"), (&product_tag, "manual")],
        None,
        vec![
            seg(0, "Priya Shah", "Quick round. Yesterday I finished the export pipeline refactor."),
            seg(7_000, "Sam Patel", "Nice. I'm still chasing the flaky CI runs on the capture tests."),
            seg(15_000, "Priya Shah", "Today I'm picking up the roadmap doc so we can share it Friday."),
            seg(23_000, "Jordan Lee", "I merged the onboarding tour fixes; QA is verifying now."),
            seg(31_000, "Sam Patel", "Blocker for me is the CI flakiness — it's masking real failures."),
            seg(39_000, "Priya Shah", "Let's pair on it after standup. Anything else blocking anyone?"),
            seg(47_000, "Jordan Lee", "Nothing here. On track for the Friday demo."),
            seg(54_000, "Priya Shah", "Great, short one today. Thanks everyone."),
        ],
        "## Weekly product standup\n\n\
         **Yesterday**\n- Export pipeline refactor landed (Priya)\n- Onboarding tour fixes merged (Jordan)\n\n\
         **Today**\n- Roadmap doc for Friday (Priya)\n- Verify tour fixes in QA (Jordan)\n\n\
         **Blockers**\n- Flaky CI on capture tests is masking real failures (Sam) — pairing after standup\n",
    );
    add_board_item(&conn, &standup, "Unblock CI flakiness on capture tests", Some("Sam Patel"), None, "in_progress");
    add_board_item(&conn, &standup, "Update roadmap doc for Friday", Some("Priya Shah"), Some("2026-07-11"), "approved");

    let atlas_at = now - 6 * DAY_MS + 14 * 60 * MIN_MS;
    let atlas = seed_meeting(
        &conn,
        &save_root,
        "Atlas Logistics pricing review",
        Some(&sales),
        atlas_at,
        &[(&sales_tag, "ai")],
        Some(vec![
            attendee("Alex Rivera", "alex@northstarlabs.example"),
            attendee("Renee Alcott", "renee@atlas-logistics.example"),
        ]),
        vec![
            seg(0, "Renee Alcott", "The per-seat price works, but we scale seasonally and hate paying for idle seats."),
            seg(9_000, "Alex Rivera", "We can move you to the volume tier with a committed floor plus overage."),
            seg(18_000, "Renee Alcott", "What's the floor for a team that swings between eighty and two hundred?"),
            seg(27_000, "Alex Rivera", "A hundred-seat floor with metered overage would fit that curve well."),
            seg(36_000, "Renee Alcott", "That's more palatable. Can you revise the tiers and send updated numbers?"),
            seg(45_000, "Alex Rivera", "Yes. I'll also loop in legal to get the MSA sign-off moving."),
            seg(54_000, "Renee Alcott", "Good. If the numbers land, we can close this quarter."),
            seg(63_000, "Alex Rivera", "Then let's move quickly — revised pricing to you by end of week."),
        ],
        "## Atlas Logistics — pricing review\n\n\
         Atlas scales seasonally (80–200 seats) and pushed back on flat per-seat pricing. \
         Proposed a volume tier: 100-seat committed floor with metered overage.\n\n\
         **Next steps**\n- Revise the pricing tiers and send updated numbers\n- Get legal sign-off on the MSA\n",
    );
    add_board_item(&conn, &atlas, "Revise pricing tiers (volume + overage)", Some("Alex Rivera"), Some("2026-07-12"), "in_progress");
    add_board_item(&conn, &atlas, "Get legal sign-off on the MSA", Some("Jordan Lee"), Some("2026-07-16"), "approved");

    let interview_at = now - 4 * DAY_MS + 11 * 60 * MIN_MS;
    let interview = seed_meeting(
        &conn,
        &save_root,
        "Interview: senior engineer",
        Some(&hiring),
        interview_at,
        &[(&hiring_tag, "manual")],
        None,
        vec![
            seg(0, "Sam Patel", "Thanks for joining. Walk me through a system you're proud of shipping."),
            seg(8_000, "Candidate", "I led an offline-first sync layer — conflict resolution was the hard part."),
            seg(17_000, "Sam Patel", "How did you handle concurrent edits from multiple devices?"),
            seg(26_000, "Candidate", "Per-field last-writer-wins with a vector clock, plus a manual-merge escape hatch."),
            seg(35_000, "Sam Patel", "Good instincts. What would you do differently now?"),
            seg(44_000, "Candidate", "Invest in observability sooner — we were debugging sync blind for too long."),
            seg(53_000, "Sam Patel", "That resonates. We'll send a short take-home and schedule the final round."),
            seg(62_000, "Candidate", "Sounds great, thank you."),
        ],
        "## Interview: senior engineer\n\n\
         Strong signal on offline-first architecture (sync, conflict resolution, vector clocks) \
         and mature on observability trade-offs. Recommend proceeding.\n\n\
         **Next steps**\n- Send the take-home exercise\n- Schedule the final round\n",
    );
    add_board_item(&conn, &interview, "Send take-home exercise + feedback", Some("Sam Patel"), None, "done");
    add_board_item(&conn, &interview, "Schedule final-round panel", Some("Priya Shah"), Some("2026-07-14"), "approved");

    let brightpath_at = now - 2 * DAY_MS + 15 * 60 * MIN_MS;
    let brightpath = seed_meeting(
        &conn,
        &save_root,
        "Customer feedback session — Brightpath",
        None,
        brightpath_at,
        &[(&customer_tag, "manual")],
        Some(vec![
            attendee("Priya Shah", "priya@northstarlabs.example"),
            attendee("Ivy Okafor", "ivy@brightpath.example"),
        ]),
        vec![
            seg(0, "Priya Shah", "We'd love your honest take after a month on Lalela."),
            seg(8_000, "Ivy Okafor", "The transcription accuracy has been excellent, even in noisy rooms."),
            seg(17_000, "Priya Shah", "Wonderful. Where does it fall short for your team?"),
            seg(26_000, "Ivy Okafor", "Exporting a batch of meetings is clunky, and we hit a bug exporting to Word."),
            seg(35_000, "Priya Shah", "Sorry about that — can you send the file that failed?"),
            seg(44_000, "Ivy Okafor", "Will do. Bulk-tagging would also save us a ton of time."),
            seg(53_000, "Priya Shah", "That's great feedback. I'll get both in front of the team this week."),
            seg(61_000, "Ivy Okafor", "Appreciate it. Overall we're really happy with it."),
        ],
        "## Customer feedback — Brightpath\n\n\
         Brightpath is happy after a month; transcription accuracy praised. \
         Two friction points: a Word-export bug and clunky bulk operations.\n\n\
         **Feedback**\n- Export bug (Word) — repro file incoming\n- Wants bulk-tagging and smoother batch export\n",
    );
    // A meeting whose action items are still suggestions (the Actions tab).
    store::replace_suggested_action_items(
        &conn,
        &brightpath,
        vec![
            NewActionItem {
                title: "Investigate the Word-export bug (repro file incoming)".to_string(),
                assignee_name: Some("Sam Patel".to_string()),
                assignee_uid: None,
                due: None,
            },
            NewActionItem {
                title: "Add bulk-tagging to the product backlog".to_string(),
                assignee_name: Some("Priya Shah".to_string()),
                assignee_uid: None,
                due: None,
            },
        ],
    )
    .expect("brightpath suggested items");

    // ---- Automation run history (~10 rows, done + pending, spread over 2 wks) ----
    let runs: Vec<AutomationRun> = vec![
        run(&acme, &sales_tag, "tag", "done", acme_at + 2 * MIN_MS, "cloud", Some(r#"{"matched_by":"ai"}"#)),
        run(&acme, &sales_tag, "summary", "done", acme_at + 3 * MIN_MS, "cloud", Some(r#"{"generated":true}"#)),
        run(&acme, &sales_tag, "send:artemis", "pending_approval", acme_at + 4 * MIN_MS, "desktop",
            Some(r#"{"send":{"destination":"artemis","mode":"ask","target":{"type":"deal","id":"demo-deal-001","name":"Acme Renewables — Renewal"}}}"#)),
        run(&northwind, &sales_tag, "tag", "done", northwind_at + 2 * MIN_MS, "cloud", Some(r#"{"matched_by":"ai"}"#)),
        run(&northwind, &sales_tag, "send:artemis", "pending_approval", northwind_at + 3 * MIN_MS, "desktop",
            Some(r#"{"send":{"destination":"artemis","mode":"ask","target":{"type":"deal","id":"demo-deal-002","name":"Northwind Retail — New"}}}"#)),
        run(&standup, &standup_tag, "tag", "done", standup_at + 1 * MIN_MS, "desktop", Some(r#"{"matched_by":"rule"}"#)),
        run(&standup, &standup_tag, "move", "done", standup_at + 1 * MIN_MS + 10_000, "desktop", Some(r#"{"project_id":"Team"}"#)),
        run(&standup, &standup_tag, "summary", "done", standup_at + 2 * MIN_MS, "desktop", Some(r#"{"generated":true}"#)),
        run(&atlas, &sales_tag, "tag", "done", atlas_at + 2 * MIN_MS, "cloud", Some(r#"{"matched_by":"ai"}"#)),
        run(&atlas, &sales_tag, "send:artemis", "done", atlas_at + 6 * MIN_MS, "desktop", Some(r#"{"result":{"ok":true}}"#)),
    ];
    let mut run_count = 0;
    for r in &runs {
        if store::record_automation_run(&conn, r).expect("record run") {
            run_count += 1;
        }
    }

    // ---- Reports (local phase-20 store) with saved outputs ----
    let themes = store::save_report(
        &conn,
        Report {
            id: String::new(),
            name: "Cross-meeting themes".to_string(),
            prompt: "Identify the recurring themes, risks, and opportunities across my recent meetings.".to_string(),
            scope_type: "all".to_string(),
            scope_value: None,
            cadence: "manual".to_string(),
            model: String::new(),
            last_run_at: Some(now - 1 * DAY_MS),
            created_at: 0,
            updated_at: 0,
        },
    )
    .expect("themes report");
    store::insert_report_output(
        &conn,
        ReportOutput {
            id: String::new(),
            report_id: themes.id.clone(),
            title: "Themes across the last two weeks".to_string(),
            body_md: "## Recurring themes\n\n\
                - **Privacy is the wedge.** Northwind and Brightpath both anchor on on-device processing and opt-in sync.\n\
                - **Pricing flexibility unlocks deals.** Atlas needs seasonal/volume pricing; Acme needs an accurate seat count.\n\n\
                ## Risks\n\n\
                - Legal/MSA turnaround gates both Acme and Atlas closing this quarter.\n\
                - A Word-export bug (Brightpath) is a visible quality issue.\n\n\
                ## Opportunities\n\n\
                - Bulk-tagging and smoother batch export are repeatedly requested — a small feature with broad appeal.\n"
                .to_string(),
            generated_at: now - 1 * DAY_MS,
            meeting_count: 6,
            scope_label: "All meetings".to_string(),
        },
    )
    .expect("themes output");

    let sales_report = store::save_report(
        &conn,
        Report {
            id: String::new(),
            name: "Weekly sales insights".to_string(),
            prompt: "Summarise this week's sales conversations: pipeline movement, blockers, and next steps.".to_string(),
            scope_type: "tag".to_string(),
            scope_value: Some(sales_tag.clone()),
            cadence: "weekly".to_string(),
            model: String::new(),
            last_run_at: Some(now - 2 * DAY_MS),
            created_at: 0,
            updated_at: 0,
        },
    )
    .expect("sales report");
    store::insert_report_output(
        &conn,
        ReportOutput {
            id: String::new(),
            report_id: sales_report.id.clone(),
            title: "Sales insights — this week".to_string(),
            body_md: "## Pipeline movement\n\n\
                - **Acme Renewables** — Q3 kickoff done; 140-seat renewal + priority support. Proposal out this week.\n\
                - **Northwind Retail** — Discovery complete; ~20-seat pilot pending an infosec review.\n\
                - **Atlas Logistics** — Moving to a volume tier (100-seat floor + overage); revised numbers due end of week.\n\n\
                ## Blockers\n\n\
                - Legal/MSA sign-off gates both Acme and Atlas.\n\
                - Northwind is blocked on their security review — whitepaper shared.\n\n\
                ## Next steps\n\n\
                - Send Acme's updated proposal; confirm Q3 capacity.\n\
                - Book Northwind's technical deep-dive.\n\
                - Revise Atlas pricing tiers.\n"
                .to_string(),
            generated_at: now - 2 * DAY_MS,
            meeting_count: 3,
            scope_label: "Tag: Sales Discussion".to_string(),
        },
    )
    .expect("sales output");

    // ---- Summary ----
    let meetings = store::list_meetings(&conn, None).expect("list meetings");
    let tags = store::list_tags(&conn).expect("list tags");
    let automations = store::list_automations(&conn).expect("list automations");
    let all_runs = store::list_automation_runs(&conn, None).expect("list runs");
    let reports = store::list_reports(&conn).expect("list reports");
    let tasks = store::list_action_items(&conn, None).expect("list tasks");

    println!("\nDone. Seeded into {}", data_dir.display());
    println!("  meetings         {}", meetings.len());
    println!("  tags             {}", tags.len());
    println!("  automations      {}", automations.len());
    println!("  automation runs  {} ({} inserted this run)", all_runs.len(), run_count);
    println!("  board tasks      {}", tasks.len());
    println!("  reports          {} (each with a saved result)", reports.len());
    println!(
        "\nLaunch the demo instance with:\n  LALELA_DATA_DIR={} pnpm tauri dev",
        data_dir.display()
    );
}

/// Wipe the seed-owned tables so re-running produces a fixed dataset (the
/// target is a throwaway demo dir). Uses the same Connection the app uses.
fn reset_seed_tables(conn: &Connection) {
    for table in [
        "action_items",
        "automation_runs",
        "automations",
        "meeting_tags",
        "tags",
        "report_outputs",
        "reports",
        "meeting_fts",
        "meetings",
        "projects",
    ] {
        conn.execute(&format!("DELETE FROM {table}"), [])
            .unwrap_or_else(|e| panic!("reset {table}: {e}"));
    }
}

fn save_tag(conn: &Connection, name: &str, color: &str) -> String {
    store::save_tag(
        conn,
        Tag {
            id: String::new(),
            name: name.to_string(),
            color: color.to_string(),
            created_at: 0,
        },
    )
    .expect("save tag")
    .id
}

/// Insert a meeting through the app's real write path, apply its tags, then
/// backdate it. Returns the new meeting id.
#[allow(clippy::too_many_arguments)]
fn seed_meeting(
    conn: &Connection,
    save_root: &Path,
    title: &str,
    project_id: Option<&String>,
    created_at: i64,
    tags: &[(&String, &str)],
    attendees: Option<Vec<Attendee>>,
    segments: Vec<Segment>,
    summary: &str,
) -> String {
    let meeting = store::insert_meeting(
        conn,
        SaveMeetingInput {
            title: title.to_string(),
            project_id: project_id.cloned(),
            segments,
            notes: String::new(),
            summary: summary.to_string(),
            images: Vec::new(),
            attendees,
        },
        save_root,
    )
    .expect("insert meeting");
    for (tag_id, added_by) in tags {
        store::add_meeting_tag(conn, &meeting.id, tag_id, added_by).expect("tag meeting");
    }
    backdate(conn, &meeting.id, created_at);
    meeting.id
}

fn add_board_item(
    conn: &Connection,
    meeting_id: &str,
    title: &str,
    assignee: Option<&str>,
    due: Option<&str>,
    status: &str,
) {
    store::add_action_item(conn, meeting_id, title, assignee, None, due, status)
        .expect("add action item");
}

#[allow(clippy::too_many_arguments)]
fn run(
    meeting_id: &str,
    tag_id: &str,
    action: &str,
    status: &str,
    ran_at: i64,
    ran_by: &str,
    detail_json: Option<&str>,
) -> AutomationRun {
    AutomationRun {
        meeting_id: meeting_id.to_string(),
        tag_id: tag_id.to_string(),
        action: action.to_string(),
        status: status.to_string(),
        detail_json: detail_json.map(|s| s.to_string()),
        ran_by: ran_by.to_string(),
        ran_at,
    }
}
