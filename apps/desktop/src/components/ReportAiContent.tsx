import { useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Flag, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { submitAiReport, type AiReportOutcome } from "@/lib/aiReport";
import {
  AI_REPORT_CATEGORIES,
  AI_REPORT_COMMENT_CAP,
  AI_REPORT_OUTPUT_CAP,
  AI_REPORT_SUPPORT_EMAIL,
  type AiReportCategory,
  type AiReportSurface,
} from "@/lib/aiReportCore";
import { cn } from "@/lib/utils";
import { IS_COMMUNITY } from "@/lib/edition";

// "Report AI content" — the flag button every AI-output surface carries, and
// the dialog behind it (Microsoft Store policy 11.16; Apple generative-AI
// review). See lib/aiReport.ts for sending + the email fallback.

export const REPORT_AI_TOOLTIP = "Report inappropriate AI content";

interface ReportTarget {
  surface: AiReportSurface;
  /** The AI output being reported (or a getter, read when the dialog opens). */
  output?: string | null | (() => string | null | undefined);
  model?: string | null;
  route?: string | null;
}

interface ReportAiButtonProps extends ReportTarget {
  className?: string;
  /** "sm" = the standard small outline button; "xs" = a quiet inline link
   * for dense spots (chat bubbles, the Copilot overlay). Both show the label. */
  size?: "sm" | "xs";
  label?: string;
}

/** Reports go to Auxo's hosted endpoint (or Auxo's support mailbox), so the
 *  Community edition — which has no Auxo cloud — shows no Report button. */
export function ReportAiButton(props: ReportAiButtonProps) {
  if (IS_COMMUNITY) return null;
  return <ReportAiButtonImpl {...props} />;
}

function ReportAiButtonImpl({ className, size = "sm", label = "Report", ...target }: ReportAiButtonProps) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const openDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    const o = typeof target.output === "function" ? target.output() : target.output;
    setSnapshot(o ?? null);
    setOpen(true);
  };
  return (
    <>
      {size === "xs" ? (
        <button
          type="button"
          onClick={openDialog}
          title={REPORT_AI_TOOLTIP}
          aria-label={REPORT_AI_TOOLTIP}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
            className,
          )}
        >
          <Flag className="h-3 w-3" />
          {label}
        </button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openDialog}
          title={REPORT_AI_TOOLTIP}
          aria-label={REPORT_AI_TOOLTIP}
          className={className}
        >
          <Flag className="h-3.5 w-3.5" />
          {label}
        </Button>
      )}
      {open && (
        <ReportAiDialog
          surface={target.surface}
          output={snapshot}
          model={target.model}
          route={target.route}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface ReportAiDialogProps {
  surface: AiReportSurface;
  output?: string | null;
  model?: string | null;
  route?: string | null;
  onClose: () => void;
}

export function ReportAiDialog({ surface, output, model, route, onClose }: ReportAiDialogProps) {
  const [category, setCategory] = useState<AiReportCategory | null>(null);
  const [comment, setComment] = useState("");
  const hasOutput = Boolean(output && output.trim());
  const [includeOutput, setIncludeOutput] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AiReportOutcome | null>(null);

  const send = async () => {
    if (!category || busy) return;
    setBusy(true);
    const r = await submitAiReport({
      category,
      comment,
      surface,
      includeOutput: hasOutput && includeOutput,
      output: hasOutput ? output : null,
      model,
      route,
    });
    setOutcome(r);
    setBusy(false);
  };

  const body = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4"
      // React events bubble through portals to the button's ancestors (a
      // clickable row, the Help sheet's backdrop) — keep them in here.
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-ai-title"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] bg-danger/10 text-danger">
              <Flag className="h-4 w-4" />
            </div>
            <div>
              <h2 id="report-ai-title" className="font-semibold">
                Report AI content
              </h2>
              <p className="text-xs text-muted-foreground">
                Tell Auxo Digital about AI output that is harmful, wrong or inappropriate.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {outcome ? (
          <div className="space-y-3 p-5 text-sm">
            {outcome === "sent" && (
              <p className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                Thanks — your report was sent to Auxo Digital for review.
              </p>
            )}
            {outcome === "email" && (
              <p className="flex items-start gap-2">
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                We couldn't reach Lalela's servers, so we opened a prefilled email to{" "}
                {AI_REPORT_SUPPORT_EMAIL}. Press Send in your mail app to finish the report.
              </p>
            )}
            {outcome === "failed" && (
              <p className="flex items-start gap-2 text-danger">
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                We couldn't send the report or open your mail app. Please email{" "}
                {AI_REPORT_SUPPORT_EMAIL} and describe what you saw.
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 overflow-y-auto p-4">
              <fieldset>
                <legend className="mb-2 text-sm font-medium">What's the problem?</legend>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {AI_REPORT_CATEGORIES.map((c) => (
                    <label
                      key={c.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-sm",
                        category === c.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
                      )}
                    >
                      <input
                        type="radio"
                        name="report-ai-category"
                        value={c.id}
                        checked={category === c.id}
                        onChange={() => setCategory(c.id)}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">
                  Comment <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, AI_REPORT_COMMENT_CAP))}
                  rows={3}
                  placeholder="What was wrong with it?"
                  className="w-full resize-y rounded-[var(--radius)] border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>

              {hasOutput && (
                <div className="space-y-1.5">
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={includeOutput}
                      onChange={(e) => setIncludeOutput(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Include the AI output in my report</span>
                      <span className="block text-xs text-muted-foreground">
                        {includeOutput
                          ? "The text below will be sent to Auxo Digital for review."
                          : "Only your category and comment will be sent."}
                        {(output?.length ?? 0) > AI_REPORT_OUTPUT_CAP &&
                          ` Only the first ${AI_REPORT_OUTPUT_CAP.toLocaleString()} characters are included.`}
                      </span>
                    </span>
                  </label>
                  {includeOutput && (
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-border bg-muted/50 p-2 font-sans text-xs text-muted-foreground">
                      {output!.slice(0, AI_REPORT_OUTPUT_CAP)}
                    </pre>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Reports also include where in Lalela this happened, the AI model used, your app version and
                platform — and your account id if you're signed in. Never audio, transcripts or voice data.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-border p-3">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={send} disabled={!category || busy}>
                <Flag className="h-3.5 w-3.5" />
                {busy ? "Sending…" : "Send report"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
