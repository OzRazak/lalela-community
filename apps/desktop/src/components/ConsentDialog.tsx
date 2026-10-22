import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { getConsentText, setConsentEnabled } from "@/lib/settings";
import { ShieldCheck, X } from "lucide-react";

interface ConsentDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pre-recording consent step. Recording laws in many places (all-party-consent
 * US states, GDPR) require informed agreement before recording — this gives the
 * user the disclosure text to read out or paste into the chat, then confirm.
 */
export function ConsentDialog({ onConfirm, onCancel }: ConsentDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const text = getConsentText();

  const confirm = () => {
    if (dontAskAgain) setConsentEnabled(false);
    onConfirm();
  };

  const copy = () => navigator.clipboard.writeText(text);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">Before you record</h2>
              <p className="text-xs text-muted-foreground">Get everyone's consent</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <p className="mb-3 text-sm text-muted-foreground">
            Many places require everyone's agreement before recording. Let participants know — you
            can read this aloud or paste it into the meeting chat:
          </p>
          <div className="rounded-[var(--radius)] border border-border bg-muted p-3 text-sm">
            {text}
          </div>
          <button
            onClick={copy}
            className="mt-2 text-xs font-medium text-accent hover:underline"
          >
            Copy disclosure
          </button>

          <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Don't ask again (you can re-enable this in Settings)
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>Start recording</Button>
        </div>
      </div>
    </div>
  );
}
