import { noAiHint } from "@/lib/edition";
// Transcript import flow (Intelligence Layer, Slice 2): pick file → preview
// (transcript vs document) → optional AI structuring for documents → save
// with provenance. Imports are honest: no speaker structure = saved as notes,
// never a synthetic transcript. Text imports never enrol voiceprints.

import { importFormat, markMeetingCaptured, trackEvent } from "@/lib/analytics";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ReportAiButton } from "@/components/ReportAiContent";
import { FileUp, Loader2, Sparkles, Users } from "lucide-react";
import {
  parseImportText,
  saveImportedMeeting,
  type FullMeeting,
  type ImportPreview,
} from "@/lib/lalela";
import { aiGenerate, NoAiError } from "@/lib/ai";

/** Asks the model to emit exactly the line shape our parser accepts. */
const STRUCTURE_SYSTEM = `You reconstruct meeting transcripts. The user gives you raw text of a conversation. Output ONLY transcript lines, one per utterance, in exactly this format:

[m:ss] Name: what they said

If the text contains no timestamps, omit the [m:ss] part and output "Name: what they said". Use the speaker names present in the text; never invent names, timestamps or content that is not in the text. No headers, no commentary.`;

interface ImportDialogProps {
  preview: ImportPreview;
  /** File name shown in provenance. */
  filename: string;
  projectId: string | null;
  projectName: string;
  onSaved: (meeting: FullMeeting) => void;
  onClose: () => void;
}

export function ImportDialog({
  preview: initial,
  filename,
  projectId,
  projectName,
  onSaved,
  onClose,
}: ImportDialogProps) {
  const [preview, setPreview] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [busy, setBusy] = useState<"structure" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The raw AI output of "Detect speakers with AI" (kept so it can be reported).
  const [aiStructured, setAiStructured] = useState<string | null>(null);

  const isTranscript = preview.kind === "transcript" && preview.segments.length > 0;

  const structureWithAi = async () => {
    setBusy("structure");
    setError(null);
    try {
      const structured = await aiGenerate(preview.text, STRUCTURE_SYSTEM, undefined, { interactive: true });
      const parsed = await parseImportText(structured, preview.format, title);
      if (parsed.kind !== "transcript" || parsed.segments.length === 0) {
        setError(
          "The AI couldn't find reliable speaker structure — importing as notes instead.",
        );
      } else {
        // Keep the original extracted text for provenance/notes fallback.
        setPreview({ ...parsed, text: preview.text });
        setAiStructured(structured);
      }
    } catch (e) {
      setError(
        e instanceof NoAiError
          ? noAiHint("No AI source available — add a key, sign in, or use a local model to structure documents.")
          : String(e),
      );
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const meeting = await saveImportedMeeting(
        title.trim() || preview.title,
        projectId,
        preview,
        filename,
      );
      trackEvent("meeting_imported", { connector: "transcript_file", format: importFormat(preview.format) });
      markMeetingCaptured("import");
      onSaved(meeting);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  const speakerNames = Array.from(new Set(preview.segments.map((s) => s.speaker)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
        <h3 className="flex items-center gap-2 font-semibold">
          <FileUp className="h-4 w-4" />
          Import “{filename}”
        </h3>

        <div className="mt-3 flex items-center gap-2 text-sm">
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs font-medium " +
              (isTranscript ? "bg-success/15 text-success" : "bg-primary/15")
            }
          >
            {isTranscript ? "Transcript" : "Notes / document"}
          </span>
          {preview.detected && (
            <span className="text-xs text-muted-foreground">shape: {preview.detected}</span>
          )}
          <span className="text-xs text-muted-foreground">
            → {projectName}
          </span>
        </div>

        {isTranscript ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {preview.segments.length} lines ·{" "}
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" />
              {speakerNames.slice(0, 4).join(", ")}
              {speakerNames.length > 4 && ` +${speakerNames.length - 4} more`}
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No speaker structure detected — it will be saved as meeting notes (searchable,
            summarizable), not as a transcript.
          </p>
        )}

        <div className="mt-3 max-h-40 overflow-y-auto rounded-[var(--radius)] border border-border bg-card p-3 font-mono text-xs text-muted-foreground">
          {isTranscript
            ? preview.segments.slice(0, 8).map((s, i) => (
                <div key={i} className="truncate">
                  <span className="font-semibold">{s.speaker}:</span> {s.text}
                </div>
              ))
            : preview.text.slice(0, 600)}
        </div>

        <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
          Meeting title
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />

        <p className="mt-3 text-xs text-muted-foreground">
          Imported content is marked as externally sourced. Make sure you have the right to
          keep this conversation — its participants may not know it was transcribed.
        </p>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}

        <div className="mt-4 flex items-center justify-between">
          {!isTranscript ? (
            <Button
              variant="outline"
              size="sm"
              onClick={structureWithAi}
              disabled={busy !== null}
              title="Ask the AI to detect speakers and turns in this document"
            >
              {busy === "structure" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Detect speakers with AI
            </Button>
          ) : aiStructured ? (
            <ReportAiButton surface="import" output={aiStructured} />
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy === "save"}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy !== null || !title.trim()}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Import
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
