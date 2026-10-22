// "Folder reports" — the digests a folder's automations produced, newest first,
// shown at the top of the folder in Meetings. Self-hides when there are none.
// Clicking one opens a reader with Copy / Delete.

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, Copy, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CitedMarkdown } from "@/components/CitedMarkdown";
import { cn } from "@/lib/utils";
import { IS_MOBILE } from "@/lib/platform";
import { formatDate, formatTime } from "@/lib/lalela";
import { deleteReportOutput } from "@/lib/reports";
import { listFolderReports, onFolderRulesChanged, type FolderReport } from "@/lib/folderRules";

const COLLAPSED_SHOWN = 3;

export function FolderReports({ projectIds }: { projectIds: string[] }) {
  const [reports, setReports] = useState<FolderReport[]>([]);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [reading, setReading] = useState<FolderReport | null>(null);
  const key = projectIds.join(",");

  const refresh = useCallback(() => {
    if (!key) return setReports([]);
    listFolderReports(key.split(","), 50)
      .then(setReports)
      .catch(() => setReports([]));
  }, [key]);

  useEffect(() => {
    refresh();
    return onFolderRulesChanged(refresh);
  }, [refresh]);

  if (reports.length === 0) return null;
  const shown = showAll ? reports : reports.slice(0, COLLAPSED_SHOWN);

  return (
    <div className="border-b border-border px-6 py-3">
      <div className="mx-auto max-w-3xl">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <CalendarClock className="h-3.5 w-3.5" />
          Folder reports ({reports.length})
        </button>
        {open && (
          <div className="mt-2 space-y-1.5">
            {shown.map((r) => (
              <button
                key={r.id}
                onClick={() => setReading(r)}
                className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left hover:bg-muted"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.scope_label}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatDate(r.generated_at)} {formatTime(r.generated_at)}
                </span>
              </button>
            ))}
            {reports.length > COLLAPSED_SHOWN && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showAll ? "Show fewer" : `Show all ${reports.length}`}
              </button>
            )}
          </div>
        )}
      </div>
      {reading && (
        <ReportReader
          report={reading}
          onClose={() => setReading(null)}
          onDeleted={() => {
            setReading(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ReportReader({
  report,
  onClose,
  onDeleted,
}: {
  report: FolderReport;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(report.body_md).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const remove = async () => {
    if (!window.confirm("Delete this folder report?")) return;
    await deleteReportOutput(report.id).catch(() => {});
    onDeleted();
  };
  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex",
        IS_MOBILE ? "flex-col" : "items-center justify-center bg-black/40 p-4",
      )}
    >
      <div
        className={cn(
          "flex flex-col bg-background",
          IS_MOBILE
            ? "h-full w-full pt-[env(safe-area-inset-top)]"
            : "max-h-[90vh] w-full max-w-3xl rounded-[var(--radius)] border border-border shadow-xl",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold">{report.title}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {report.rule_name} · {report.scope_label}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <button
              onClick={() => void remove()}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-danger"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="prose-sm flex-1 overflow-y-auto px-5 py-4">
          <CitedMarkdown>{report.body_md}</CitedMarkdown>
        </div>
      </div>
    </div>
  );
}
