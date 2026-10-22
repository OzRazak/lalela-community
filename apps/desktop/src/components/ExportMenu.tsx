import { trackEvent } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FileDown, FileText, Loader2 } from "lucide-react";
import type { ExportFormat } from "@/lib/lalela";

interface ExportMenuProps {
  /** Runs the export; the caller owns the error surface. */
  onExport: (format: ExportFormat) => void | Promise<void>;
  /** Disables the trigger while an export is writing. */
  busy?: boolean;
}

/**
 * Export picker for a meeting — Word or PDF, same content either way
 * (transcript plus the captured frames, sized to fit the page). One button
 * rather than two: exporting is a single intent, the file type is a detail of
 * it. Follows the NewMenu / ImportMenu dropdown idiom at Amp dial 2.
 */
export function ExportMenu({ onExport, busy }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items: { format: ExportFormat; label: string; sub: string }[] = [
    {
      format: "docx",
      label: "Word (.docx)",
      sub: "Editable — transcript and captured images",
    },
    {
      format: "pdf",
      label: "PDF (.pdf)",
      sub: "Fixed layout, smaller file — same content",
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title="Export this meeting as Word or PDF"
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileDown className="h-4 w-4" />
        )}
        Export
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-72 rounded-[var(--radius)] border border-border bg-card p-2 shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.format}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                trackEvent("meeting_exported", { format: it.format });
                void onExport(it.format);
              }}
              className="flex w-full items-start gap-3 rounded-[var(--radius)] px-2.5 py-2 text-left hover:bg-muted"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{it.label}</span>
                <span className="block text-xs text-muted-foreground">{it.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
