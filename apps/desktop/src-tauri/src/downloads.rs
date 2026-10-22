//! Backend-owned local-model download registry (desktop only).
//!
//! Downloads run on a detached OS thread so they survive the user leaving the
//! Settings view. The registry records live progress + terminal status for each
//! model file so the UI can *restore* its progress bars when it comes back
//! (`model_download_status`) instead of relying on a component-local listener.
//! Progress is still streamed as `llm://progress`; completion fires
//! `llm://complete` plus an OS notification.

#![cfg(desktop)]

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

/// Live/terminal state of one model download. `status` is one of
/// `"downloading" | "done" | "error"`.
#[derive(Clone, Serialize, Default)]
pub struct DownloadState {
    pub file: String,
    pub downloaded: u64,
    pub total: u64,
    pub status: String,
    pub error: Option<String>,
}

/// Managed Tauri state: one entry per model file that has been asked to
/// download in this app session.
#[derive(Default)]
pub struct DownloadRegistry(pub Mutex<HashMap<String, DownloadState>>);
