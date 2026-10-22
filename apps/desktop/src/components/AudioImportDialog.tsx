// Audio-file import flow (Intelligence Layer, Slice 7): pick a recording →
// transcribe + diarize it through the SAME pipeline as a live recording →
// save with verified-audio provenance. Unlike text imports, real audio
// exists, so voiceprints can be observed (honoring the Settings opt-in).

import { markMeetingCaptured, trackEvent } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FileAudio, Loader2 } from "lucide-react";
import {
  cancelAudioImport,
  importAudioFile,
  onImportProgress,
  onImportSegment,
  onImportStatus,
  type FullMeeting,
  type Segment,
} from "@/lib/lalela";
import { getAsrEngine, getVoiceprintsEnabled } from "@/lib/settings";

interface AudioImportDialogProps {
  /** Absolute path of the picked media file. */
  path: string;
  /** File name shown in provenance. */
  filename: string;
  projectId: string | null;
  projectName: string;
  onSaved: (meeting: FullMeeting) => void;
  onClose: () => void;
}

const stem = (filename: string) => filename.replace(/\.[^.]+$/, "");

export function AudioImportDialog({
  path,
  filename,
  projectId,
  projectName,
  onSaved,
  onClose,
}: AudioImportDialogProps) {
  const [title, setTitle] = useState(stem(filename));
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [lastLine, setLastLine] = useState<Segment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    const subs = [
      onImportStatus((s) => setStatus(s.message ?? s.state)),
      onImportProgress((p) => setProgress({ processed: p.processed_ms, total: p.total_ms })),
      onImportSegment((s) => setLastLine(s)),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [running]);

  const start = async () => {
    setRunning(true);
    setError(null);
    cancelledRef.current = false;
    try {
      const meeting = await importAudioFile(
        path,
        title.trim() || null,
        projectId,
        getAsrEngine(),
        getVoiceprintsEnabled(),
      );
      trackEvent("meeting_imported", { connector: "audio_file", format: "audio" });
      trackEvent("transcription_completed", { engine: "local", source: "import", success: true });
      markMeetingCaptured("import");
      onSaved(meeting);
    } catch (e) {
      // A user-initiated cancel just closes the dialog quietly.
      if (cancelledRef.current) {
        onClose();
        return;
      }
      setError(String(e));
      setRunning(false);
      setStatus(null);
      setProgress(null);
    }
  };

  const cancel = async () => {
    if (!running) {
      onClose();
      return;
    }
    cancelledRef.current = true;
    try {
      await cancelAudioImport();
    } catch {
      /* the import ends on its own; the dialog closes via the catch above */
    }
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
        <h3 className="flex items-center gap-2 font-semibold">
          <FileAudio className="h-4 w-4" />
          Import recording “{filename}”
        </h3>

        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            Audio → transcript
          </span>
          <span className="text-xs text-muted-foreground">→ {projectName}</span>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          The recording runs through the same on-device transcription and speaker
          separation as a live meeting. Nothing leaves this device.
        </p>

        <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
          Meeting title
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={running}
          className="w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />

        {running && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {status ?? "Working…"}
              </span>
              {pct !== null && <span>{pct}%</span>}
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct ?? 3}%` }}
              />
            </div>
            {lastLine && (
              <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                <span className="font-semibold">{lastLine.speaker}:</span> {lastLine.text}
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Imported content is marked as externally sourced. Make sure you have the right
          to keep this conversation — its participants may not know it was recorded.
        </p>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={start} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {running ? "Importing…" : "Transcribe & import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
