import { Button } from "@/components/ui/Button";
import { chord } from "@/lib/platform";
import { IS_COMMUNITY } from "@/lib/edition";
import {
  BookOpen,
  Bell,
  FolderTree,
  KeyRound,
  ListTodo,
  MessagesSquare,
  Mic,
  Sparkles,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { TOURS } from "@/lib/tours";

interface GuideDialogProps {
  onClose: () => void;
  /** When provided, the guide offers to launch an interactive click-through
   * tour of the real app (used at onboarding end + from the Help menu). */
  onStartTour?: (tourId: string) => void;
}

const SECTIONS: Array<{
  Icon: typeof Mic;
  title: string;
  body: string;
}> = [
  {
    Icon: Mic,
    title: "Record — no bot joins your call",
    body: "Lalela records your mic (and optionally what you hear) right on this device and transcribes it locally. It can detect Zoom/Meet/Teams calls and offer to record. Audio is discarded after transcription.",
  },
  {
    Icon: Sparkles,
    title: "Notes that write themselves",
    body: "New meetings get a descriptive title automatically (with a cloud model, once you've allowed cloud AI), and you can turn on auto-summaries in Settings → New meetings. Pick different summary styles (or write your own) in the Library.",
  },
  {
    Icon: ListTodo,
    title: "Action items → Tasks board",
    body: "In a meeting, open Action items → Generate. Lalela extracts who-does-what, matches names to your teammates, and everything you approve lands on the Tasks kanban — drag cards between To do / In progress / Done.",
  },
  {
    Icon: MessagesSquare,
    title: "Chat with your meetings",
    body: "Ask questions grounded in one meeting (Chat tab), one folder (Chat button on the meetings page), or everything (sidebar Chat). Answers cite [m:ss] timestamps — click one to jump the transcript.",
  },
  {
    Icon: Workflow,
    title: "Workflows",
    body: "Chain prompt blocks over a transcript — 'extract user stories', then 'turn them into an email'. Build templates in the Library, run them from any meeting's Workflows tab.",
  },
  {
    Icon: FolderTree,
    title: "Organise fast",
    body: `Drag meetings onto folders, nest folders inside each other, and press ${chord("K")} anywhere to jump to any meeting, folder, or action.`,
  },
  // Team sharing is a hosted feature: not in the Community edition.
  ...(IS_COMMUNITY
    ? []
    : [
        {
          Icon: Users,
          title: "Work as a team",
          body: "Share a folder by email with viewer/editor/admin roles — subfolders are included. Tasks assigned to teammates appear on their board, and the Activity view logs what's happening (filter it to just you).",
        },
      ]),
  {
    Icon: KeyRound,
    title: "Your AI, your choice",
    body: IS_COMMUNITY
      ? "Download a free local model in Settings and run everything on-device — private and offline. Or use your own OpenRouter key. Lalela asks before anything goes to a cloud AI model. Everything is saved as plain markdown on your device, always yours."
      : "Download a free local model in Settings and run everything on-device — private and offline. Or use the free monthly cloud allowance when you sign in, or your own OpenRouter key. Lalela asks before anything goes to a cloud AI model. Everything is saved as plain markdown on your device, always yours.",
  },
];

/** The tour of Lalela — shown once after onboarding, reopenable from the
 * sidebar's Help button. */
export function GuideDialog({ onClose, onStartTour }: GuideDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">How Lalela works</h2>
              <p className="text-xs text-muted-foreground">
                Two minutes, eight ideas — everything else you'll discover as you go.
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

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {SECTIONS.map(({ Icon, title, body }) => (
            <div key={title} className="flex gap-3 rounded-[var(--radius)] border border-border p-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15">
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
              </div>
            </div>
          ))}
          {onStartTour && (
            <div className="rounded-[var(--radius)] border border-border bg-surface p-3">
              <p className="text-sm font-semibold">Rather learn by doing?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Take a hands-on tour that walks you through the real app, step by step.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {TOURS.map((t) => (
                  <Button key={t.id} variant="outline" size="sm" onClick={() => onStartTour(t.id)}>
                    <t.Icon className="h-4 w-4" />
                    {t.title}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
            <Bell className="h-3.5 w-3.5" />
            Reopen this any time from Help in the sidebar.
          </p>
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <Button onClick={onClose}>Let's go</Button>
        </div>
      </div>
    </div>
  );
}
