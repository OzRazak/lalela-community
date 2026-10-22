import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Mic, AudioLines, NotebookPen, ChevronDown } from "lucide-react";

interface NewMenuProps {
  /** Start a full meeting recording (mic + optional system audio). */
  onRecordMeeting: () => void;
  /** Start a quick mic-only voice memo (its transcript becomes the note). */
  onVoiceMemo: () => void;
  /** Create an empty note and open it with the composer focused. */
  onBlankNote: () => void;
  /** Sidebar CTA spans the full width; the toolbar variant stays inline. */
  fullWidth?: boolean;
  /** Spotlight target for the record-first-meeting tour (sidebar only). */
  tourId?: string;
}

/**
 * Split "New" control (Wave B1). The primary segment starts a meeting recording
 * in one click — preserving the app's main call to action — while the caret
 * opens a menu with all three ways to create content: Record meeting · Voice
 * memo · Blank note. Matches the existing dropdown idiom (see ImportMenu) at
 * Amp dial 2 — no new visual language.
 */
export function NewMenu({
  onRecordMeeting,
  onVoiceMemo,
  onBlankNote,
  fullWidth,
  tourId,
}: NewMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const items: { icon: ReactNode; label: string; sub: string; onClick: () => void }[] = [
    {
      icon: <Mic className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />,
      label: "Record meeting",
      sub: "Capture a live conversation, transcribed on your device",
      onClick: onRecordMeeting,
    },
    {
      icon: <AudioLines className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />,
      label: "Voice memo",
      sub: "A quick mic-only recording — the transcript becomes your note",
      onClick: onVoiceMemo,
    },
    {
      icon: <NotebookPen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />,
      label: "Blank note",
      sub: "Start typing straight away — no recording",
      onClick: onBlankNote,
    },
  ];

  return (
    <div className={cn("relative", fullWidth && "w-full")} ref={ref}>
      <div className="flex">
        <Button
          data-tour-id={tourId}
          className={cn("rounded-r-none", fullWidth && "flex-1")}
          onClick={() => pick(onRecordMeeting)}
        >
          <Mic className="h-4 w-4" />
          New Recording
        </Button>
        <Button
          aria-label="More ways to create"
          aria-expanded={open}
          title="Record meeting · Voice memo · Blank note"
          onClick={() => setOpen((o) => !o)}
          className="rounded-l-none border-l border-primary-foreground/25 px-2"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 rounded-[var(--radius)] border border-border bg-card p-2 shadow-lg",
            fullWidth ? "left-0 w-full" : "right-0 w-80",
          )}
        >
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => pick(it.onClick)}
              className="flex w-full items-start gap-3 rounded-[var(--radius)] px-2.5 py-2 text-left hover:bg-muted"
            >
              {it.icon}
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
