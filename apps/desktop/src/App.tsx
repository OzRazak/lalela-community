import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sidebar,
  type View,
  type NavTarget,
  type KnowledgeTab,
  type AutomationsTab,
} from "@/components/Sidebar";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/Logo";
import { MeetingsView } from "@/views/MeetingsView";
import { SearchView } from "@/views/SearchView";
import { SettingsView, type SettingsTab } from "@/views/SettingsView";
import { RecordingView } from "@/views/RecordingView";
import { MeetingDetailView } from "@/views/MeetingDetailView";
import { ConsentDialog } from "@/components/ConsentDialog";
import { SharedView } from "@/views/SharedView";
import { AutoSortView } from "@/views/AutoSortView";
import { installAutoSortHooks, onSortChanged, sortStats } from "@/lib/autoSort";
import { ChatView } from "@/views/ChatView";
import { KnowledgeView } from "@/views/KnowledgeView";
import { TasksView } from "@/views/TasksView";
import { AutomationsView } from "@/views/AutomationsView";
import { TopBar } from "@/components/TopBar";
import { NotificationBell } from "@/components/NotificationBell";
import { CommandPalette } from "@/components/CommandPalette";
import { GuideDialog } from "@/components/GuideDialog";
import { HelpMenu } from "@/components/HelpMenu";
import { VideoModal } from "@/components/VideoModal";
import { getVideoById, type FeatureVideo } from "@/lib/videos";
import { IrisWidget } from "@/components/IrisWidget";
import { cn } from "@/lib/utils";
import { getTourById, type Tour } from "@/lib/tours";
// Amp (Wave 7 Lalela Pass): the shared <Tour> (lalela's own engine, generalized
// upstream in auxo-amp), the typed <Milestone>, and <SoberZone> for the
// consent/destructive surfaces registered in auxo-design.json.
import { Tour as AmpTour, Milestone } from "@auxo/amp-primitives";
import { SoberZone } from "@auxo/amp-react";
import { OnboardingView } from "@/views/OnboardingView";
import { trackEvent } from "@/lib/analytics";
import { UpdateBanner } from "@/components/UpdateBanner";
import { BottomTabBar } from "@/components/BottomTabBar";
import { IS_MOBILE } from "@/lib/platform";
import { IS_COMMUNITY } from "@/lib/edition";
import { listen } from "@tauri-apps/api/event";
import { startTrayAgenda } from "@/lib/trayAgenda";
import { DOSSIER_CHANGED_EVENT, startDossierScheduler } from "@/lib/dossiers";
import {
  getConsentEnabled,
  getAutoDetectEnabled,
  getOnboarded,
  isTaskOverdue,
  setOnboarded,
} from "@/lib/settings";
import { loadNotificationPrefs, notifyMeetingDetected } from "@/lib/notifications";
import {
  listProjects,
  listActionItems,
  saveMeeting,
  createProject,
  renameProject,
  deleteProject,
  setProjectParent,
  setProjectFavorite,
  moveMeetingToProject,
  setDetectionEnabled,
  onMeetingDetected,
  onWatchImported,
  createChatThread,
  appendChatMessage,
  type Project,
} from "@/lib/lalela";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { pushProject, deleteCloudProject } from "@/lib/sync";
import { recordSyncFailure, recordSyncSuccess } from "@/lib/syncStatus";
import {
  getMsImportEnabled,
  getMsImportLastRun,
  getMsBackfillDays,
  isMsConnected,
  setMsImportLastRun,
  setMsImportOutcome,
  type MsImportOutcome,
} from "@/lib/msauth";
import { classifyImportError, importTeamsTranscripts } from "@/lib/teamsImport";
import {
  evaluateAutomationsForMeeting,
  evaluateAutomationsForMeetingIds,
  installAutomationConsentResume,
} from "@/lib/automations";
import { runDueReports } from "@/lib/reports";
import { installFolderRuleScheduler } from "@/lib/folderRules";
import { Mic, Video, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { maybeQueueDomainNudge, clearTeammatesCache } from "@/lib/teammates";
import {
  syncUp,
  pullOwnCloudMeetings,
  pushMeeting,
  listSharedOutProjectIds,
  listSharedProjectNames,
} from "@/lib/sync";

// Safe-area insets keep the full-screen shell clear of the iOS status bar
// (iPad shows the clock/date in both orientations) and the notch / Dynamic
// Island side cutouts (iPhone landscape). Applied unconditionally on the
// top-level shells: env(safe-area-inset-*) resolves to 0 on the macOS webview,
// so the desktop app is visually unchanged. Bottom insets are handled per
// surface (BottomTabBar, scroll footers) so they aren't included here.
const SAFE_AREA_INSETS =
  "pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]";

type RecordingPhase = "consent" | "live" | null;

/**
 * Persist (and log) how a background Teams import ended, so Settings can show
 * it. This chain used to end in `.catch(() => {})`: when a tenant flag began
 * 403ing every transcript call on 2026-07-31, imports were dead for seven days
 * with nothing on screen and nothing written anywhere to find afterwards.
 */
function recordImportOutcome(outcome: MsImportOutcome): void {
  setMsImportOutcome(outcome);
  if (!outcome.ok) {
    console.error(
      `[teams-import] failed class=${outcome.errorClass} code=${outcome.code ?? "none"} ` +
        `scanned=${outcome.scanned} at=${new Date(outcome.at).toISOString()}: ` +
        (outcome.message ?? ""),
    );
  }
}

type ProjectDialog =
  | { mode: "create"; parentId: string | null }
  | { mode: "rename"; project: Project }
  | { mode: "delete"; project: Project }
  | null;

export default function App() {
  const [view, setView] = useState<View>("meetings");
  // Usage analytics: which of the destinations people actually use.
  useEffect(() => trackEvent("nav_view", { view }), [view]);
  // Which internal tab each hub is showing (persisted across navigation so a
  // ⌘K deep-link — or just re-opening the hub — lands where you expect).
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("reports");
  // Automations lands on Library first — a browsable shelf of prompts/templates
  // is a gentler entry than the (often empty) rules list. A ⌘K deep-link to
  // Rules still overrides this via the AutomationsTab prop.
  const [automationsTab, setAutomationsTab] = useState<AutomationsTab>("library");
  // The "Shared with me" smart folder is a Meetings scope, not a view.
  const [sharedActive, setSharedActive] = useState(false);
  // The auto-sort "To sort" smart folder — also a Meetings scope.
  const [sortActive, setSortActive] = useState(false);
  const [sortCount, setSortCount] = useState(0);
  const [phase, setPhase] = useState<RecordingPhase>(null);
  // Which recorder variant the live phase runs (Wave B1): a full meeting, or a
  // quick mic-only voice memo whose transcript becomes the note.
  const [recordMode, setRecordMode] = useState<"meeting" | "memo">("meeting");
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  // Set only when a meeting was just recorded — gates auto-title/auto-summary.
  const [freshMeetingId, setFreshMeetingId] = useState<string | null>(null);
  // Set only for a freshly-created blank note (Wave B1) — lands the user in the
  // note composer, focused and ready to type.
  const [notesFirstMeetingId, setNotesFirstMeetingId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeTour, setActiveTour] = useState<Tour | null>(null);
  const [activeVideo, setActiveVideo] = useState<FeatureVideo | null>(null);
  // Amp Milestone: the "first meeting captured" celebration. Shown once ever
  // (localStorage-guarded), briefly, as a quiet toast — dial 2 + a non-accent
  // MOMENT_KIND resolves to a spring-tick, never a burst (privacy product).
  const [showFirstMeetingMilestone, setShowFirstMeetingMilestone] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detectedSource, setDetectedSource] = useState<string | null>(null);
  const [onboarded, setOnboardedState] = useState(getOnboarded());
  // Which Settings tab to force-open on the next entry to the Settings view.
  // Set by the sidebar "Sign in" item and the top-bar usage chip so both deep
  // link to Settings → Account. Cleared whenever we leave Settings, so a normal
  // Settings navigation lands on the first tab.
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const { user } = useAuth();

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Open Settings and force the Account tab (the sign-in / free-allowance
  // surface). Reused by the sidebar "Sign in" item and the top-bar usage chip.
  const openSettingsAccount = useCallback(() => {
    setOpenMeetingId(null);
    setSharedActive(false);
    setSortActive(false);
    setSettingsInitialTab("account");
    setView("settings");
  }, []);

  // Fire the "first meeting captured" Milestone the first time (ever) a meeting
  // lands — by recording or import. Guarded by localStorage so it shows exactly
  // once; auto-hides after a few seconds. The <Milestone> itself is also
  // rate-limited, so this is belt-and-suspenders, never a repeat celebration.
  const celebrateFirstMeeting = useCallback(() => {
    try {
      if (localStorage.getItem("lalela:first-meeting-milestone")) return;
      localStorage.setItem("lalela:first-meeting-milestone", "1");
    } catch {
      /* private mode — fall through and still show it once this session */
    }
    setShowFirstMeetingMilestone(true);
    window.setTimeout(() => setShowFirstMeetingMilestone(false), 6000);
  }, []);

  // Single navigation entry point. Resolves a NavTarget (used by the command
  // palette for deep links; the sidebar/bottom-bar pass bare views) into view +
  // hub-tab + shared-scope state, and closes any open meeting.
  const navigate = useCallback((target: NavTarget) => {
    setOpenMeetingId(null);
    setSharedActive(target.view === "meetings" ? !!target.shared : false);
    setSortActive(false);
    if (target.view === "knowledge" && target.hubTab)
      setKnowledgeTab(target.hubTab as KnowledgeTab);
    if (target.view === "automations" && target.hubTab)
      setAutomationsTab(target.hubTab as AutomationsTab);
    setView(target.view);
  }, []);

  // Clear the forced Settings tab whenever we leave Settings, so a plain
  // Settings navigation next time lands on the first tab (not a stale Account).
  useEffect(() => {
    if (view !== "settings") setSettingsInitialTab(undefined);
  }, [view]);

  // Phase 8: sync the auto-detect toggle to the backend, and listen for
  // "a meeting looks like it started" → offer to record. Wave C3: also fire an
  // OS notification when the app isn't focused so the prompt isn't missed
  // (gated + debounced inside notifyMeetingDetected).
  useEffect(() => {
    setDetectionEnabled(getAutoDetectEnabled()).catch(() => {});
    void loadNotificationPrefs();
    let unlisten: (() => void) | undefined;
    onMeetingDetected((d) => {
      setDetectedSource(d.source);
      void notifyMeetingDetected(d);
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // Apple Watch companion: when the iOS launch/foreground scan imports a synced
  // recording, refresh the meeting list so it appears without a manual reload.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onWatchImported(() => refresh())
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [refresh]);

  // Don't keep the prompt up once a recording is underway.
  useEffect(() => {
    if (phase !== null) setDetectedSource(null);
  }, [phase]);

  // ⌘K / Ctrl+K command palette (desktop only, not while recording).
  useEffect(() => {
    if (IS_MOBILE) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [refreshKey]);

  // Overdue-task count → the Notifications nav badge. Recomputed on any data
  // refresh and on view changes (so moving/dating a task updates it promptly).
  const [overdueCount, setOverdueCount] = useState(0);
  useEffect(() => {
    listActionItems()
      .then((list) =>
        setOverdueCount(
          list.filter((i) => i.status !== "suggested" && isTaskOverdue(i.due, i.status)).length,
        ),
      )
      .catch(() => setOverdueCount(0));
  }, [refreshKey, view]);

  // Phase 20: on launch, run any scheduled reports (daily/weekly) that are due.
  // Fully fire-and-forget — never blocks the UI; a failure (e.g. no AI
  // configured) leaves the report's last_run_at untouched so it retries next
  // launch. Scheduled runs fire an OS notification on completion.
  useEffect(() => {
    runDueReports().catch(() => {});
  }, []);

  // Folder automations: run due per-folder rules shortly after launch, then on
  // an interval and on focus. Missed periods catch up once (not N times); the
  // local run ledger makes each period idempotent. See lib/folderRules.ts.
  useEffect(() => installFolderRuleScheduler(), []);

  // On sign-in, push local meetings/projects to the cloud (best-effort),
  // then pull down own cloud-created meetings (web recordings + connector
  // imports) that don't exist locally yet.
  // Keyed on the user ID, not the `user` object: Supabase hands out a fresh
  // session (and user object) on every token refresh, which used to re-fire
  // this effect and stack overlapping full pushes. syncUp is also single-flight.
  const lastPullAtRef = useRef(0);
  const uid = user?.id ?? null;
  useEffect(() => {
    if (!uid) return;
    syncUp(uid)
      .then((r) => {
        // A partial push is still a failed sync — the meetings that didn't
        // make it are exactly the ones the user thinks are backed up.
        if (r.failed > 0)
          recordSyncFailure(
            r.lastError ?? new Error(`${r.failed} item${r.failed === 1 ? "" : "s"} failed to sync`),
          );
        // Rows owned by other accounts are skips, not failures — the chip clears.
        else recordSyncSuccess({ skipped: r.skipped });
      })
      .catch((e) => {
        console.error("sync failed", e);
        recordSyncFailure(e);
      })
      .then(() => {
        lastPullAtRef.current = Date.now();
        // The shared automation_runs ledger makes cloud-pulled meetings a
        // no-op when the cloud engine already processed them (usually).
        return pullOwnCloudMeetings(uid, (ids) =>
          evaluateAutomationsForMeetingIds(ids).catch(() => {}),
        );
      })
      .then((imported) => {
        if (imported > 0) refresh();
      })
      .catch(() => {});
  }, [uid, refresh]);

  // Wave D2: after sign-in, queue the one-time "people from your company also
  // use Lalela" nudge (shown in the NotificationBell). Never repeats — the
  // helper guards on a localStorage seen-flag. Clears the cache on sign-out so a
  // different account doesn't inherit stale matches.
  useEffect(() => {
    if (!user) {
      clearTeammatesCache();
      return;
    }
    maybeQueueDomainNudge(user.email ?? null).catch(() => {});
  }, [user]);

  // Also pull on window focus, at most once per 5 minutes (best-effort).
  useEffect(() => {
    if (!uid) return;
    const PULL_INTERVAL_MS = 5 * 60 * 1000;
    const onFocus = () => {
      if (Date.now() - lastPullAtRef.current < PULL_INTERVAL_MS) return;
      lastPullAtRef.current = Date.now();
      pullOwnCloudMeetings(uid, (ids) =>
        evaluateAutomationsForMeetingIds(ids).catch(() => {}),
      )
        .then((imported) => {
          if (imported > 0) refresh();
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [uid, refresh]);

  // Slice 9: background Teams transcript import — on launch and window focus,
  // at most every 30 minutes, only when a Microsoft account is connected AND
  // the import toggle is on. Same guard pattern as the cloud pull above; the
  // last-run stamp lives in localStorage so restarts don't re-import
  // immediately (the import itself is idempotent regardless).
  useEffect(() => {
    if (IS_MOBILE) return;
    const IMPORT_INTERVAL_MS = 30 * 60 * 1000;
    const maybeImport = () => {
      if (!isMsConnected() || !getMsImportEnabled()) return;
      if (Date.now() - getMsImportLastRun() < IMPORT_INTERVAL_MS) return;
      setMsImportLastRun(Date.now());
      importTeamsTranscripts({
        days: getMsBackfillDays(),
        onImported: (ids) => evaluateAutomationsForMeetingIds(ids).catch(() => {}),
      })
        .then((outcome) => {
          recordImportOutcome(outcome);
          if (outcome.imported > 0) refresh();
        })
        .catch((e) => {
          // importTeamsTranscripts classifies Graph failures into its result,
          // so reaching here means an unexpected bug — record it too rather
          // than letting it disappear the way everything used to.
          recordImportOutcome({
            ok: false,
            at: Date.now(),
            scanned: 0,
            resolved: 0,
            unresolved: 0,
            refused: 0,
            imported: 0,
            ...classifyImportError(e),
          });
        });
    };
    maybeImport();
    window.addEventListener("focus", maybeImport);
    return () => window.removeEventListener("focus", maybeImport);
  }, [refresh]);

  // Wave C1: feed the menu-bar tray's "Upcoming" section — poll the calendar on
  // launch and every 5 min (empty push when not signed into Microsoft).
  useEffect(() => startTrayAgenda(), []);

  // CP2: automatic pre-meeting dossiers — the scheduler ticks on launch and
  // every 15 min, generating one briefing note per upcoming calendar event
  // (only when the feature is enabled AND Microsoft is connected; both are
  // guarded inside). No-op on mobile.
  useEffect(() => startDossierScheduler(), []);

  // Refresh the meetings list whenever a dossier note is saved so the new
  // "Prep: …" note appears without a manual reload.
  useEffect(() => {
    const onDossier = () => refresh();
    window.addEventListener(DOSSIER_CHANGED_EVENT, onDossier);
    return () => window.removeEventListener(DOSSIER_CHANGED_EVENT, onDossier);
  }, [refresh]);

  // Wave C1: the tray's "New recording" item routes through the exact same
  // path as the ⌘K palette / Record button (setOpenMeetingId + setPhase are
  // stable setters, so an empty-deps listener is safe).
  useEffect(() => {
    if (IS_MOBILE) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("tray://new-recording", () => {
      setOpenMeetingId(null);
      setPhase(getConsentEnabled() ? "consent" : "live");
    })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Which folders are shared (mine shared out ∪ others' shared to me) — for
  // the sidebar badges and the folder header's Shared chip. Best-effort.
  const [sharedProjectIds, setSharedProjectIds] = useState<Set<string>>(new Set());
  const refreshSharedStatus = useCallback(() => {
    if (!user) {
      setSharedProjectIds(new Set());
      return;
    }
    const ownedIds = projects.map((p) => p.id);
    Promise.all([
      ownedIds.length ? listSharedOutProjectIds(ownedIds) : Promise.resolve(new Set<string>()),
      listSharedProjectNames(user.id),
    ])
      .then(([mine, foreign]) =>
        setSharedProjectIds(new Set([...mine, ...Object.keys(foreign)])),
      )
      .catch(() => {});
  }, [user, projects]);

  useEffect(() => {
    refreshSharedStatus();
  }, [refreshSharedStatus]);

  const handleNewRecording = () => {
    setRecordMode("meeting");
    setPhase(getConsentEnabled() ? "consent" : "live");
  };

  // Quick voice memo (Wave B1): a mic-only recording. It captures only the
  // user's own voice, so the recording-consent gate (about capturing others)
  // doesn't apply — go straight to the recorder in its memo variant.
  const handleNewVoiceMemo = () => {
    setRecordMode("memo");
    setPhase("live");
  };

  // Blank note (Wave B1): create an empty meeting and open it notes-first, with
  // the composer focused. No recording, no transcript — just start typing.
  const handleNewBlankNote = async () => {
    try {
      const saved = await saveMeeting({
        title: `Note · ${new Date().toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}`,
        project_id: selectedProjectId,
        segments: [],
        notes: "",
        summary: "",
        images: [],
        attendees: null,
      });
      refresh();
      setNotesFirstMeetingId(saved.id);
      setOpenMeetingId(saved.id);
      if (user) pushMeeting(user.id, saved).catch(() => {});
    } catch (e) {
      console.error("blank note failed", e);
    }
  };

  // Rendered in both the main layout and the meeting-detail overlay so ⌘K
  // works everywhere except during a live recording.
  const palette =
    !IS_MOBILE && paletteOpen && phase === null ? (
      <CommandPalette
        projects={projects}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onSelectProject={(id) => {
          setOpenMeetingId(null);
          setSelectedProjectId(id);
          setSharedActive(false);
          setSortActive(false);
          setView("meetings");
        }}
        onOpenMeeting={setOpenMeetingId}
        onNewRecording={() => {
          setOpenMeetingId(null);
          handleNewRecording();
        }}
        onNewProject={() => {
          setOpenMeetingId(null);
          setProjectDialog({ mode: "create", parentId: null });
        }}
      />
    ) : null;

  // window.prompt() silently returns null in Tauri's webview, so project
  // create/rename/delete all go through real dialogs.
  const [projectDialog, setProjectDialog] = useState<ProjectDialog>(null);

  const handleCreateProject = async (name: string, parentId: string | null) => {
    const p = await createProject(name, parentId);
    refresh();
    setSelectedProjectId(p.id);
    setView("meetings");
    if (user) pushProject(user.id, p).catch(() => {});
  };

  const handleMoveMeeting = async (meetingId: string, projectId: string | null) => {
    try {
      const updated = await moveMeetingToProject(meetingId, projectId);
      refresh();
      if (user) pushMeeting(user.id, updated).catch(() => {});
    } catch (e) {
      console.error("move failed", e);
    }
  };

  const handleReparentProject = async (id: string, parentId: string | null) => {
    try {
      await setProjectParent(id, parentId);
      refresh();
      const p = projects.find((x) => x.id === id);
      if (user && p) pushProject(user.id, { ...p, parent_id: parentId }).catch(() => {});
    } catch (e) {
      console.error("re-parent failed", e);
    }
  };

  const handleRenameProject = async (project: Project, name: string) => {
    const p = await renameProject(project.id, name);
    refresh();
    if (user) pushProject(user.id, p).catch(() => {});
  };

  const handleDeleteProject = async (project: Project) => {
    await deleteProject(project.id);
    if (selectedProjectId === project.id) setSelectedProjectId(null);
    refresh();
    if (user) deleteCloudProject(project.id).catch(() => {});
  };

  // Star/unstar a folder (A6). LOCAL-ONLY — optimistic update, no cloud push;
  // revert on failure.
  const handleToggleProjectFavorite = async (project: Project) => {
    const next = !project.is_favorite;
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, is_favorite: next } : p)),
    );
    try {
      await setProjectFavorite(project.id, next);
    } catch {
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, is_favorite: !next } : p)),
      );
    }
  };

  const selectProject = (id: string | null) => {
    setSelectedProjectId(id);
    setSharedActive(false);
    setSortActive(false);
    setView("meetings");
    setOpenMeetingId(null);
  };

  const selectSort = () => {
    setSortActive(true);
    setSharedActive(false);
    setView("meetings");
    setOpenMeetingId(null);
  };

  // Auto-sort: classify new meetings once summarised (hook into summaryGen),
  // and keep the sidebar "To sort (N)" badge current.
  useEffect(() => {
    installAutoSortHooks();
    // Allowing cloud AI resumes automation AI actions skipped while unanswered.
    installAutomationConsentResume();
    const load = () =>
      sortStats()
        .then((s) => setSortCount(s.review))
        .catch(() => {});
    load();
    return onSortChanged(load);
  }, []);
  useEffect(() => {
    sortStats()
      .then((s) => setSortCount(s.review))
      .catch(() => {});
  }, [refreshKey]);

  const selectShared = () => {
    setSharedActive(true);
    setSortActive(false);
    setView("meetings");
    setOpenMeetingId(null);
  };

  const projectName =
    selectedProjectId === null
      ? "All meetings"
      : projects.find((p) => p.id === selectedProjectId)?.name ?? "Meetings";

  // First-run onboarding takes over the window until dismissed.
  if (!onboarded) {
    return (
      <OnboardingView
        onDone={() => {
          setOnboarded(true);
          setOnboardedState(true);
          // New users get the feature tour right after onboarding.
          if (!IS_MOBILE) setShowGuide(true);
        }}
      />
    );
  }

  const detectBanner =
    detectedSource && phase === null ? (
      <div className="fixed bottom-5 right-5 z-50 w-80 rounded-[var(--radius)] border border-border bg-card p-4 shadow-lg">
        <button
          onClick={() => setDetectedSource(null)}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-accent/10 p-2 text-accent">
            <Video className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Meeting detected</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Looks like you're in a call ({detectedSource}). Record it with Lalela?
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setDetectedSource(null);
                  handleNewRecording();
                }}
              >
                Start recording
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDetectedSource(null)}>
                Not now
              </Button>
            </div>
          </div>
        </div>
      </div>
    ) : null;

  // The "first meeting captured" Milestone toast (Amp). Included in both the
  // meeting-detail branch (where the user lands right after capture) and the
  // main shell. capability-unlocked is non-accent, so at dial 2 it resolves to
  // a quiet spring-tick — no yellow burst.
  const firstMeetingMilestone = showFirstMeetingMilestone ? (
    <div className="fixed bottom-5 left-5 z-[70] rounded-[var(--radius)] border border-border bg-card px-4 py-3 shadow-lg">
      <Milestone
        kind="capability-unlocked"
        id="first-meeting"
        title="First meeting captured"
        message="Your notes write themselves from here — kept on your device, private by design."
      />
    </div>
  ) : null;

  // Live recording takes over the whole window.
  if (phase === "live") {
    return (
      <div
        className={cn(
          "flex h-screen w-screen overflow-hidden bg-background text-foreground",
          SAFE_AREA_INSETS,
        )}
      >
        <RecordingView
          mode={recordMode}
          onFinish={async (m) => {
            setPhase(null);
            try {
              const saved = await saveMeeting({
                title: m.title,
                project_id: selectedProjectId,
                segments: m.segments,
                notes: m.notes,
                summary: "",
                images: m.images,
                attendees: m.attendees ?? null,
              });
              refresh();
              setFreshMeetingId(saved.id);
              setOpenMeetingId(saved.id);
              celebrateFirstMeeting();
              if (user) pushMeeting(user.id, saved).catch(() => {});
              // Fire the automation engine for this native recording. Fully
              // fire-and-forget: an automation failure must never affect saving.
              evaluateAutomationsForMeeting(saved, "desktop").catch(() => {});
              // Wave A4: replay live "What did I miss?" catch-up exchanges into
              // the saved meeting's chat thread ("Live catch-up"). Fully
              // fire-and-forget + best-effort — a failure never blocks the save
              // (which already succeeded above).
              if (m.catchup?.length) {
                void (async () => {
                  try {
                    const thread = await createChatThread("meeting", saved.id, "Live catch-up");
                    for (const ex of m.catchup!) {
                      await appendChatMessage(thread.id, "user", ex.question);
                      await appendChatMessage(thread.id, "assistant", ex.answer);
                    }
                  } catch {
                    /* best-effort — catch-up replay must never block a save */
                  }
                })();
              }
            } catch (e) {
              console.error("save failed", e);
            }
          }}
        />
      </div>
    );
  }

  // Open meeting detail.
  if (openMeetingId) {
    return (
      <div
        className={cn(
          "flex h-screen w-screen overflow-hidden bg-background text-foreground",
          SAFE_AREA_INSETS,
        )}
      >
        <MeetingDetailView
          meetingId={openMeetingId}
          autoGenerate={openMeetingId === freshMeetingId}
          focusNotes={openMeetingId === notesFirstMeetingId}
          onBack={() => {
            setOpenMeetingId(null);
            setFreshMeetingId(null);
            setNotesFirstMeetingId(null);
            refresh();
          }}
          onOpenSettings={() => {
            setOpenMeetingId(null);
            setView("settings");
          }}
          onChanged={refresh}
        />
        {detectBanner}
        {firstMeetingMilestone}
        {palette}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-screen w-screen overflow-hidden bg-background text-foreground",
        SAFE_AREA_INSETS,
        IS_MOBILE && "flex-col",
      )}
    >
      {detectBanner}
      {!IS_MOBILE && !IS_COMMUNITY && <UpdateBanner />}
      {!IS_MOBILE && (
        <Sidebar
          active={view}
          onNavigate={(v) => navigate({ view: v })}
          onNewRecording={handleNewRecording}
          onNewVoiceMemo={handleNewVoiceMemo}
          onNewBlankNote={handleNewBlankNote}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={selectProject}
          onSelectShared={selectShared}
          onOpenHelp={() => setHelpOpen(true)}
          onNewProject={(parentId) => setProjectDialog({ mode: "create", parentId })}
          onRenameProject={(project) => setProjectDialog({ mode: "rename", project })}
          onDeleteProject={(project) => setProjectDialog({ mode: "delete", project })}
          onToggleProjectFavorite={handleToggleProjectFavorite}
          onMoveMeeting={handleMoveMeeting}
          onReparentProject={handleReparentProject}
          sharedProjectIds={sharedProjectIds}
          sharedActive={sharedActive}
          sortCount={sortCount}
          sortActive={sortActive}
          onSelectSort={selectSort}
          onSignIn={openSettingsAccount}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Global utility bar: Search field + ⌘K + the Notifications bell.
            On mobile the bell lives in a slim header; search is in the More
            sheet (no ⌘K on touch). */}
        {!IS_MOBILE && (
          <TopBar
            onOpenSearch={() => setPaletteOpen(true)}
            overdueCount={overdueCount}
            onOpenMeeting={setOpenMeetingId}
            onOpenAccount={openSettingsAccount}
          />
        )}
        {IS_MOBILE && (
          <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-2">
            <Logo />
            <NotificationBell
              overdueCount={overdueCount}
              onOpenMeeting={setOpenMeetingId}
              align="right"
            />
          </header>
        )}

        <main className="min-h-0 flex-1 overflow-hidden">
          {view === "meetings" && !sharedActive && !sortActive && (
            <MeetingsView
              onNewRecording={handleNewRecording}
              onNewVoiceMemo={handleNewVoiceMemo}
              onNewBlankNote={handleNewBlankNote}
              onOpenMeeting={setOpenMeetingId}
              onOpenFreshMeeting={(id) => {
                // Audio imports behave like a finished recording: auto-title +
                // auto-summary on open (Slice 7).
                setFreshMeetingId(id);
                setOpenMeetingId(id);
                celebrateFirstMeeting();
              }}
              projectId={selectedProjectId}
              projectName={projectName}
              refreshKey={refreshKey}
              project={projects.find((p) => p.id === selectedProjectId) ?? null}
              projects={projects}
              onMoveMeeting={handleMoveMeeting}
              onMeetingsChanged={refresh}
              isShared={selectedProjectId !== null && sharedProjectIds.has(selectedProjectId)}
              onSharedChanged={refreshSharedStatus}
            />
          )}
          {view === "meetings" && sharedActive && (
            <SharedView onOpenMeeting={setOpenMeetingId} />
          )}
          {view === "meetings" && sortActive && !sharedActive && (
            <AutoSortView onOpenMeeting={setOpenMeetingId} />
          )}
          {view === "search" && <SearchView onOpenMeeting={setOpenMeetingId} />}
          {view === "tasks" && <TasksView onOpenMeeting={setOpenMeetingId} />}
          {view === "knowledge" && (
            <KnowledgeView
              tab={knowledgeTab}
              onTabChange={setKnowledgeTab}
              onOpenMeeting={setOpenMeetingId}
            />
          )}
          {view === "automations" && (
            <AutomationsView tab={automationsTab} onTabChange={setAutomationsTab} />
          )}
          {view === "settings" && <SettingsView initialTab={settingsInitialTab} />}
          {view === "chat" && <ChatView onOpenSettings={() => setView("settings")} />}
        </main>
      </div>

      {IS_MOBILE && view === "meetings" && !sharedActive && (
        <button
          onClick={handleNewRecording}
          title="New recording"
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-[calc(1.25rem+env(safe-area-inset-right))] z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg active:scale-95"
        >
          <Mic className="h-6 w-6" />
        </button>
      )}
      {IS_MOBILE && (
        <BottomTabBar active={view} sharedActive={sharedActive} onNavigate={navigate} />
      )}

      {phase === "consent" && (
        // Consent is a registered sober zone — pinned to dial 0 so no
        // personality/motion ever rides on a recording-consent decision.
        <SoberZone>
          <ConsentDialog
            onConfirm={() => setPhase("live")}
            onCancel={() => setPhase(null)}
          />
        </SoberZone>
      )}

      {projectDialog?.mode === "create" && (
        <NewProjectDialog
          title={projectDialog.parentId ? "New subfolder" : "New project"}
          confirmLabel="Create"
          onSubmit={(name) => handleCreateProject(name, projectDialog.parentId)}
          onClose={() => setProjectDialog(null)}
        />
      )}
      {projectDialog?.mode === "rename" && (
        <NewProjectDialog
          title="Rename project"
          confirmLabel="Rename"
          initialValue={projectDialog.project.name}
          onSubmit={(name) => handleRenameProject(projectDialog.project, name)}
          onClose={() => setProjectDialog(null)}
        />
      )}
      {projectDialog?.mode === "delete" && (
        // Destructive surface — sober zone: clarity over character on a delete.
        <SoberZone>
          <ConfirmDialog
            title={`Delete “${projectDialog.project.name}”?`}
            body="Meetings in this project are kept and moved to Unfiled. The markdown folder on disk is not touched."
            confirmLabel="Delete project"
            onConfirm={() => handleDeleteProject(projectDialog.project)}
            onClose={() => setProjectDialog(null)}
          />
        </SoberZone>
      )}
      {palette}
      {showGuide && !IS_MOBILE && (
        <GuideDialog
          onClose={() => setShowGuide(false)}
          onStartTour={(id) => {
            setShowGuide(false);
            setActiveTour(getTourById(id));
          }}
        />
      )}
      {helpOpen && !IS_MOBILE && (
        <HelpMenu
          onClose={() => setHelpOpen(false)}
          onOpenGuide={() => {
            setHelpOpen(false);
            setShowGuide(true);
          }}
          onStartTour={(id) => {
            setHelpOpen(false);
            setActiveTour(getTourById(id));
          }}
          onWatchVideo={(id) => {
            setHelpOpen(false);
            setActiveVideo(getVideoById(id) ?? null);
          }}
        />
      )}
      {activeVideo && !IS_MOBILE && (
        <VideoModal video={activeVideo} onClose={() => setActiveVideo(null)} />
      )}
      {activeTour && !IS_MOBILE && (
        <AmpTour tour={activeTour} open onClose={() => setActiveTour(null)} />
      )}
      {firstMeetingMilestone}
      {/* Iris feedback widget — double-gated (build env + user opt-in), a no-op
          by default. Renders null and loads no remote script unless enabled. */}
      {!IS_COMMUNITY && <IrisWidget />}
    </div>
  );
}
