// Bulk folder import: every supported file in a picked folder — recordings
// (transcribed + diarized through the Slice 7 pipeline, one at a time) and
// documents/transcripts (Slice 2 parser, saved without a preview step) — is
// imported sequentially into the current project. Files whose name was
// imported before are deselected by default, so re-running on the same
// folder is idempotent. Everything happens on-device.

import { countBucket, markMeetingCaptured, trackEvent } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, FileAudio, FileText, FolderUp, Loader2, XCircle } from "lucide-react";
import {
  cancelAudioImport,
  importAudioFile,
  importPreview,
  onImportProgress,
  onImportStatus,
  saveImportedMeeting,
  type FolderImportFile,
} from "@/lib/lalela";
import { getAsrEngine, getVoiceprintsEnabled } from "@/lib/settings";

interface BulkImportDialogProps {
  folder: string;
  files: FolderImportFile[];
  projectId: string | null;
  projectName: string;
  /** Called when the run finishes (or is cancelled) with ≥1 import saved. */
  onImported: () => void;
  onClose: () => void;
}

type FileState = "pending" | "running" | "done" | "failed" | "skipped";

const prettySize = (bytes: number) =>
  bytes >= 1 << 30
    ? `${(bytes / (1 << 30)).toFixed(1)} GB`
    : bytes >= 1 << 20
      ? `${(bytes / (1 << 20)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function BulkImportDialog({
  folder,
  files,
  projectId,
  projectName,
  onImported,
  onClose,
}: BulkImportDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(files.filter((f) => !f.already_imported).map((f) => f.path)),
  );
  const [states, setStates] = useState<Map<string, { state: FileState; error?: string }>>(
    new Map(),
  );
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const cancelRef = useRef(false);
  const importedRef = useRef(0);

  // Progress events from the audio pipeline apply to the file running now.
  useEffect(() => {
    if (!running) return;
    const subs = [
      onImportStatus((s) => setStatus(s.message ?? s.state)),
      onImportProgress((p) =>
        setPct(p.total_ms > 0 ? Math.min(100, Math.round((p.processed_ms / p.total_ms) * 100)) : null),
      ),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [running]);

  const setFileState = (path: string, state: FileState, error?: string) =>
    setStates((prev) => new Map(prev).set(path, { state, error }));

  const run = async () => {
    setRunning(true);
    cancelRef.current = false;
    importedRef.current = 0;
    const queue = files.filter((f) => selected.has(f.path));
    for (const f of queue) {
      if (cancelRef.current) {
        setFileState(f.path, "skipped");
        continue;
      }
      setCurrentPath(f.path);
      setStatus(null);
      setPct(null);
      setFileState(f.path, "running");
      try {
        if (f.kind === "audio") {
          await importAudioFile(f.path, null, projectId, getAsrEngine(), getVoiceprintsEnabled());
        } else {
          const preview = await importPreview(f.path);
          await saveImportedMeeting(preview.title, projectId, preview, f.filename);
        }
        importedRef.current += 1;
        setFileState(f.path, "done");
      } catch (e) {
        // A cancel mid-audio surfaces as an error on the current file; every
        // later file is marked skipped by the flag above.
        setFileState(f.path, cancelRef.current ? "skipped" : "failed", String(e));
      }
    }
    setCurrentPath(null);
    setRunning(false);
    setFinished(true);
    trackEvent("meeting_imported", { connector: "bulk_folder", count: countBucket(importedRef.current) });
    if (importedRef.current > 0) markMeetingCaptured("import");
    if (importedRef.current > 0) onImported();
  };

  const cancel = async () => {
    if (!running) {
      onClose();
      return;
    }
    cancelRef.current = true;
    try {
      await cancelAudioImport(); // no-op unless an audio file is mid-transcription
    } catch {
      /* the queue drains via the flag */
    }
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const counts = {
    done: [...states.values()].filter((s) => s.state === "done").length,
    failed: [...states.values()].filter((s) => s.state === "failed").length,
  };
  const folderName = folder.split(/[\\/]/).pop() ?? folder;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
        <h3 className="flex items-center gap-2 font-semibold">
          <FolderUp className="h-4 w-4" />
          Import folder “{folderName}”
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {files.length === 0
            ? "No importable files found — supported: audio/video recordings, DOCX, PDF, TXT, MD, VTT."
            : `Recordings are transcribed on-device one at a time; documents are parsed and saved. Everything lands in ${projectName}.`}
        </p>

        {files.length > 0 && (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-[var(--radius)] border border-border">
            {files.map((f) => {
              const st = states.get(f.path)?.state ?? "pending";
              const err = states.get(f.path)?.error;
              return (
                <div
                  key={f.path}
                  className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                    disabled={running || finished}
                  />
                  {f.kind === "audio" ? (
                    <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{f.filename}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {prettySize(f.size_bytes)}
                      {f.already_imported && " · imported before"}
                      {err && ` · ${err}`}
                    </p>
                  </div>
                  {st === "running" && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {f.path === currentPath && pct !== null ? `${pct}%` : (status ?? "")}
                    </span>
                  )}
                  {st === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
                  {st === "failed" && <XCircle className="h-4 w-4 shrink-0 text-danger" />}
                  {st === "skipped" && (
                    <span className="shrink-0 text-xs text-muted-foreground">skipped</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Imported content is marked as externally sourced. Make sure you have the right to
          keep these conversations — their participants may not know they were recorded.
        </p>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {finished
              ? `Done — ${counts.done} imported${counts.failed ? `, ${counts.failed} failed` : ""}.`
              : `${selected.size} of ${files.length} selected`}
          </span>
          <div className="flex items-center gap-2">
            {!finished && (
              <Button variant="outline" size="sm" onClick={cancel}>
                {running ? "Stop after current file" : "Cancel"}
              </Button>
            )}
            {finished ? (
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            ) : (
              <Button size="sm" onClick={run} disabled={running || selected.size === 0}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {running ? "Importing…" : `Import ${selected.size} file${selected.size === 1 ? "" : "s"}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
