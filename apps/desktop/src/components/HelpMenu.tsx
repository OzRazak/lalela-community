import { BookOpen, ChevronRight, Flag, LifeBuoy, PlayCircle, X } from "lucide-react";
import { ReportAiButton } from "@/components/ReportAiContent";
import { TOURS } from "@/lib/tours";
import { FEATURE_VIDEOS } from "@/lib/videos";
import { IS_COMMUNITY } from "@/lib/edition";

interface HelpMenuProps {
  onClose: () => void;
  /** Open the "How Lalela works" overview (the existing GuideDialog). */
  onOpenGuide: () => void;
  /** Launch an interactive click-through tour by id. */
  onStartTour: (tourId: string) => void;
  /** Play a feature explainer video by id. */
  onWatchVideo: (videoId: string) => void;
}

/** The Help hub — reached from the sidebar's Help button. Offers the read-only
 * overview, the interactive click-through tours, and short explainer videos
 * from one place. */
export function HelpMenu({ onClose, onOpenGuide, onStartTour, onWatchVideo }: HelpMenuProps) {
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-[var(--radius)] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <LifeBuoy className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">Help & guides</h2>
              <p className="text-xs text-muted-foreground">
                Read the overview, or take a hands-on tour of the real app.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 p-4">
          <button
            onClick={onOpenGuide}
            className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border p-3 text-left transition-colors hover:bg-muted"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15">
              <BookOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">How Lalela works</p>
              <p className="text-xs text-muted-foreground">
                A two-minute read of everything Lalela can do.
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>

          <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Guided tours
          </div>

          {TOURS.map((t) => (
            <button
              key={t.id}
              onClick={() => onStartTour(t.id)}
              className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border p-3 text-left transition-colors hover:bg-muted"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
                <t.Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t.title}</p>
                <p className="text-xs text-muted-foreground">{t.description}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}

          {FEATURE_VIDEOS.length > 0 && (
            <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Watch
            </div>
          )}

          {FEATURE_VIDEOS.map((v) => (
            <button
              key={v.id}
              onClick={() => onWatchVideo(v.id)}
              className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border p-3 text-left transition-colors hover:bg-muted"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15">
                <PlayCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{v.title}</p>
                <p className="text-xs text-muted-foreground">{v.description}</p>
              </div>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {v.duration}
              </span>
            </button>
          ))}

          {/* AI-content reports go to Auxo — none in the Community edition. */}
          {!IS_COMMUNITY && (
            <>
          <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            AI content
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
              <Flag className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Report a problem with AI content</p>
              <p className="text-xs text-muted-foreground">
                Harmful, offensive or wrong AI output? Let us know.
              </p>
            </div>
            <ReportAiButton surface="general" />
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
