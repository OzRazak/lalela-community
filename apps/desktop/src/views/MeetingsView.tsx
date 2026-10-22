import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Mic,
  FileText,
  FileUp,
  FolderUp,
  ChevronDown,
  CheckCircle2,
  MessagesSquare,
  Users,
  Star,
  Folder,
  FolderInput,
  Trash2,
  X,
  CalendarClock,
} from "lucide-react";
// Amp: the teaching empty state + first-session orientation card.
import { EmptyState, Welcome } from "@auxo/amp-primitives";
import {
  listMeetings,
  listMeetingsIn,
  descendantProjectIds,
  formatDate,
  formatTime,
  groupByDay,
  flattenProjectTree,
  setMeetingFavorite,
  deleteMeeting,
  pickImportFile,
  pickImportFolder,
  scanImportFolder,
  importPreview,
  isAudioImportPath,
  type FolderImportFile,
  type ImportPreview,
  type MeetingMeta,
  type Project,
} from "@/lib/lalela";
import {
  getEffectiveFolderRecursive,
  setFolderRecursiveOverride,
} from "@/lib/settings";
import { ContextMenu, type ContextMenuItem } from "@/components/ContextMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NewMenu } from "@/components/NewMenu";
import { cn } from "@/lib/utils";
import { DEVICE_NOUN, IS_IOS, IS_IPAD, IS_MOBILE } from "@/lib/platform";
import { ChatThread } from "@/components/ChatThread";
import { buildFolderContext, CHAT_SYSTEM_PROMPT } from "@/lib/chatContext";
import { ShareDialog } from "@/components/ShareDialog";
import { ImportDialog } from "@/components/ImportDialog";
import { AudioImportDialog } from "@/components/AudioImportDialog";
import { BulkImportDialog } from "@/components/BulkImportDialog";
import { WatchSync } from "@/components/WatchSync";
import { ComingUp } from "@/components/ComingUp";
import { TagChipRow } from "@/components/TagChips";
import { listMeetingTags, listTags, type Tag } from "@/lib/tags";
import { useAuth } from "@/lib/auth";
import { FolderAutomationsDialog } from "@/components/folders/FolderAutomationsDialog";
import { FolderReports } from "@/components/folders/FolderReports";

interface MeetingsViewProps {
  onNewRecording: () => void;
  /** Start a quick mic-only voice memo (Wave B1). */
  onNewVoiceMemo: () => void;
  /** Create an empty note and open it, composer focused (Wave B1). */
  onNewBlankNote: () => void;
  onOpenMeeting: (id: string) => void;
  /** Open a meeting as if it just finished recording (auto-title/summary) —
   * used by audio imports (Slice 7). */
  onOpenFreshMeeting: (id: string) => void;
  projectId: string | null;
  projectName: string;
  refreshKey: number;
  /** The selected folder's row (null on "All meetings"). */
  project: Project | null;
  /** All folders, for the right-click "Move to folder" submenu. */
  projects: Project[];
  /** Move a meeting into a folder (null = Unfiled) — reuses the app handler. */
  onMoveMeeting: (meetingId: string, projectId: string | null) => void;
  /** Notify the app after a mutation (delete) so counts/other views refresh. */
  onMeetingsChanged: () => void;
  isShared: boolean;
  onSharedChanged: () => void;
}

/** Single "Import" trigger with a two-item popover (file vs folder). There is no
 * menu primitive in the app or the Amp kit, so this is hand-rolled with the same
 * pattern as TagChips: an open flag + an outside-click mousedown listener. */
