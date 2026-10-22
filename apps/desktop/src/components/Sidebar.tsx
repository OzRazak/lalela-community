import { useMemo, useState } from "react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { IS_COMMUNITY } from "@/lib/edition";
import type { Project } from "@/lib/lalela";
import { ContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { NewMenu } from "@/components/NewMenu";
import {
  BookOpen,
  CircleHelp,
  ListTodo,
  FileText,
  LogIn,
  MessagesSquare,
  Settings,
  FolderClosed,
  Folder,
  Inbox,
  ChevronRight,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
  Zap,
} from "lucide-react";

/** Top-level destinations (the 6 primary "places"). Search stays in the union
 * as a non-sidebar route (mobile reaches it from the "More" sheet; desktop uses
 * the top-bar field / ⌘K). Notifications, Shared, Reports, Wiki and Library are
 * no longer top-level views — they moved to the bell, the Meetings "Shared with
 * me" smart folder, and the Knowledge / Automations hubs respectively. */
export type View =
  | "meetings"
  | "search"
  | "chat"
  | "tasks"
  | "knowledge"
  | "automations"
  | "settings";

/** Internal tabs of the two hubs. */
export type KnowledgeTab = "reports" | "wiki" | "people";
export type AutomationsTab = "rules" | "library";

/** A navigation request. The sidebar and bottom bar emit bare views; the command
 * palette emits richer targets so a ⌘K deep-link can land on a specific hub tab
 * or on the Meetings "Shared with me" smart folder. */
export interface NavTarget {
  view: View;
  /** For `knowledge` / `automations` — which internal tab to open. */
  hubTab?: KnowledgeTab | AutomationsTab;
  /** For `meetings` — open the "Shared with me" smart folder. */
  shared?: boolean;
}

/** Custom drag MIME types so drops can tell meetings and folders apart. */
export const DND_MEETING = "application/x-lalela-meeting";
export const DND_PROJECT = "application/x-lalela-project";

const EXPANDED_KEY = "lalela.sidebar.expanded";

interface SidebarProps {
  active: View;
  onNavigate: (view: View) => void;
  onNewRecording: () => void;
  /** Start a quick mic-only voice memo (Wave B1). */
  onNewVoiceMemo: () => void;
  /** Create an empty note and open it, composer focused (Wave B1). */
  onNewBlankNote: () => void;
  onOpenHelp: () => void;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onNewProject: (parentId: string | null) => void;
  onRenameProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  /** Star/unstar a folder (A6, local-only). Starred folders sort to the top of
   * their sibling level and show a filled star. */
  onToggleProjectFavorite: (project: Project) => void;
  /** Drop handlers (desktop drag-and-drop). */
  onMoveMeeting: (meetingId: string, projectId: string | null) => void;
  onReparentProject: (id: string, parentId: string | null) => void;
  /** Folders with team members (mine shared out + others' shared to me). */
  sharedProjectIds?: Set<string>;
  /** True when the "Shared with me" smart folder is the active Meetings scope. */
  sharedActive?: boolean;
  /** Open the "Shared with me" smart folder (a Meetings scope, not a view). */
  onSelectShared: () => void;
  /** Auto-sort "To sort" smart folder (a Meetings scope): queue size, active
   * flag, and opener. Hidden when `onSelectSort` is absent. */
  sortCount?: number;
  sortActive?: boolean;
  onSelectSort?: () => void;
  /** Open Settings → Account (the sign-in surface). Shown in the bottom group
   * only when signed out. */
  onSignIn: () => void;
}

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({
  active,
  onNavigate,
  onNewRecording,
  onNewVoiceMemo,
  onNewBlankNote,
  onOpenHelp,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  onToggleProjectFavorite,
  onMoveMeeting,
  onReparentProject,
  sharedProjectIds,
  sharedActive = false,
  onSelectShared,
  sortCount = 0,
  sortActive = false,
  onSelectSort,
  onSignIn,
}: SidebarProps) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragOverId, setDragOverId] = useState<string | null>(null); // "" = All meetings
  // Right-click menu on a folder row.
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Folder tree. Folders whose parent is missing (e.g. imported data) render
  // as roots rather than disappearing. Within each sibling level, starred
  // folders float to the top (stable sort keeps the incoming name order among
  // equals — `projects` arrives name-sorted from the backend).
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id));
    const childrenOf = new Map<string, Project[]>();
    const roots: Project[] = [];
    for (const p of projects) {
      if (p.parent_id && ids.has(p.parent_id)) {
        const list = childrenOf.get(p.parent_id) ?? [];
        list.push(p);
        childrenOf.set(p.parent_id, list);
      } else {
        roots.push(p);
      }
    }
    const starredFirst = (a: Project, b: Project) =>
      Number(b.is_favorite) - Number(a.is_favorite);
    roots.sort(starredFirst);
    for (const list of childrenOf.values()) list.sort(starredFirst);
    return { roots, childrenOf };
  }, [projects]);

  const isDescendant = (ancestorId: string, id: string | null): boolean => {
    if (!id) return false;
    if (id === ancestorId) return true;
    for (const child of childrenOf.get(ancestorId) ?? []) {
      if (isDescendant(child.id, id) || child.id === id) return true;
    }
    return false;
  };

  const dndProps = (targetProjectId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (
        e.dataTransfer.types.includes(DND_MEETING) ||
        e.dataTransfer.types.includes(DND_PROJECT)
      ) {
        e.preventDefault();
        setDragOverId(targetProjectId ?? "");
      }
    },
    onDragLeave: () => setDragOverId(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverId(null);
      const meetingId = e.dataTransfer.getData(DND_MEETING);
      if (meetingId) {
        onMoveMeeting(meetingId, targetProjectId);
        return;
      }
      const projectId = e.dataTransfer.getData(DND_PROJECT);
      if (projectId && projectId !== targetProjectId) {
        // Frontend cycle check; the backend enforces it too.
        if (targetProjectId && isDescendant(projectId, targetProjectId)) return;
        onReparentProject(projectId, targetProjectId);
      }
    },
  });

  // A top-level Meetings nav item counts as active only when no smart folder
  // (Shared) is overriding the scope.
  const navItem = (id: View, label: string, Icon: typeof FileText, soon = false) => {
    const isActive = active === id && (id !== "meetings" || !sharedActive);
    return (
      <button
        data-tour-id={`nav-${id}`}
        onClick={() => !soon && onNavigate(id)}
        disabled={soon}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
          isActive
            ? "bg-primary/15 font-semibold text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          soon && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        {soon && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            Soon
          </span>
        )}
      </button>
    );
  };

  // Right-click menu for a folder row: Open · Star · New subfolder · Rename ·
  // Delete (reuses the existing handlers — Rename/Delete go through the app's
  // dialogs).
  const folderMenuItems = (p: Project): ContextMenuItem[] => [
    {
      label: "Open",
      icon: <Folder className="h-4 w-4" />,
      onClick: () => onSelectProject(p.id),
    },
    {
      label: p.is_favorite ? "Remove star" : "Star",
      icon: <Star className={cn("h-4 w-4", p.is_favorite && "fill-current text-warning")} />,
      onClick: () => onToggleProjectFavorite(p),
    },
    {
      label: "New subfolder",
      icon: <Plus className="h-4 w-4" />,
      onClick: () => {
        if (!expanded.has(p.id)) toggleExpanded(p.id);
        onNewProject(p.id);
      },
    },
    {
      label: "Rename",
      icon: <Pencil className="h-4 w-4" />,
      separatorBefore: true,
      onClick: () => onRenameProject(p),
    },
    {
      label: "Delete",
      icon: <Trash2 className="h-4 w-4" />,
      danger: true,
      onClick: () => onDeleteProject(p),
    },
  ];

  const renderNode = (p: Project, depth: number): React.ReactNode => {
    const children = childrenOf.get(p.id) ?? [];
    const isExpanded = expanded.has(p.id);
    return (
      <div key={p.id}>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_PROJECT, p.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, project: p });
          }}
          {...dndProps(p.id)}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-[var(--radius)] py-2 pr-2 text-sm transition-colors",
            active === "meetings" && !sharedActive && !sortActive && selectedProjectId === p.id
              ? "bg-primary/15 font-semibold text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
            dragOverId === p.id && "bg-accent/10 ring-1 ring-accent",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(p.id);
            }}
            className={cn(
              "shrink-0 rounded p-0.5",
              children.length === 0 && "pointer-events-none opacity-0",
            )}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}
            />
          </button>
          <button
            onClick={() => onSelectProject(p.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate" title={p.name}>
              {p.name}
            </span>
            {sharedProjectIds?.has(p.id) && (
              <span
                title="Shared with your team"
                aria-label="Shared with your team"
                className="shrink-0"
              >
                <Users className="h-3 w-3 text-muted-foreground" />
              </span>
            )}
          </button>
          {/* ONE star per row that IS the toggle: filled + always visible when
              starred (click to unstar), outline + hover-only when not. The
              other row actions use `hidden` (not `opacity-0`) so they claim NO
              width at rest — otherwise they'd steal ~60px and clip longer
              folder names (e.g. "Microsoft Teams"). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleProjectFavorite(p);
            }}
            title={p.is_favorite ? "Remove star" : "Star folder"}
            aria-pressed={p.is_favorite}
            className={cn(
              "shrink-0 rounded p-0.5",
              p.is_favorite
                ? "inline-flex text-warning hover:text-warning/80"
                : "hidden hover:text-foreground group-hover:inline-flex",
            )}
          >
            <Star className={cn("h-3.5 w-3.5", p.is_favorite && "fill-current")} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!expanded.has(p.id)) toggleExpanded(p.id);
              onNewProject(p.id);
            }}
            title="New subfolder"
            className="hidden shrink-0 rounded p-0.5 hover:text-foreground group-hover:inline-flex"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRenameProject(p);
            }}
            title="Rename folder"
            className="hidden shrink-0 rounded p-0.5 hover:text-foreground group-hover:inline-flex"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteProject(p);
            }}
            title="Delete folder"
            className="hidden shrink-0 rounded p-0.5 hover:text-danger group-hover:inline-flex"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {isExpanded && children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="flex h-full w-72 flex-col border-r border-border bg-surface">
      <div className="px-4 pt-4 pb-3">
        <Logo />
      </div>

      <div className="px-3 pb-3">
        <NewMenu
          tourId="new-recording"
          fullWidth
          onRecordMeeting={onNewRecording}
          onVoiceMemo={onNewVoiceMemo}
          onBlankNote={onNewBlankNote}
        />
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {navItem("meetings", "Meetings", FileText)}
        {navItem("tasks", "Tasks", ListTodo)}
        {navItem("chat", "Chat", MessagesSquare)}
        {navItem("knowledge", "Knowledge", BookOpen)}
        {navItem("automations", "Automations", Zap)}

        <div className="px-3 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Folders
        </div>

        <button
          onClick={() => onSelectProject(null)}
          {...dndProps(null)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
            active === "meetings" && !sharedActive && !sortActive && selectedProjectId === null
              ? "bg-primary/15 font-semibold text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
            dragOverId === "" && "bg-accent/10 ring-1 ring-accent",
          )}
          title="All meetings (drop here to unfile)"
        >
          <FolderClosed className="h-4 w-4" />
          <span className="flex-1 text-left">All meetings</span>
        </button>

        {/* Auto-sort review queue — a Meetings scope like "Shared with me". */}
        {onSelectSort && (
          <button
            onClick={onSelectSort}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
              active === "meetings" && sortActive
                ? "bg-primary/15 font-semibold text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title="Meetings waiting to be sorted into a folder"
          >
            <Inbox className="h-4 w-4" />
            <span className="flex-1 text-left">To sort</span>
            {sortCount > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                {sortCount}
              </span>
            )}
          </button>
        )}

        {roots.map((p) => renderNode(p, 0))}

        <button
          onClick={() => onNewProject(null)}
          className="flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
          <span className="flex-1 text-left">New folder</span>
        </button>

        {/* Separate "Shared" section so a user's OWN folders above can't be
            misread as shared. "Shared with me" is a smart folder (a Meetings
            scope), not a view — it renders the shared-meetings grouping inside
            the Meetings surface. Sharing is cloud-only: none in Community. */}
        {!IS_COMMUNITY && (
        <>
        <div className="px-3 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Shared
        </div>

        <button
          onClick={onSelectShared}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
            active === "meetings" && sharedActive
              ? "bg-primary/15 font-semibold text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          title="Meetings teammates shared with you"
        >
          <Users className="h-4 w-4" />
          <span className="flex-1 text-left">Shared with me</span>
        </button>
        </>
        )}
      </nav>

      <div className="border-t border-border p-2">
        {!user && !IS_COMMUNITY && (
          <button
            onClick={onSignIn}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogIn className="h-4 w-4" />
            Sign in
          </button>
        )}
        <button
          data-tour-id="open-help"
          onClick={onOpenHelp}
          className="flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <CircleHelp className="h-4 w-4" />
          Help & guide
        </button>
        <button
          data-tour-id="nav-settings"
          onClick={() => onNavigate("settings")}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
            active === "settings"
              ? "bg-primary/15 font-semibold text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={folderMenuItems(menu.project)}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
