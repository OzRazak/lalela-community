import { trackEvent } from "@/lib/analytics";
import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { sendAtlasPack } from "@/lib/atlasPack";

// "Send to Atlas" (actions pack) — manual send / resend of one meeting to
// Atlas, which proposes email drafts, tasks and calendar holds for the user to
// approve there. Manual twin of the `atlas_pack` automation destination; the
// same sendAtlasPack path generates a missing summary first (same generator as
// this view) and pushes the meeting to the cloud before sending. Resend is an
// explicit confirm. Mirrors apps/web/components/SendToAtlasPack.tsx (parity).

export function SendToAtlasDialog({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  useEffect(() => trackEvent("feature_used", { feature: "atlas_send", action: "opened" }), []);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendPrompt, setResendPrompt] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const send = async (resend: boolean) => {
    setSending(true);
    setError(null);
    try {
      const r = await sendAtlasPack(meetingId, { includeTranscript, resend, interactive: true });
      if (r.alreadySent) {
        setResendPrompt(r.pushedAt ?? "");
        return;
      }
      setResendPrompt(null);
      setDone(
        r.warning ??
        (r.summaryGenerated ? "Summary generated and sent to Atlas. " : "Sent to Atlas. ") +
          (r.transcriptTruncated ? "The transcript was trimmed to its most recent part. " : "") +
          "Proposed actions will appear in Atlas shortly.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-lg rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            <h2 className="font-semibold">Send to Atlas for proposed actions</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-5 text-sm">
          {done ? (
            <>
              <p className="inline-flex items-start gap-1.5 font-medium text-success">
                <Check className="mt-0.5 h-4 w-4 shrink-0" /> {done}
              </p>
              <div>
                <Button variant="outline" size="sm" onClick={onClose}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                Sends the title, date, attendees, summary, your notes and approved action items to
                your Atlas account, which proposes email drafts, tasks and calendar holds for you to
                approve there. If the meeting has no summary yet, one is generated first.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={includeTranscript}
                  onChange={(e) => setIncludeTranscript(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Include the full transcript{" "}
                  <span className="text-muted-foreground">
                    (better suggestions; very long transcripts are trimmed to the most recent part)
                  </span>
                </span>
              </label>
              {resendPrompt !== null && (
                <p className="text-muted-foreground">
                  This exact version was already sent
                  {resendPrompt ? ` on ${new Date(resendPrompt).toLocaleString()}` : ""} — send it
                  again?
                </p>
              )}
              {error && <p className="text-danger">{error}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void send(resendPrompt !== null)} disabled={sending}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {sending ? "Sending…" : resendPrompt !== null ? "Send again" : "Send"}
                </Button>
                <Button variant="outline" size="sm" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