function ImportMenu({
  onImportFile,
  onImportFolder,
}: {
  onImportFile: () => void;
  onImportFolder: () => void;
}) {
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

  return (
    <div className="relative" ref={ref}>
      <Button
        data-tour-id="import-meeting"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        title="Import an external transcript, notes or recording"
      >
        <FileUp className="h-4 w-4" />
        Import
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-[var(--radius)] border border-border bg-card p-2 shadow-lg">
          <button
            onClick={() => pick(onImportFile)}
            className="flex w-full items-start gap-3 rounded-[var(--radius)] px-2.5 py-2 text-left hover:bg-muted"
          >
            <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Import file…</span>
              <span className="block text-xs text-muted-foreground">
                Transcript, notes or a recording (DOCX, PDF, TXT, MD, VTT, audio/video)
              </span>
            </span>
          </button>
          <button
            onClick={() => pick(onImportFolder)}
            className="mt-0.5 flex w-full items-start gap-3 rounded-[var(--radius)] px-2.5 py-2 text-left hover:bg-muted"
          >
            <FolderUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Import folder…</span>
              <span className="block text-xs text-muted-foreground">
                Bulk-import a whole folder in one pass
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function MeetingsView({
  onNewRecording,
  onNewVoiceMemo,
  onNewBlankNote,
  onOpenMeeting,
  onOpenFreshMeeting,
  projectId,
  projectName,
  refreshKey,
  project,
  projects,
  onMoveMeeting,
  onMeetingsChanged,
  isShared,
  onSharedChanged,
}: MeetingsViewProps) {
  const [meetings, setMeetings] = useState<MeetingMeta[] | null>(null);
  // Right-click menu target + the meeting queued for delete confirmation.
  const [menu, setMenu] = useState<{ x: number; y: number; meeting: MeetingMeta } | null>(null);
  const [deleting, setDeleting] = useState<MeetingMeta | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [automating, setAutomating] = useState(false);
  const [importing, setImporting] = useState<{ preview: ImportPreview; filename: string } | null>(
    null,
  );
  const [importingAudio, setImportingAudio] = useState<{ path: string; filename: string } | null>(
    null,
  );
  const [bulkImport, setBulkImport] = useState<{
    folder: string;
    files: FolderImportFile[];
  } | null>(null);
  // Bumped when a bulk import saves meetings, so the list reloads.
  const [importBump, setImportBump] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const { user } = useAuth();

  // Folder "include subfolders" mode. `recursive` is the EFFECTIVE mode for the
  // folder now on screen: its per-folder override if it has one, else the global
  // Settings default (see lib/settings). It resets whenever the folder changes.
  // Flipping the header toggle writes a per-folder override so it sticks for THIS
  // folder only and never surprises the others.
  const [recursive, setRecursive] = useState(() =>
    projectId ? getEffectiveFolderRecursive(projectId) : false,
  );
  useEffect(() => {
    setRecursive(projectId ? getEffectiveFolderRecursive(projectId) : false);
  }, [projectId]);

  // The folder itself ∪ all its descendant folders. Memoized so it's a stable
  // fetch dependency. `hasSubfolders` (more than just the folder itself) gates
  // whether the header toggle is worth showing at all.
  const descendantIds = useMemo(
    () => (projectId ? descendantProjectIds(projects, projectId) : []),
    [projects, projectId],
  );
  const descendantKey = descendantIds.join(",");
  const hasSubfolders = descendantIds.length > 1;
  // Recursive fetch only makes sense for a real folder that actually has
  // subfolders; otherwise fall back to the plain single-folder path.
  const effectiveRecursive = recursive && projectId !== null && hasSubfolders;

  const changeScope = (next: boolean) => {
    if (!projectId) return;
    setFolderRecursiveOverride(projectId, next);
    setRecursive(next);
  };

  const startImport = async () => {
    setImportError(null);
    try {
      const path = await pickImportFile();
      if (!path) return;
      // Windows paths use backslashes — split on both so the title is the
      // bare file name ("clip1"), not the whole "E:\…\clip1" path.
      const filename = path.split(/[\\/]/).pop() ?? path;
      // Recordings go through the audio pipeline (Slice 7); text files
      // through the transcript parser (Slice 2).
      if (isAudioImportPath(path)) {
        setImportingAudio({ path, filename });
        return;
      }
      const preview = await importPreview(path);
      setImporting({ preview, filename });
    } catch (e) {
      setImportError(String(e));
    }
  };

  const startFolderImport = async () => {
    setImportError(null);
    try {
      const folder = await pickImportFolder();
      if (!folder) return;
      const files = await scanImportFolder(folder);
      setBulkImport({ folder, files });
    } catch (e) {
      setImportError(String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    // "Include subfolders" fans out to the descendant folder set in one query;
    // otherwise it's the unchanged single-folder (or All-meetings) path.
    const load = effectiveRecursive ? listMeetingsIn(descendantIds) : listMeetings(projectId);
    load
      .then((m) => !cancelled && setMeetings(m))
      .catch(() => !cancelled && setMeetings([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, importBump, effectiveRecursive, descendantKey]);

  // Tag chips on list rows: one load for all rows, keyed by meeting id.
  const [tagsByMeeting, setTagsByMeeting] = useState<Map<string, Tag[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    Promise.all([listTags(), listMeetingTags()])
      .then(([tags, mts]) => {
        if (cancelled) return;
        const byId = new Map(tags.map((t) => [t.id, t]));
        const map = new Map<string, Tag[]>();
        for (const mt of mts) {
          const tag = byId.get(mt.tag_id);
          if (!tag) continue;
          const list = map.get(mt.meeting_id) ?? [];
          list.push(tag);
          map.set(mt.meeting_id, list);
        }
        setTagsByMeeting(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  // Star/unstar is a LOCAL-ONLY preference: update the row optimistically and
  // persist; on failure, revert. Never touches cloud sync.
  const toggleFavorite = (m: MeetingMeta) => {
    const next = !m.is_favorite;
    setMeetings((prev) =>
      prev ? prev.map((x) => (x.id === m.id ? { ...x, is_favorite: next } : x)) : prev,
    );
    setMeetingFavorite(m.id, next).catch(() =>
      setMeetings((prev) =>
        prev ? prev.map((x) => (x.id === m.id ? { ...x, is_favorite: !next } : x)) : prev,
      ),
    );
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    await deleteMeeting(id);
    setMeetings((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
    onMeetingsChanged();
  };

  // Right-click menu contents for a meeting row: Open · Star · Move to folder
  // (submenu reusing the drag-to-file mechanism) · Delete (confirm dialog).
  const menuItems = (m: MeetingMeta): ContextMenuItem[] => {
    const folderItems: ContextMenuItem[] = [
      {
        label: "No folder",
        icon: <FileText className="h-3.5 w-3.5" />,
        active: m.project_id === null,
        onClick: () => onMoveMeeting(m.id, null),
      },
      ...flattenProjectTree(projects).map(({ project: p }) => ({
        label: p.name,
        icon: <Folder className="h-3.5 w-3.5" />,
        active: m.project_id === p.id,
        onClick: () => onMoveMeeting(m.id, p.id),
      })),
    ];
    return [
      {
        label: "Open",
        icon: <FileText className="h-4 w-4" />,
        onClick: () => onOpenMeeting(m.id),
      },
      {
        label: m.is_favorite ? "Remove star" : "Star",
        icon: <Star className={cn("h-4 w-4", m.is_favorite && "fill-current text-warning")} />,
        onClick: () => toggleFavorite(m),
      },
      {
        label: "Move to folder",
        icon: <FolderInput className="h-4 w-4" />,
        submenu: folderItems,
      },
      {
        label: "Delete",
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        separatorBefore: true,
        onClick: () => setDeleting(m),
      },
    ];
  };

  // One meeting row. `dateMode` shows the full date in the mixed-day "Starred"
  // group, and just the clock time inside a single-day group (the day is in the
  // header). The star toggle sits outside the open-button so there's no nested
  // <button>, and the whole row opens a right-click menu (desktop only).
  const renderRow = (m: MeetingMeta, dateMode: "full" | "time") => (
    <div
      key={m.id}
      draggable={!IS_MOBILE}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-lalela-meeting", m.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(e) => {
        if (IS_MOBILE) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, meeting: m });
      }}
      className="group flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 transition-colors hover:bg-muted"
    >
      <button
        onClick={() => onOpenMeeting(m.id)}
        title={IS_MOBILE ? "Open meeting" : "Open — right-click for more actions"}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-3 text-left active:cursor-grabbing"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{m.title}</div>
          <div className="text-xs text-muted-foreground">
            {dateMode === "time" ? formatTime(m.created_at) : formatDate(m.created_at)}
          </div>
          {m.snippet && (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{m.snippet}</div>
          )}
          <TagChipRow tags={tagsByMeeting.get(m.id) ?? []} />
        </div>
      </button>
      {m.has_summary && (
        <span className="flex items-center gap-1 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Summary
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(m);
        }}
        aria-pressed={m.is_favorite}
        title={m.is_favorite ? "Remove star" : "Star this meeting"}
        className={cn(
          "shrink-0 rounded p-1.5 transition-colors",
          m.is_favorite
            ? "text-warning hover:text-warning/80"
            : "text-muted-foreground hover:text-foreground",
          // Hover-only at rest on desktop; always visible when starred, on
          // mobile (no hover), or when focused for keyboard users.
          !m.is_favorite && !IS_MOBILE && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
        )}
      >
        <Star className={cn("h-4 w-4", m.is_favorite && "fill-current")} />
      </button>
    </div>
  );

  // Split favourites into a pinned "Starred" section, then day-group the rest
  // (Today / Yesterday / "Monday 14 July"). The list is already created_at DESC.
  const favorites = (meetings ?? []).filter((m) => m.is_favorite);
  const rest = (meetings ?? []).filter((m) => !m.is_favorite);
  const dayGroups = groupByDay(rest, (m) => m.created_at);

  const groupHeader = (label: string, starred = false) => (
    <div className="flex items-center gap-1.5 px-1 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:pt-0">
      {starred && <Star className="h-3.5 w-3.5 fill-current text-warning" />}
      {label}
    </div>
  );

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {projectName}
            {isShared && (
              <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-foreground">
                <Users className="h-3 w-3" />
                Shared
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your recordings, transcripts and notes.
          </p>
        </div>
        {!IS_MOBILE && (
          <div className="flex items-center gap-2">
            {/* Folder scope: list only this folder's meetings, or also its
                subfolders'. Shown only for a real folder that HAS subfolders —
                "All meetings" and leaf folders render nothing. Initializes from
                the global Settings default; flipping it remembers this folder's
                choice (per-folder override). */}
            {project && hasSubfolders && (
              <div
                role="group"
                aria-label="Folder scope"
                className="inline-flex items-center rounded-[var(--radius)] border border-border p-0.5 text-xs"
              >
                <button
                  onClick={() => changeScope(false)}
                  aria-pressed={!recursive}
                  title="List only meetings filed directly in this folder"
                  className={cn(
                    "rounded-[calc(var(--radius)-2px)] px-2.5 py-1 transition-colors",
                    !recursive
                      ? "bg-primary/15 font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  This folder
                </button>
                <button
                  onClick={() => changeScope(true)}
                  aria-pressed={recursive}
                  title="Also list meetings from every subfolder"
                  className={cn(
                    "rounded-[calc(var(--radius)-2px)] px-2.5 py-1 transition-colors",
                    recursive
                      ? "bg-primary/15 font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Include subfolders
                </button>
              </div>
            )}
            {project && (
              <Button
                variant="outline"
                onClick={() => setAutomating(true)}
                title={`Automations for this folder: scheduled digests and rules for ${projectName}`}
              >
                <CalendarClock className="h-4 w-4" />
                Automations
              </Button>
            )}
            {project && user && (
              <Button
                variant="outline"
                onClick={() => setSharing(true)}
                title={`Invite teammates to ${projectName} (subfolders included)`}
              >
                <Users className="h-4 w-4" />
                Share
              </Button>
            )}
            <Button
              variant={chatOpen ? "accent" : "outline"}
              onClick={() => setChatOpen((v) => !v)}
              title={`Ask questions grounded in the meetings of ${projectName}`}
            >
              <MessagesSquare className="h-4 w-4" />
              Chat
            </Button>
            <ImportMenu onImportFile={startImport} onImportFolder={startFolderImport} />
            <NewMenu
              onRecordMeeting={onNewRecording}
              onVoiceMemo={onNewVoiceMemo}
              onBlankNote={onNewBlankNote}
            />
          </div>
        )}
      </header>

      {/* Apple Watch sync visibility + manual trigger — mobile only. Shows a
          status pill while recordings are importing / waiting on the wrist, and
          an always-available "Sync from Watch" control. */}
      {/* iPad can't pair an Apple Watch — no "Sync from Watch" there. */}
      {IS_IOS && !IS_IPAD && <WatchSync />}

      {sharing && project && (
        <ShareDialog
          projectId={project.id}
          projectName={project.name}
          projectCreatedMs={project.created_at}
          onClose={() => {
            setSharing(false);
            onSharedChanged();
          }}
        />
      )}

      {automating && project && (
        <FolderAutomationsDialog
          projectId={project.id}
          projectName={project.name}
          hasSubfolders={hasSubfolders}
          onClose={() => setAutomating(false)}
        />
      )}

      {/* Folder reports: digests from this folder's automations, newest first
          (self-hides when there are none). Follows the "include subfolders"
          toggle like the list. */}
      {!IS_MOBILE && project && (
        <FolderReports projectIds={effectiveRecursive ? descendantIds : [project.id]} />
      )}

      {importError && (
        <div className="border-b border-danger/30 bg-danger/10 px-6 py-2 text-sm text-danger">
          {importError}
        </div>
      )}
      {importing && (
        <ImportDialog
          preview={importing.preview}
          filename={importing.filename}
          projectId={projectId}
          projectName={projectName}
          onSaved={(m) => {
            setImporting(null);
            onOpenMeeting(m.id);
          }}
          onClose={() => setImporting(null)}
        />
      )}
      {importingAudio && (
        <AudioImportDialog
          path={importingAudio.path}
          filename={importingAudio.filename}
          projectId={projectId}
          projectName={projectName}
          onSaved={(m) => {
            setImportingAudio(null);
            onOpenFreshMeeting(m.id);
          }}
          onClose={() => setImportingAudio(null)}
        />
      )}
      {bulkImport && (
        <BulkImportDialog
          folder={bulkImport.folder}
          files={bulkImport.files}
          projectId={projectId}
          projectName={projectName}
          onImported={() => setImportBump((n) => n + 1)}
          onClose={() => setBulkImport(null)}
        />
      )}

      {/* First-session orientation card (Amp <Welcome>) — only on the top-level
          meetings home, dismissible, remembered. Answers where-am-I /
          what-can-I-do / one-next-step for a brand-new user. */}
      {!IS_MOBILE && projectId === null && (
        <div className="px-6 pt-4">
          <div className="mx-auto max-w-3xl">
            <Welcome
              id="lalela-home"
              title="Welcome to Lalela"
              body={`Your private meeting notetaker. Recording and transcription happen on your ${DEVICE_NOUN} — no bot joins the call, and nothing leaves it unless you choose to sync or allow cloud AI. Meetings land in this list; Tasks, Chat and Knowledge grow from them.`}
              nextStep={{ label: "Start your first recording", onClick: onNewRecording }}
            />
          </div>
        </div>
      )}

      {/* Granola-style "Coming up" rail — the next few calendar events, each
          recordable in one click. Self-hides unless Microsoft is connected and
          the week has events (see ComingUp); desktop-only. */}
      {!IS_MOBILE && <ComingUp onRecord={onNewRecording} onOpenMeeting={onOpenMeeting} />}

      {meetings && meetings.length > 0 ? (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl">
            {!IS_MOBILE && (
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                Tip: right-click a meeting for actions, or drag it onto a sidebar folder to
                file it. Star a meeting to pin it to the top.
              </p>
            )}
            {favorites.length > 0 && (
              <section>
                {groupHeader("Starred", true)}
                <div className="space-y-2">{favorites.map((m) => renderRow(m, "full"))}</div>
              </section>
            )}
            {dayGroups.map((g) => (
              <section key={g.key}>
                {groupHeader(g.label)}
                <div className="space-y-2">{g.items.map((m) => renderRow(m, "time"))}</div>
              </section>
            ))}
          </div>
        </div>
      ) : meetings === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        // Teaching empty state (Amp <EmptyState>): the Spark idle mark at dial 2,
        // copy that says what belongs here + the one next step. Same CTA, same
        // functionality — now with wayfinding.
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            title="No meetings yet"
            body={
              IS_MOBILE
                ? "Lalela records with your phone's microphone and transcribes on-device — no bot joins the call. Start a recording and it lands here automatically. Private by design: audio is discarded after transcription."
                : "Lalela records your mic and your device's system audio — no bot joins the call. Start a recording and it lands here automatically. Private by design: audio is discarded after transcription."
            }
            action={
              <Button size="lg" onClick={onNewRecording}>
                <Mic className="h-4 w-4" />
                Start your first recording
              </Button>
            }
          />
        </div>
      )}
      </div>

      {!IS_MOBILE && chatOpen && (
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">Chat · {projectName}</span>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Close chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Keyed by folder so switching folders starts a fresh thread. The chat
              honours the SAME "include subfolders" toggle as the list: in recursive
              mode its grounding (meeting set + FTS excerpts) draws from the folder ∪
              its descendants. buildContext is read fresh at ask time, so flipping
              the toggle re-scopes the next question without wiping history. */}
          <ChatThread
            key={projectId ?? "all"}
            compact
            scope="folder"
            scopeId={projectId ?? undefined}
            buildContext={(question) =>
              buildFolderContext(
                projectId,
                question,
                effectiveRecursive ? descendantIds : undefined,
              )
            }
            systemPrompt={CHAT_SYSTEM_PROMPT}
            placeholder={`Ask about ${projectName}…`}
            busyLabel={
              effectiveRecursive ? "Reading this folder + subfolders…" : "Reading this folder…"
            }
            emptyHint={
              effectiveRecursive ? (
                <>
                  Answers are grounded in the meetings of this folder and its subfolders — try
                  "Summarize where this project stands" or "What's still open?"
                </>
              ) : (
                <>
                  Answers are grounded in the meetings of this folder — try "Summarize where
                  this project stands" or "What's still open?"
                </>
              )
            }
          />
        </aside>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.meeting)}
          onClose={() => setMenu(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.title}”?`}
          body="This removes the meeting from Lalela on this device. The Markdown folder on disk is left untouched."
          confirmLabel="Delete meeting"
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
