import { trackEvent } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  listMeetings,
  searchMeetings,
  formatDate,
  type MeetingMeta,
  type Project,
} from "@/lib/lalela";
import type { NavTarget } from "@/components/Sidebar";
import {
  BarChart3,
  BookOpen,
  FileText,
  Folder,
  FolderPlus,
  Library,
  ListTodo,
  MessagesSquare,
  Mic,
  Network,
  Settings,
  Users,
  Zap,
} from "lucide-react";

interface CommandPaletteProps {
  projects: Project[];
  onClose: () => void;
  onNavigate: (target: NavTarget) => void;
  onSelectProject: (id: string | null) => void;
  onOpenMeeting: (id: string) => void;
  onNewRecording: () => void;
  onNewProject: () => void;
}

interface Entry {
  id: string;
  group: "Actions" | "Go to" | "Folders" | "Meetings";
  label: string;
  hint?: string;
  Icon: ComponentType<{ className?: string }>;
  run: () => void;
}

// "Go to" targets. Search is gone (the palette *is* search). Every consolidated
// destination keeps a one-keystroke fast path via a deep link into its new home:
// Shared → Meetings smart folder; Wiki/Reports → Knowledge hub; Library → the
// Automations hub.
const VIEWS: Array<{ id: string; target: NavTarget; label: string; Icon: Entry["Icon"] }> = [
  { id: "meetings", target: { view: "meetings" }, label: "Meetings", Icon: FileText },
  { id: "shared", target: { view: "meetings", shared: true }, label: "Shared with me", Icon: Users },
  { id: "chat", target: { view: "chat" }, label: "Chat with meetings", Icon: MessagesSquare },
  { id: "tasks", target: { view: "tasks" }, label: "Tasks", Icon: ListTodo },
  { id: "knowledge", target: { view: "knowledge" }, label: "Knowledge", Icon: BookOpen },
  { id: "wiki", target: { view: "knowledge", hubTab: "wiki" }, label: "Wiki", Icon: Network },
  { id: "reports", target: { view: "knowledge", hubTab: "reports" }, label: "Reports", Icon: BarChart3 },
  { id: "people", target: { view: "knowledge", hubTab: "people" }, label: "People & Companies", Icon: Users },
  { id: "automations", target: { view: "automations" }, label: "Automations", Icon: Zap },
  { id: "library", target: { view: "automations", hubTab: "library" }, label: "Library", Icon: Library },
  { id: "settings", target: { view: "settings" }, label: "Settings", Icon: Settings },
];

/** ⌘K palette: jump to a meeting, folder or view; run quick actions.
 * Meetings come from backend FTS as you type; the rest filters client-side. */
export function CommandPalette({
  projects,
  onClose,
  onNavigate,
  onSelectProject,
  onOpenMeeting,
  onNewRecording,
  onNewProject,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingMeta[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => trackEvent("feature_used", { feature: "command_palette", action: "opened" }), []);

  // Meetings: recent when idle, FTS as you type (debounced).
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    const t = setTimeout(
      () => {
        (q ? searchMeetings(q) : listMeetings(null))
          .then((list) => !cancelled && setMeetings(list.slice(0, 6)))
          .catch(() => !cancelled && setMeetings([]));
      },
      q ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (label: string) => !q || label.toLowerCase().includes(q);
    const out: Entry[] = [];
    if (hit("new recording start record")) {
      out.push({
        id: "act-record",
        group: "Actions",
        label: "New recording",
        Icon: Mic,
        run: onNewRecording,
      });
    }
    if (hit("new project folder create")) {
      out.push({
        id: "act-project",
        group: "Actions",
        label: "New project",
        Icon: FolderPlus,
        run: onNewProject,
      });
    }
    for (const v of VIEWS) {
      if (hit(v.label)) {
        out.push({
          id: `view-${v.id}`,
          group: "Go to",
          label: v.label,
          Icon: v.Icon,
          run: () => onNavigate(v.target),
        });
      }
    }
    for (const p of projects) {
      if (hit(p.name)) {
        out.push({
          id: `proj-${p.id}`,
          group: "Folders",
          label: p.name,
          Icon: Folder,
          run: () => onSelectProject(p.id),
        });
      }
    }
    for (const m of meetings) {
      out.push({
        id: `mtg-${m.id}`,
        group: "Meetings",
        label: m.title,
        hint: formatDate(m.created_at),
        Icon: FileText,
        run: () => onOpenMeeting(m.id),
      });
    }
    return out;
  }, [query, projects, meetings, onNavigate, onSelectProject, onOpenMeeting, onNewRecording, onNewProject]);

  // Keep the cursor valid as results change.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(entries.length - 1, 0)));
  }, [entries.length]);

  const runEntry = (e: Entry) => {
    onClose();
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (entries[selected]) runEntry(entries[selected]);
    }
  };

  // Keep the selected row visible while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search meetings, folders, actions…"
            className="w-full bg-transparent px-2 py-1.5 text-sm outline-none"
          />
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {entries.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
          )}
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <div key={e.id}>
                {header && (
                  <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase text-muted-foreground">
                    {header}
                  </div>
                )}
                <button
                  data-idx={i}
                  onClick={() => runEntry(e)}
                  onMouseMove={() => setSelected(i)}
                  className={
                    "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-left text-sm " +
                    (i === selected ? "bg-primary/15" : "hover:bg-muted")
                  }
                >
                  <e.Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  {e.hint && <span className="text-xs text-muted-foreground">{e.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          ↑↓ navigate · ⏎ open · esc close
        </div>
      </div>
    </div>
  );
}
