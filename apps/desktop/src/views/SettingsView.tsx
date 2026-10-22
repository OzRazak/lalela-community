import { AutoSortSettings } from "@/views/AutoSortView";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { Button } from "@/components/ui/Button";
import {
  getSaveFolder,
  pickSaveFolder,
  setDetectionEnabled,
  getCloseToTray,
  setCloseToTray,
  localLlmStatus,
  appleLlmStatus,
  startModelDownload,
  modelDownloadStatus,
  deleteLocalLlm,
  unloadLocalLlm,
  listLocalModels,
  deleteLocalModel,
  isRecording,
  onLlmProgress,
  onLlmComplete,
  type DownloadState,
  type LocalModelFile,
  type AppleLlmStatus,
  summarize,
  listAsrEngines,
  getWorkspaceCard,
  setWorkspaceCard,
  getDictionary,
  setDictionary,
  previewDictionary,
  listSpeakers,
  renameSpeaker,
  deleteSpeaker,
  mergeSpeakers,
  type Speaker,
  type AsrEngineInfo,
  type LlmStatus,
} from "@/lib/lalela";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ReportAiButton } from "@/components/ReportAiContent";
import { Flag } from "lucide-react";
import {
  getApiKey,
  setApiKey,
  getModel,
  setModel,
  getConsentEnabled,
  setConsentEnabled,
  getConsentText,
  setConsentText,
  getAutoDetectEnabled,
  setAutoDetectEnabled,
  getSystemAudioEnabled,
  setSystemAudioEnabled,
  getTranscriptionMode,
  setTranscriptionMode,
  getAsrEngine,
  setAsrEngine,
  getVoiceprintsEnabled,
  setVoiceprintsEnabled,
  getIrisFeedbackEnabled,
  setIrisFeedbackEnabled,
  getFolderRecursiveDefault,
  setFolderRecursiveDefault,
  irisBuildConfig,
  getAutogenEnabled,
  setAutogenEnabled,
  getAutogenModel,
  setAutogenModel,
  getActionsModel,
  setActionsModel,
  getResponseLength,
  setResponseLength,
  type ResponseLength,
  getAiSource,
  setAiSource,
  LOCAL_MODEL_CATALOG,
  localModelId,
  MODELS,
  DEFAULT_MODEL,
  APPLE_MODEL_ID,
  isLocalModelId,
  isAppleModelId,
  modelPickerLabel,
  visionModels,
  getCopilotVisionModel,
  setCopilotVisionModel,
  getCopilotScreenAwareness,
  setCopilotScreenAwareness,
  getCopilotScreenDisclosed,
  setCopilotScreenDisclosed,
  COPILOT_SCREEN_DISCLOSURE,
  type AiSource,
  type LocalModelSpec,
  type TranscriptionMode,
} from "@/lib/settings";
import { DataSharingSettings } from "@/components/DataSharingSettings";
import { CloudAiConsentSetting } from "@/components/CloudAiConsent";
import {
  connect as msConnect,
  connectedAccount,
  disconnect as msDisconnect,
  getComingUpDays,
  getMsBackfillDays,
  getMsImportEnabled,
  getMsImportOutcome,
  msImportFailureHint,
  setComingUpDays,
  setMsBackfillDays,
  setMsImportEnabled,
  setMsImportLastRun,
  setMsImportOutcome,
  type MsAccount,
  type MsImportOutcome,
} from "@/lib/msauth";
import { importTeamsTranscripts } from "@/lib/teamsImport";
import { useAvailableModels } from "@/lib/useModels";
import { cn } from "@/lib/utils";
import { AccountPanel } from "@/components/AccountPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { useAuth } from "@/lib/auth";
import { syncUp } from "@/lib/sync";
import { foreignSkipLine } from "@/lib/syncRlsCore";
import {
  getSyncOutcome,
  recordSyncFailure,
  recordSyncSuccess,
  syncFailureHint,
  SYNC_OUTCOME_CHANGED_EVENT,
  type SyncOutcome,
} from "@/lib/syncStatus";
import { aiGenerateStream, aiRoute, getAiUsage, LALELA_API, type AiUsage } from "@/lib/ai";
import { listProjects, flattenProjectTree, type Project } from "@/lib/lalela";
import {
  sameDomainProfiles,
  isConsumerDomain,
  emailDomain,
  teammatesDismissed,
  dismissTeammates,
  type Teammate,
} from "@/lib/teammates";
import { DEVICE_NOUN, IS_ANDROID, IS_IPAD, IS_MOBILE, IS_WINDOWS, chord } from "@/lib/platform";
import {
  dictationStatus,
  setDictationEnabled,
  setDictationShortcut,
  triggerDictation,
  prettyShortcut,
  accelFromEvent,
  type DictationStatus,
} from "@/lib/dictation";
import {
  copilotStatus,
  setCopilotEnabled,
  copilotShow,
  type CopilotStatus,
} from "@/lib/copilot";
import {
  DOSSIER_LEAD_OPTIONS,
  getDossierLeadHours,
  getDossiersEnabled,
  setDossierLeadHours,
  setDossiersEnabled,
} from "@/lib/dossiers";
import {
  DETECTION_KINDS,
  setNotificationPrefs,
  useNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notifications";
import {
  checkForUpdateDetailed,
  recordUpdateCheck,
  lastUpdateCheck,
  installAndRelaunch,
  updateErrorMessage,
  type Update,
} from "@/lib/updater";
import { IS_STORE_BUILD, STORE_UPDATE_NOTE } from "@/lib/distribution";
import { IS_COMMUNITY, MS_INTEGRATION_AVAILABLE } from "@/lib/edition";
import {
  AlertTriangle,
  Bell,
  BookA,
  Building2,
  CalendarClock,
  ShieldCheck,
  CheckCircle2,
  CreditCard,
  Download,
  DownloadCloud,
  Cloud,
  ExternalLink,
  FolderCog,
  Gauge,
  Gift,
  HardDriveDownload,
  Info,
  Keyboard,
  Loader2,
  Mic2,
  PanelTop,
  Plug,
  Sparkles,
  Trash2,
  KeyRound,
  UserCircle,
  Users,
} from "lucide-react";
import { RewardsPanel } from "@/components/RewardsPanel";

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-foreground">
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
          {children && <div className="mt-4">{children}</div>}
        </div>
      </div>
    </section>
  );
}

/** "Report a problem with AI content" — for reports not tied to one output
 * (Store policy 11.16). Shown under AI models (every platform) and About. */
function ReportAiSection() {
  return (
    <Section
      icon={<Flag className="h-5 w-5" />}
      title="Report a problem with AI content"
      description="Saw an AI summary, answer or note that was harmful, offensive or wrong? Tell us — every AI result in Lalela also has its own Report button."
    >
      <ReportAiButton surface="general" label="Report a problem with AI content" />
    </Section>
  );
}

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** macOS deep link to the Accessibility privacy pane. */
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/**
 * System-wide dictation (Wave B2) — macOS + Windows desktop. Renders nothing until
 * the backend confirms support. Off by default: a global hotkey that grabs the
 * mic shouldn't arm itself unannounced.
 */
function DictationSection({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [capturing, setCapturing] = useState(false);

  const refresh = useCallback(() => {
    dictationStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (IS_MOBILE) return;
    refresh();
    // Re-check on focus so a just-granted Accessibility permission reflects
    // without the user hunting for a button.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Capture the next key combination as the new shortcut.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // wait for a real combo (a modifier + a key)
      setCapturing(false);
      setDictationShortcut(accel)
        .then(() => {
          onSaved();
          refresh();
        })
        .catch(() => refresh());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onSaved, refresh]);

  if (IS_MOBILE || !status || !status.supported) return null;

  const toggleEnabled = (next: boolean) => {
    // Optimistic; the backend arms/disarms the hotkey.
    setStatus((s) => (s ? { ...s, enabled: next } : s));
    setDictationEnabled(next)
      .then(() => {
        onSaved();
        refresh();
      })
      .catch(() => refresh());
  };

  return (
    <Section
      icon={<Keyboard className="h-5 w-5" />}
      title="Dictate anywhere"
      description={`Press a hotkey in any app, speak, and Lalela types it in for you — transcribed on-device, nothing leaves your ${DEVICE_NOUN}.`}
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Enable system-wide dictation
      </label>

      {status.enabled && (
        <div className="mt-4 space-y-4">
          {/* Shortcut binding */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Hotkey</div>
              <div className="text-xs text-muted-foreground">
                Press it in any app to start; press again (or ⏎) to insert, Esc to cancel.
              </div>
            </div>
            <button
              onClick={() => setCapturing((c) => !c)}
              className="min-w-[7rem] rounded-[var(--radius)] border border-border bg-card px-3 py-1.5 text-sm font-semibold hover:bg-muted"
            >
              {capturing ? "Press keys…" : prettyShortcut(status.shortcut)}
            </button>
          </div>

          {/* Accessibility permission — a macOS concept; Windows needs no grant. */}
          {!IS_WINDOWS && (
          <div className="rounded-[var(--radius)] border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                {status.accessibility ? (
                  <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-[var(--color-warning)]" />
                )}
                <span className="font-medium">
                  Accessibility permission {status.accessibility ? "granted" : "needed"}
                </span>
              </div>
              {!status.accessibility && (
                <Button
                  variant="outline"
                  onClick={() => openUrl(ACCESSIBILITY_SETTINGS_URL).catch(() => {})}
                >
                  Open Settings
                </Button>
              )}
            </div>
            {!status.accessibility && (
              <p className="mt-2 text-xs text-muted-foreground">
                macOS requires Accessibility access for Lalela to type into other apps. Turn on
                <span className="font-medium"> Lalela </span>
                under Privacy &amp; Security → Accessibility, then come back — this updates
                automatically.
              </p>
            )}
          </div>
          )}

          {/* Try it + caveats */}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => triggerDictation().catch(() => {})}>
              Try it now
            </Button>
            <span className="text-xs text-muted-foreground">
              Opens the dictation bar so you can test your hotkey.
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Fully on-device — the audio and text never leave your {DEVICE_NOUN}. Dictation pauses
            while a meeting is recording (they share the microphone).{" "}
            {IS_WINDOWS
              ? "It can’t type into apps running as administrator (Windows blocks that) — if nothing appears, press Ctrl+V: the text is on your clipboard."
              : "It can’t type into password fields (macOS blocks that) — there the text is copied to your clipboard instead."}
          </p>
        </div>
      )}
    </Section>
  );
}

/**
 * Meeting Copilot (CP1) — macOS desktop only. A hotkey-summoned translucent
 * overlay that gives on-demand AI guidance during a live recording. Off by
 * default (like dictation); enabling it arms the global hotkey. Renders nothing
 * until the backend confirms support. v1 ships a FIXED hotkey (⌘⇧A) — the
 * accelerator is persisted so a rebind UI can be added later without a migration.
 */
function CopilotSection({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<CopilotStatus | null>(null);

  const refresh = useCallback(() => {
    copilotStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (IS_MOBILE) return;
    refresh();
    // Refresh the "showing now" state when the window regains focus.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (IS_MOBILE || !status || !status.supported) return null;

  const toggleEnabled = (next: boolean) => {
    // Optimistic; the backend arms/disarms the hotkey.
    setStatus((s) => (s ? { ...s, enabled: next } : s));
    setCopilotEnabled(next)
      .then(() => {
        onSaved();
        refresh();
      })
      .catch(() => refresh());
  };

  return (
    <Section
      icon={<PanelTop className="h-5 w-5" />}
      title="Meeting Copilot"
      description="Summon a private on-screen panel during a recording for on-demand AI help — what to say next, follow-up questions, or a quick recap — drawn from the last few minutes of the conversation."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Enable the Meeting Copilot
      </label>

      {status.enabled && (
        <div className="mt-4 space-y-4">
          {/* Hotkey (fixed in v1) */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Hotkey</div>
              <div className="text-xs text-muted-foreground">
                Press it during a recording to show or hide the Copilot.
              </div>
            </div>
            <span className="min-w-[7rem] rounded-[var(--radius)] border border-border bg-card px-3 py-1.5 text-center text-sm font-semibold">
              {prettyShortcut(status.shortcut)}
            </span>
          </div>

          {/* Try it */}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => copilotShow().catch(() => {})}>
              Try it
            </Button>
            <span className="text-xs text-muted-foreground">
              Opens the Copilot panel so you can see where it appears.
            </span>
          </div>

          {/* Honest capture-posture description */}
          <p className="text-xs text-muted-foreground">
            The Copilot answers only from your live transcript and uses your selected AI model —
            nothing extra is sent, unless you turn on screen awareness below. Its panel is kept out
            of most screen shares and recordings, but this isn’t guaranteed on newer macOS (15+),
            where some screen-capture tools can still include it.
          </p>

          {/* Screen awareness (CP4) — the one off-device copilot path. */}
          <ScreenAwarenessControl onSaved={onSaved} />
        </div>
      )}
    </Section>
  );
}

/**
 * Screen awareness master control (CP4). Mirrors the overlay toggle (shares the
 * same localStorage key) and shows the full plain-language disclosure. OFF by
 * default; it's the ONLY copilot path that sends data (a screenshot) off-device.
 * Enabling here counts as informed consent (the disclosure is shown inline), so
 * it also marks the disclosure seen — the overlay won't re-prompt.
 */
function ScreenAwarenessControl({ onSaved }: { onSaved: () => void }) {
  const [on, setOn] = useState(getCopilotScreenAwareness);
  // Screenshots go to a DEDICATED vision model (not the default text model), so
  // screen awareness works regardless of the default pick. This list is the only
  // place that model is chosen; it's persisted separately.
  const visionOpts = visionModels();
  const [visionModel, setVisionModelState] = useState(getCopilotVisionModel);

  const toggle = (next: boolean) => {
    setOn(next);
    setCopilotScreenAwareness(next);
    if (next && !getCopilotScreenDisclosed()) setCopilotScreenDisclosed(true);
    onSaved();
  };

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card/40 p-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5 accent-[var(--color-accent)]"
        />
        <span>
          <span className="font-medium">Screen awareness</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {COPILOT_SCREEN_DISCLOSURE}
          </span>
        </span>
      </label>
      {on && (
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Screen-awareness model
          </label>
          {visionOpts.length > 0 ? (
            <>
              <select
                value={visionModel}
                onChange={(e) => {
                  setVisionModelState(e.target.value);
                  setCopilotVisionModel(e.target.value);
                  onSaved();
                }}
                className={inputClass}
              >
                {visionOpts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelPickerLabel(m)} — {m.note}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Screenshots are sent only to this vision-capable model — your default AI model
                stays text-only and never receives an image.
              </p>
            </>
          ) : (
            <p className="text-xs text-[var(--color-warning,#f59e0b)]">
              No vision-capable models are available, so screen awareness has no effect.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Meeting prep (CP2) — part of the Meeting Copilot family. When enabled and a
 * Microsoft calendar is connected, Lalela prepares a briefing note before each
 * upcoming meeting (calendar + past-meeting history + workspace context). OFF
 * by default — it generates AI content on a schedule, so the user opts in.
 * Generation runs on-device (local model) when one is available, at ~zero cost.
 */
function MeetingPrepSection({ onSaved }: { onSaved: () => void }) {
  const [enabled, setEnabled] = useState(() => getDossiersEnabled());
  const [leadHours, setLeadHours] = useState(() => getDossierLeadHours());

  if (IS_MOBILE) return null;

  const toggle = (next: boolean) => {
    setEnabled(next);
    setDossiersEnabled(next);
    onSaved();
  };

  const changeLead = (hours: number) => {
    setLeadHours(hours);
    setDossierLeadHours(hours);
    onSaved();
  };

  return (
    <Section
      icon={<CalendarClock className="h-5 w-5" />}
      title="Meeting prep"
      description="Before a calendar meeting starts, prepare a private briefing note — who's coming, what you last discussed, open threads, and talking points — drawn from your calendar, past meetings and workspace context. It lands in your meetings list as a “Prep: …” note."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Prepare a briefing note before each meeting
      </label>

      {enabled && (
        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Prepare dossiers for meetings starting within
            </label>
            <select
              value={leadHours}
              onChange={(e) => changeLead(Number(e.target.value))}
              className={inputClass}
            >
              {DOSSIER_LEAD_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  the next {h} hours
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-muted-foreground">
            Runs quietly in the background — one dossier per meeting. It uses your on-device
            model when one is available (free, private, no quota), otherwise your default AI
            model. Requires a connected Microsoft calendar (Settings → Connections); nothing
            happens until then.
          </p>
        </div>
      )}
    </Section>
  );
}

export type SettingsTab =
  | "account"
  | "team"
  | "ai"
  | "recording"
  | "notifications"
  | "connections"
  | "storage"
  | "about"
  | "rewards";

/** Tab bar entries. Connections + Storage are desktop-only (mobile has no
 * keychain/loopback helpers and no save folder). About is desktop-only too —
 * it carries the manual "Check for updates" surface, and iOS/Android ship
 * updates through their app stores. Without a discoverable home the updater was
 * buried in Storage, so a Windows user (no menu bar) could not find it. Account
 * is last — the primary sign-in surface is reached from the sidebar / usage
 * chip, so it needn't lead.
 *
 * Community edition (lib/edition.ts): Team & sharing, Rewards and Account are
 * cloud-only and dropped; Connections only stays when the build carries its
 * own Microsoft client id (the other connections need the hosted web app). */
const COMMUNITY_HIDDEN_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  "team",
  "rewards",
  "account",
  ...(MS_INTEGRATION_AVAILABLE ? [] : (["connections"] as const)),
]);
const ALL_SETTINGS_TABS: Array<{ id: SettingsTab; label: string; Icon: typeof UserCircle }> = [
  { id: "team", label: "Team & sharing", Icon: Users },
  { id: "ai", label: "AI models", Icon: Sparkles },
  { id: "recording", label: "Recording", Icon: Mic2 },
  { id: "notifications", label: "Notifications", Icon: Bell },
  ...(IS_MOBILE
    ? []
    : [
        { id: "connections" as const, label: "Connections", Icon: Plug },
        { id: "storage" as const, label: "Storage", Icon: FolderCog },
        { id: "about" as const, label: "About & updates", Icon: Info },
      ]),
  { id: "rewards", label: "Rewards", Icon: Gift },
  { id: "account", label: "Account", Icon: UserCircle },
];
const SETTINGS_TABS = IS_COMMUNITY
  ? ALL_SETTINGS_TABS.filter((t) => !COMMUNITY_HIDDEN_TABS.has(t.id))
  : ALL_SETTINGS_TABS;

/** A deep link to a tab this build doesn't have lands on the first one. */
function resolveTab(tab: SettingsTab | undefined): SettingsTab {
  const wanted = tab ?? "team";
  return SETTINGS_TABS.some((t) => t.id === wanted) ? wanted : SETTINGS_TABS[0].id;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Free-tier usage bar + (dummy) plan management. BYOK and local models
 * bypass the free tier entirely and are never metered. */
function PlanUsageSection() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getAiUsage(user.id)
      .then(setUsage)
      .catch(() => {});
  }, [user]);

  const pct = usage ? Math.min(100, Math.round((usage.used / usage.quota) * 100)) : 0;

  return (
    <Section
      icon={<CreditCard className="h-5 w-5" />}
      title="Plan & usage"
      description="Signed-in users get a free monthly AI allowance on us — no key needed. Your own key and local models never count against it."
    >
      {!user ? (
        <p className="text-sm text-muted-foreground">
          Sign in (Account tab) to activate your free monthly AI allowance.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              Current plan
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold capitalize">
                {usage?.plan ?? "free"}
              </span>
            </span>
            {usage && (
              <span className="text-xs text-muted-foreground">
                {Math.round(usage.used / 1000)}k / {Math.round(usage.quota / 1000)}k tokens this
                month
              </span>
            )}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded bg-muted">
            <div
              className={pct >= 90 ? "h-full bg-danger" : "h-full bg-accent"}
              style={{ width: `${pct}%` }}
            />
          </div>
          {usage && usage.byokUsed > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Your own key: {Math.round(usage.byokUsed / 1000)}k tokens this month — billed by
              your provider, never counted against the allowance.
            </p>
          )}
          {/* Payment placeholders are desktop-only (macOS/Windows/Linux). They must
              NOT render on iOS/Android: the App Store rejected 1.1.11 under Guideline
              2.1(b) over these "coming soon" buttons, and referencing an external payment
              method (Paystack) for digital goods is a 3.1.1 / Play-policy risk. Nothing
              is actually sold in-app; the free allowance + BYOK/local copy above stands
              on every platform. The Microsoft Store build hides them too: Store
              policy expects every visible control to work, and its listing says free. */}
          {!IS_MOBILE && !IS_STORE_BUILD && (
            <>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setComingSoon("Pro plan (2M tokens/month)")}
                >
                  Upgrade to Pro
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setComingSoon("Token top-ups")}>
                  Buy more tokens
                </Button>
              </div>
              {comingSoon && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {comingSoon} — payments are coming soon (Paystack). Until then the free
                  allowance resets monthly, and your own key or a local model is always
                  unlimited.
                </p>
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}

/** Per-folder team management: pick a folder, manage its members. */
function TeamSection() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [managing, setManaging] = useState<Project | null>(null);
  const [prefillEmail, setPrefillEmail] = useState<string | undefined>(undefined);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  const flat = flattenProjectTree(projects);

  // Open the share dialog pre-filled with a suggested teammate's email. Targets
  // the folder chosen above, else the first folder available.
  const shareWith = (email: string) => {
    const target = projects.find((p) => p.id === selected) ?? flat[0]?.project ?? null;
    if (!target) return;
    setPrefillEmail(email);
    setManaging(target);
  };

  return (
    <Section
      icon={<Users className="h-5 w-5" />}
      title="Team & sharing"
      description="Lalela shares by folder: invite teammates to a folder (subfolders included) with viewer, editor or admin roles. Folders you don't share stay private."
    >
      {!user ? (
        <p className="text-sm text-muted-foreground">
          Sign in (Account tab) to share with your team.
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Create a folder first — then you can share it here or from any meeting.
        </p>
      ) : (
        <div className="flex gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className={inputClass}
          >
            <option value="">Choose a folder…</option>
            {flat.map(({ project, depth }) => (
              <option key={project.id} value={project.id}>
                {" ".repeat(depth * 3)}
                {project.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!selected}
            onClick={() => {
              setPrefillEmail(undefined);
              setManaging(projects.find((p) => p.id === selected) ?? null);
            }}
          >
            Manage members
          </Button>
        </div>
      )}
      {user && <PeopleAtCompany canShare={projects.length > 0} onShare={shareWith} />}
      {managing && (
        <ShareDialog
          projectId={managing.id}
          projectName={managing.name}
          projectCreatedMs={managing.created_at}
          prefillEmail={prefillEmail}
          onClose={() => {
            setManaging(null);
            setPrefillEmail(undefined);
          }}
        />
      )}
    </Section>
  );
}

/** "People at your company" — same-domain teammates already using Lalela (Wave
 * D2). Reads ONLY the privacy-safe same_domain_profiles() RPC. Renders nothing
 * when signed out, on a consumer domain, with zero matches, or once dismissed. */
function PeopleAtCompany({
  canShare,
  onShare,
}: {
  canShare: boolean;
  onShare: (email: string) => void;
}) {
  const { user } = useAuth();
  const [mates, setMates] = useState<Teammate[] | null>(null);
  const [dismissed, setDismissed] = useState(teammatesDismissed());

  const consumer = isConsumerDomain(user?.email);
  useEffect(() => {
    if (!user || dismissed || consumer) {
      setMates([]);
      return;
    }
    sameDomainProfiles()
      .then(setMates)
      .catch(() => setMates([]));
  }, [user, dismissed, consumer]);

  if (!user || dismissed || consumer) return null;
  if (!mates || mates.length === 0) return null;

  const domain = emailDomain(user.email);
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          People at your company
        </h4>
        <button
          onClick={() => {
            dismissTeammates();
            setDismissed(true);
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Don't show this
        </button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {mates.length} {mates.length === 1 ? "person" : "people"}
        {domain ? ` on ${domain}` : ""} already use Lalela. Share a folder to collaborate.
      </p>
      <div className="mt-3 space-y-1.5">
        {mates.map((m) => (
          <div key={m.email} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{m.display_name || m.email}</span>
              {m.display_name && (
                <span className="ml-2 text-muted-foreground">{m.email}</span>
              )}
            </span>
            <Button
              variant="outline"
              className="h-8 shrink-0 px-2.5 text-xs"
              disabled={!canShare}
              title={canShare ? "Share a folder with this teammate" : "Create a folder first"}
              onClick={() => onShare(m.email)}
            >
              Share a folder…
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Percent-complete for a download-registry entry (0 when size unknown). */
function dlPct(dl: DownloadState | undefined): number {
  if (!dl || dl.total <= 0) return 0;
  return Math.min(100, Math.round((dl.downloaded / dl.total) * 100));
}

/** Download / test / delete UI for the whole local-model catalog (desktop
 * only). Downloads run in the backend and survive leaving this view: progress
 * bars are restored on mount from `modelDownloadStatus()` and kept live via the
 * `llm://progress` / `llm://complete` events. */
function LocalModelsSection() {
  const [status, setStatus] = useState<Map<string, LlmStatus>>(new Map());
  // Backend-owned download state, keyed by file — the source of truth for
  // progress bars (restored on mount so navigating away doesn't lose them).
  const [downloads, setDownloads] = useState<Map<string, DownloadState>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState<LocalModelSpec | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ file: string; text: string; ok: boolean } | null>(
    null,
  );

  const refreshStatus = useCallback(() => {
    localLlmStatus(LOCAL_MODEL_CATALOG.map((s) => s.file))
      .then((list) => setStatus(new Map(list.map((s) => [s.file, s]))))
      .catch(() => {});
  }, []);

  // End-to-end sanity check through the exact same path summaries use —
  // spawns the sidecar, loads the model (first run takes a minute), generates.
  const testModel = async (spec: LocalModelSpec) => {
    setTesting(spec.file);
    setTestResult(null);
    try {
      const out = await summarize(
        "Reply with exactly: Local model OK",
        "You are a test assistant. Follow the instruction precisely.",
        localModelId(spec),
        "",
      );
      setTestResult({ file: spec.file, text: out.content.trim().slice(0, 200), ok: true });
    } catch (e) {
      setTestResult({ file: spec.file, text: String(e), ok: false });
    } finally {
      setTesting(null);
      refreshStatus();
    }
  };

  useEffect(() => {
    refreshStatus();
    // Restore any in-flight/failed downloads started before this mount.
    modelDownloadStatus()
      .then((list) => setDownloads(new Map(list.map((d) => [d.file, d]))))
      .catch(() => {});
    // Ask for notification permission up front so the "model ready" toast can
    // fire the moment a background download finishes (best-effort).
    isPermissionGranted()
      .then((granted) => (granted ? null : requestPermission()))
      .catch(() => {});

    const unlisteners: Array<() => void> = [];
    onLlmProgress((p) => {
      setDownloads((prev) => {
        const next = new Map(prev);
        const cur = next.get(p.file);
        next.set(p.file, {
          file: p.file,
          downloaded: p.downloaded,
          total: p.total,
          status: "downloading",
          error: cur?.error ?? null,
        });
        return next;
      });
    })
      .then((u) => unlisteners.push(u))
      .catch(() => {});
    onLlmComplete((p) => {
      setDownloads((prev) => {
        const next = new Map(prev);
        const cur = next.get(p.file);
        next.set(p.file, {
          file: p.file,
          downloaded: cur?.downloaded ?? 0,
          total: cur?.total ?? 0,
          status: p.ok ? "done" : "error",
          error: p.ok ? null : (p.error ?? "download failed"),
        });
        return next;
      });
      refreshStatus();
    })
      .then((u) => unlisteners.push(u))
      .catch(() => {});
    return () => unlisteners.forEach((u) => u());
  }, [refreshStatus]);

  const download = (spec: LocalModelSpec) => {
    // Optimistically flip to "downloading" so the bar shows before the first
    // progress event; the backend keeps running regardless of this view.
    setDownloads((prev) =>
      new Map(prev).set(spec.file, {
        file: spec.file,
        downloaded: 0,
        total: 0,
        status: "downloading",
        error: null,
      }),
    );
    startModelDownload(spec.url, spec.file, spec.sha256, spec.label).catch((e) => {
      setDownloads((prev) =>
        new Map(prev).set(spec.file, {
          file: spec.file,
          downloaded: 0,
          total: 0,
          status: "error",
          error: String(e),
        }),
      );
    });
  };

  const totalOnDisk = LOCAL_MODEL_CATALOG.reduce(
    (sum, s) => sum + (status.get(s.file)?.present ? (status.get(s.file)?.size_bytes ?? 0) : 0),
    0,
  );

  return (
    <Section
      icon={<HardDriveDownload className="h-5 w-5" />}
      title="Local AI models"
      description="Optional: run summaries, chat and workflows entirely on this device — free, no API key, nothing leaves your machine. Downloads continue in the background and you'll get a notification when a model is ready."
    >
      <div className="space-y-3">
        {LOCAL_MODEL_CATALOG.map((spec) => {
          const st = status.get(spec.file);
          const dl = downloads.get(spec.file);
          const downloading = !st?.present && dl?.status === "downloading";
          const failed = !st?.present && dl?.status === "error";
          const pct = dlPct(dl);
          return (
            <div key={spec.file} className="rounded-[var(--radius)] border border-border p-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold">{spec.label}</p>
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium">
                      {spec.license}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{spec.strengths}</p>
                  <p className="text-xs text-muted-foreground">
                    {st?.present
                      ? `downloaded · ${formatGb(st.size_bytes)} on disk${st.running ? " · loaded in memory" : ""}`
                      : `${spec.sizeLabel} download · needs ~${spec.ramLabel} RAM`}
                  </p>
                </div>
                {st?.present ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testModel(spec)}
                      disabled={testing === spec.file}
                      title="Run a quick on-device generation to confirm everything works"
                    >
                      {testing === spec.file ? "Testing… (first run ~1 min)" : "Test"}
                    </Button>
                    {st.running && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => unloadLocalLlm().then(refreshStatus)}
                        title="Free the ~4 GB of memory the loaded model uses"
                      >
                        Unload
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setConfirmDelete(spec)}>
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => download(spec)} disabled={downloading}>
                    {downloading ? `Downloading… ${pct}%` : failed ? "Retry" : "Download"}
                  </Button>
                )}
              </div>
              {downloading && (
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
              {failed && dl?.error && (
                <p className="mt-2 break-words text-xs text-danger">{dl.error}</p>
              )}
              {testResult?.file === spec.file && (
                <p
                  className={
                    testResult.ok
                      ? "mt-2 text-xs text-success"
                      : "mt-2 break-words text-xs text-danger"
                  }
                >
                  {testResult.ok ? `✓ Working — replied: “${testResult.text}”` : testResult.text}
                </p>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Once downloaded, pick a “Local” model in any picker. First use loads the model (~10–20 s).
          </span>
          {totalOnDisk > 0 && (
            <span className="shrink-0 pl-3">{formatGb(totalOnDisk)} used by local models</span>
          )}
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.label}?`}
          body="The model file is removed from disk and the Local option disappears from model pickers. You can download it again any time."
          confirmLabel="Delete model"
          onConfirm={async () => {
            await deleteLocalLlm(confirmDelete.file);
            setDownloads((prev) => {
              const next = new Map(prev);
              next.delete(confirmDelete.file);
              return next;
            });
            refreshStatus();
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </Section>
  );
}

/** Apple Intelligence (macOS 26+ / iOS 26+) on-device synthesis card. Three
 * states, driven by `apple_llm_status`:
 *   available            → show the card with a short private/free description
 *   present-but-unusable → show the reason, greyed (AI off, model downloading…)
 *   absent (old OS/HW)   → render nothing, so Settings looks exactly as today. */
function AppleIntelligenceSection() {
  const [status, setStatus] = useState<AppleLlmStatus | null>(null);
  useEffect(() => {
    appleLlmStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false }));
  }, []);

  // Still loading, or the helper/bridge isn't present at all → nothing to show.
  if (!status) return null;
  if (!status.available && !status.reason) return null;

  if (status.available) {
    // Same on-device story on all platforms; just name the device correctly.
    // (IS_IPAD first: iPad is also IS_MOBILE since 1.3.10.)
    const device = IS_ANDROID ? "Android phone" : IS_IPAD ? "iPad" : IS_MOBILE ? "iPhone" : "Mac";
    return (
      <Section
        icon={<Sparkles className="h-5 w-5" />}
        title="Apple Intelligence"
        description={`On-device, private and free — Apple's built-in model runs summaries, chat and workflows entirely on this ${device}. No API key, no quota, nothing leaves your device. Pick “Apple Intelligence (on-device)” in any model picker.`}
      />
    );
  }

  // Present but currently unusable — surface the reason, greyed out.
  return (
    <div className="opacity-60">
      <Section
        icon={<Sparkles className="h-5 w-5" />}
        title="Apple Intelligence"
        description={status.reason ?? "Apple Intelligence isn't available right now."}
      />
    </div>
  );
}

// --- AI speed test (CP0 benchmark harness) ---
// Measures time-to-first-token, tokens/sec and total wall time for each
// AVAILABLE AI lane (current online model via free/BYOK, Apple on-device if
// supported, each downloaded local GGUF) with one fixed short prompt. Results
// stay on this device (localStorage) — no telemetry anywhere.

const SPEEDTEST_KEY = "lalela.ai.speedtest";
const SPEEDTEST_SYS = "You are a helpful assistant. Reply in one short sentence.";
const SPEEDTEST_USER = "Name three colors of the rainbow.";
const SPEEDTEST_MAX_TOKENS = 48;

type SpeedKind = "online" | "apple" | "local";

interface SpeedRow {
  label: string;
  kind: SpeedKind;
  ok: boolean;
  /** Whether this lane is currently being measured (seeds a spinner row). */
  running?: boolean;
  ttftMs?: number;
  tps?: number;
  totalMs?: number;
  error?: string;
}

interface SpeedLane {
  id: string;
  label: string;
  kind: SpeedKind;
}

function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Plain-language verdict on whether a lane's first-token latency is quick
 * enough for the live copilot loop. */
function liveVerdict(row: SpeedRow): { text: string; cls: string } {
  if (!row.ok) return { text: "—", cls: "text-muted-foreground" };
  const t = row.ttftMs ?? Number.POSITIVE_INFINITY;
  if (t < 1500) return { text: "Great for live", cls: "text-success" };
  if (t < 3000) return { text: "Usable live", cls: "text-accent" };
  return { text: "Summaries only", cls: "text-muted-foreground" };
}

/** Benchmark harness: times each available AI lane on one fixed short prompt
 * through the real streaming front door (`aiGenerateStream`). Results are
 * measured and persisted only on this device. */
function AiSpeedTestSection() {
  const [rows, setRows] = useState<SpeedRow[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Restore the last results (this device only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SPEEDTEST_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { at: string; rows: SpeedRow[] };
      if (Array.isArray(saved.rows)) {
        setRows(saved.rows.map((r) => ({ ...r, running: false })));
        setLastRun(saved.at);
      }
    } catch {
      /* corrupt cache — ignore */
    }
  }, []);

  const discoverLanes = useCallback(async (): Promise<{ lanes: SpeedLane[]; note: string | null }> => {
    const lanes: SpeedLane[] = [];
    const notes: string[] = [];

    // Online lane: the user's current cloud model, or the default if their
    // current pick is on-device. Only testable when a cloud route resolves.
    const current = getModel();
    const onlineModel =
      !isLocalModelId(current) && !isAppleModelId(current) ? current : DEFAULT_MODEL;
    const route = await aiRoute(onlineModel).catch(() => "none" as const);
    const modelLabel = MODELS.find((m) => m.id === onlineModel)?.label ?? onlineModel;
    if (route === "free") {
      lanes.push({ id: onlineModel, label: `${modelLabel} · free tier`, kind: "online" });
    } else if (route === "byok") {
      lanes.push({ id: onlineModel, label: `${modelLabel} · your key`, kind: "online" });
    } else {
      notes.push("Online model: sign in or add an API key to test it.");
    }

    // Apple on-device (macOS 26+ / eligible hardware).
    const apple = await appleLlmStatus().catch(() => ({ available: false }) as AppleLlmStatus);
    if (apple.available) {
      lanes.push({ id: APPLE_MODEL_ID, label: "Apple Intelligence", kind: "apple" });
    }

    // Each downloaded local GGUF.
    try {
      const statuses = await localLlmStatus(LOCAL_MODEL_CATALOG.map((s) => s.file));
      const present = new Set(statuses.filter((s) => s.present).map((s) => s.file));
      for (const spec of LOCAL_MODEL_CATALOG) {
        if (present.has(spec.file)) {
          lanes.push({ id: localModelId(spec), label: `Local: ${spec.label}`, kind: "local" });
        }
      }
    } catch {
      /* no local models available */
    }
    if (!lanes.some((l) => l.kind === "local")) {
      notes.push("Local models: download one above to test on-device speed.");
    }

    return { lanes, note: notes.length ? notes.join(" ") : null };
  }, []);

  const runOne = async (lane: SpeedLane): Promise<SpeedRow> => {
    let firstAt = 0;
    const start = performance.now();
    try {
      const { result } = aiGenerateStream(
        SPEEDTEST_USER,
        SPEEDTEST_SYS,
        () => {
          if (!firstAt) firstAt = performance.now();
        },
        { model: lane.id, maxTokens: SPEEDTEST_MAX_TOKENS, rawSystem: true, interactive: true },
      );
      const text = await result;
      const end = performance.now();
      const ttftMs = firstAt ? firstAt - start : end - start;
      const estTokens = Math.max(1, Math.round(text.trim().length / 4));
      const genMs = Math.max(1, end - (firstAt || start));
      const tps = estTokens / (genMs / 1000);
      return { label: lane.label, kind: lane.kind, ok: true, ttftMs, tps, totalMs: end - start };
    } catch (e) {
      return { label: lane.label, kind: lane.kind, ok: false, error: String(e) };
    }
  };

  const run = async () => {
    setRunning(true);
    setNote(null);
    const { lanes, note: discoverNote } = await discoverLanes();
    setNote(discoverNote);
    if (lanes.length === 0) {
      setRows([]);
      setRunning(false);
      return;
    }
    // Seed pending rows so the table appears at once, then measure lanes one at
    // a time (concurrent local models would thrash the GPU + RAM).
    setRows(lanes.map((l) => ({ label: l.label, kind: l.kind, ok: false, running: true })));
    const done: SpeedRow[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const row = await runOne(lanes[i]);
      done.push(row);
      setRows((prev) => {
        const next = [...prev];
        next[i] = row;
        return next;
      });
    }
    const at = new Date().toISOString();
    setLastRun(at);
    try {
      localStorage.setItem(SPEEDTEST_KEY, JSON.stringify({ at, rows: done }));
    } catch {
      /* storage full — the run still showed live */
    }
    setRunning(false);
  };

  return (
    <Section
      icon={<Gauge className="h-5 w-5" />}
      title="AI speed test"
      description="Measure how fast each available AI lane responds on this device — first-token latency, tokens/sec and total time — so you know which is quick enough for live use. One short prompt per lane; results stay on this device."
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={running}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Testing…
              </>
            ) : (
              "Run speed test"
            )}
          </Button>
          {lastRun && !running && (
            <span className="text-xs text-muted-foreground">
              Last run {new Date(lastRun).toLocaleString()}
            </span>
          )}
        </div>

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Lane</th>
                  <th className="py-1.5 pr-3 font-medium">First token</th>
                  <th className="py-1.5 pr-3 font-medium">Tokens/sec</th>
                  <th className="py-1.5 pr-3 font-medium">Total</th>
                  <th className="py-1.5 font-medium">For live use</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const verdict = liveVerdict(r);
                  return (
                    <tr key={`${r.label}-${i}`} className="border-b border-border/50">
                      <td className="py-1.5 pr-3">{r.label}</td>
                      {r.running ? (
                        <td colSpan={4} className="py-1.5 text-muted-foreground">
                          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                          measuring…
                        </td>
                      ) : r.ok ? (
                        <>
                          <td className="py-1.5 pr-3 tabular-nums">{fmtMs(r.ttftMs)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">
                            {r.tps ? r.tps.toFixed(1) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">{fmtMs(r.totalMs)}</td>
                          <td className={cn("py-1.5", verdict.cls)}>{verdict.text}</td>
                        </>
                      ) : (
                        <td colSpan={4} className="py-1.5 break-words text-danger">
                          {r.error ?? "failed"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <p className="text-xs text-muted-foreground">
          Under 1.5&nbsp;s to first token is great for a live copilot; under 3&nbsp;s is
          usable; slower lanes are best kept for summaries. Local models include a
          one-time load on a cold start — run twice for a warm number. Nothing is sent
          anywhere: results are measured and stored only on this device.
        </p>
      </div>
    </Section>
  );
}

const DICTIONARY_TEMPLATE = `# Custom dictionary
# One term per line: - term | weight | sounds like
# Weight (optional, 0.1–10): higher survives longer when space runs out.
# Sounds-like (optional): common mis-hearings, comma-separated.

- Auxo | 3 | Oxo, Ozo
- Lalela | 2
`;

/** Editor for dictionary.md (Intelligence Layer, Slice 0-ext): explicit
 * transcription-bias terms with weights, fed to the speech engine. */
function DictionarySection({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [termCount, setTermCount] = useState(0);

  useEffect(() => {
    getDictionary()
      .then(async (d) => {
        setText(d);
        setTermCount(await previewDictionary(d).catch(() => 0));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const onChange = (value: string) => {
    setText(value);
    setDirty(true);
    previewDictionary(value)
      .then(setTermCount)
      .catch(() => {});
  };

  const save = async () => {
    try {
      setTermCount(await setDictionary(text));
      setDirty(false);
      onSaved();
    } catch {
      // save root may not exist yet; nothing actionable here
    }
  };

  return (
    <Section
      icon={<BookA className="h-5 w-5" />}
      title="Custom dictionary"
      description="Words Lalela keeps mishearing — niche product names, jargon, unusual surnames. Weighted terms bias the transcriber. Stored as dictionary.md in your save folder."
    >
      {loaded && !text && (
        <Button
          variant="outline"
          size="sm"
          className="mb-2"
          onClick={() => onChange(DICTIONARY_TEMPLATE)}
        >
          Insert template
        </Button>
      )}
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        placeholder={loaded ? DICTIONARY_TEMPLATE : "Loading…"}
        className={`${inputClass} font-mono text-xs`}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {termCount} term{termCount === 1 ? "" : "s"} recognised · paste any list — lines starting
          with “-” count.
        </p>
        <Button size="sm" onClick={save} disabled={!dirty}>
          Save
        </Button>
      </div>
    </Section>
  );
}

/** Speaker recognition (Intelligence Layer, Slice 1): voiceprint opt-in +
 * the local speaker directory (rename / merge / delete). */
function SpeakersSection({ onSaved }: { onSaved: () => void }) {
  const [enabled, setEnabled] = useState(getVoiceprintsEnabled());
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<Speaker | null>(null);

  useEffect(() => {
    listSpeakers().then(setSpeakers).catch(() => {});
  }, []);

  const commitRename = async (s: Speaker) => {
    const draft = (drafts[s.id] ?? s.name).trim();
    if (!draft || draft === s.name) return;
    try {
      setSpeakers(await renameSpeaker(s.id, draft));
      onSaved();
    } catch {
      /* keep the old list on failure */
    }
  };

  return (
    <Section
      icon={<Users className="h-5 w-5" />}
      title="People & voices"
      description="Name someone once and Lalela recognises their voice in future meetings. Voiceprints are computed and stored only on this device, and only when this is on."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setVoiceprintsEnabled(e.target.checked);
            onSaved();
          }}
          className="accent-[var(--color-accent)]"
        />
        Recognise speakers across meetings (voiceprints)
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        A voiceprint is only saved when you confirm who a speaker is (“This is…” on a
        transcript). Voiceprints never leave this device and are deleted with the person below.
        Let your meeting participants know voice recognition is on.
      </p>

      {speakers.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Directory</div>
          {speakers.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2 rounded-[var(--radius)] border border-border p-2 text-sm"
            >
              <input
                value={drafts[s.id] ?? s.name}
                onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                onBlur={() => commitRename(s)}
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 outline-none focus:border-border"
              />
              {s.has_voiceprint && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs">voice</span>
              )}
              <span className="text-xs text-muted-foreground">
                {s.meeting_count} meeting{s.meeting_count === 1 ? "" : "s"}
              </span>
              <select
                value=""
                onChange={async (e) => {
                  const mergedId = e.target.value;
                  if (!mergedId) return;
                  try {
                    setSpeakers(await mergeSpeakers(s.id, mergedId));
                    onSaved();
                  } catch {
                    /* ignore */
                  }
                }}
                className="rounded border border-border bg-card px-1 py-0.5 text-xs"
                title="Merge another entry into this person"
              >
                <option value="">Merge…</option>
                {speakers
                  .filter((o) => o.id !== s.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => setConfirmDelete(s)}
                className="text-muted-foreground hover:text-danger"
                title="Delete this person and their voiceprint"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {speakers.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          No one yet — after a multi-person recording, open the meeting and use “This is…” on a
          speaker to name them.
        </p>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          body="Removes them from the directory and deletes their voiceprint. Meeting transcripts keep their name."
          confirmLabel="Delete"
          onConfirm={async () => {
            try {
              setSpeakers(await deleteSpeaker(confirmDelete.id));
              onSaved();
            } catch {
              /* ignore */
            }
            setConfirmDelete(null);
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </Section>
  );
}

const WORKSPACE_TEMPLATE = `# Workspace

One line about your company and what it does.

## Key people
- Name — role

## Clients
- Client name

## Glossary
- Term — what it means
`;

/** Editor for workspace.md (Intelligence Layer, Slice 0): company context
 * injected into every AI generation and mined for transcription vocabulary. */
function WorkspaceCardSection({ onSaved }: { onSaved: () => void }) {
  const [card, setCard] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getWorkspaceCard()
      .then((c) => setCard(c))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    try {
      await setWorkspaceCard(card);
      setDirty(false);
      onSaved();
    } catch {
      // save root may not exist yet; nothing actionable here
    }
  };

  return (
    <Section
      icon={<Building2 className="h-5 w-5" />}
      title="Workspace context"
      description="Who you are: company one-liner, key people, clients, glossary. Lalela adds this to every summary and chat, and uses the names to transcribe them correctly. Stored as workspace.md in your save folder."
    >
      {loaded && !card && (
        <Button
          variant="outline"
          size="sm"
          className="mb-2"
          onClick={() => {
            setCard(WORKSPACE_TEMPLATE);
            setDirty(true);
          }}
        >
          Insert template
        </Button>
      )}
      <textarea
        value={card}
        onChange={(e) => {
          setCard(e.target.value);
          setDirty(true);
        }}
        rows={10}
        placeholder={loaded ? WORKSPACE_TEMPLATE : "Loading…"}
        className={`${inputClass} font-mono text-xs`}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Names under People / Clients / Glossary headings also improve transcription accuracy.
        </p>
        <Button size="sm" onClick={save} disabled={!dirty}>
          Save
        </Button>
      </div>
    </Section>
  );
}

/** What the Microsoft connection powers — shown before AND after connecting
 * so the value exchange is explicit. */
const MS_POWERS = [
  "Auto-titles native recordings from the matching calendar event",
  "Attaches calendar attendees to each recorded meeting",
  "One-click speaker naming from the attendee list",
  "Transcribes attendee names more accurately",
  "Imports your Teams meeting transcripts",
];

/**
 * How the last Teams transcript import ended. Imports run in the background,
 * so without this the only symptom of a broken connection is meetings quietly
 * not arriving — which is exactly how a tenant-side transcript block went
 * unnoticed for a week. Failures use the app's amber callout idiom (colored
 * icon, foreground text on a tinted panel) so they stay legible on the light
 * background this app always renders against.
 */
function ImportOutcomeNotice({ outcome }: { outcome: MsImportOutcome | null }) {
  if (!outcome) return null;
  const when = new Date(outcome.at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const plural = (n: number) => (n === 1 ? "" : "s");
  // How the scan broke down is what makes "imported 0" readable: "40 read,
  // 3 refused" tells a very different story from 43 read cleanly. Only shown
  // when something was not read, so the healthy case stays a single sentence.
  const breakdown =
    outcome.unresolved > 0 || outcome.refused > 0
      ? ` (${outcome.resolved} read, ${outcome.unresolved} unmatched, ${outcome.refused} refused)`
      : "";

  if (outcome.ok) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        {outcome.imported === 0
          ? `Up to date — no new transcripts in ${outcome.scanned} meeting${plural(
              outcome.scanned,
            )} checked${breakdown} (${when}).`
          : `Last imported ${outcome.imported} transcript${plural(
              outcome.imported,
            )} at ${when}${breakdown}.`}
      </p>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium">Teams transcript import failed — {when}</p>
        <p className="mt-1">{msImportFailureHint(outcome)}</p>
        <p className="mt-1 text-muted-foreground">
          {outcome.errorClass}
          {outcome.code ? ` · ${outcome.code}` : ""} · {outcome.scanned} meeting
          {plural(outcome.scanned)} checked · {outcome.resolved} read ·{" "}
          {outcome.unresolved} unmatched · {outcome.refused} refused
        </p>
      </div>
    </div>
  );
}

/** Settings → Connections → Lalela cloud. Sync runs in the background and
 * every write path is best-effort, so without this the only symptom of a dead
 * backend (paused project, expired session, RLS change) is meetings quietly
 * not arriving anywhere else — the user assumes they are backed up and shared,
 * and they are not. One honest line: when it last worked, or since when it has
 * not, and why. */
function CloudSyncSection() {
  const { user } = useAuth();
  const [outcome, setOutcome] = useState<SyncOutcome | null>(getSyncOutcome());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const read = () => setOutcome(getSyncOutcome());
    window.addEventListener(SYNC_OUTCOME_CHANGED_EVENT, read);
    return () => window.removeEventListener(SYNC_OUTCOME_CHANGED_EVENT, read);
  }, []);

  const syncNow = async () => {
    if (!user) return;
    setSyncing(true);
    try {
      // Manual "Sync now" re-sends every owned meeting (background runs only
      // send what changed) — the escape hatch if the cloud copy ever drifts.
      const r = await syncUp(user.id, { full: true });
      if (r.failed > 0)
        recordSyncFailure(
          r.lastError ?? new Error(`${r.failed} item${r.failed === 1 ? "" : "s"} failed to sync`),
        );
      else recordSyncSuccess({ skipped: r.skipped });
    } catch (e) {
      recordSyncFailure(e);
    } finally {
      setSyncing(false);
      setOutcome(getSyncOutcome());
    }
  };

  const when = (at: number) =>
    new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Section
      icon={<Cloud className="h-5 w-5" />}
      title="Lalela cloud"
      description={`Meetings you record are stored on this ${DEVICE_NOUN} first, then pushed to your Lalela account so they are backed up and shareable. If that push ever stops working, it shows here.`}
    >
      {!user && (
        <p className="text-sm text-muted-foreground">
          Not signed in — nothing is syncing. Meetings stay on this {DEVICE_NOUN} only.
        </p>
      )}

      {user && !outcome && (
        <p className="text-sm text-muted-foreground">No sync has run yet in this session.</p>
      )}

      {user && outcome?.ok && (
        <p className="flex items-center gap-1.5 text-sm text-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          Last sync {when(outcome.at)} — everything on this {DEVICE_NOUN} is in your Lalela account.
        </p>
      )}

      {user && outcome?.ok && foreignSkipLine(outcome.skipped) && (
        <p className="mt-1 text-xs text-muted-foreground">{foreignSkipLine(outcome.skipped)}</p>
      )}

      {user && outcome && !outcome.ok && (
        <div className="flex items-start gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">
              Sync failing since {when(outcome.failingSince ?? outcome.at)}
            </p>
            <p className="mt-1">{syncFailureHint(outcome)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {outcome.errorClass}
              {outcome.code ? ` · ${outcome.code}` : ""}
              {outcome.error ? ` · ${outcome.error}` : ""} · last tried {when(outcome.at)}
            </p>
          </div>
        </div>
      )}

      {user && (
        <Button variant="outline" size="sm" className="mt-3" onClick={syncNow} disabled={syncing}>
          {syncing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Syncing…
            </>
          ) : (
            "Sync now"
          )}
        </Button>
      )}
    </Section>
  );
}

/** Settings → Connections → Microsoft account (Slice 9). Strictly opt-in:
 * public-client OAuth (PKCE) in the system browser, refresh token in the
 * platform credential store (macOS Keychain / Windows Credential Manager),
 * disconnect wipes everything. */
function MicrosoftSection({ onSaved }: { onSaved: () => void }) {
  const [account, setAccount] = useState<MsAccount | null>(connectedAccount());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOn, setImportOn] = useState(getMsImportEnabled());
  const [days, setDays] = useState(getMsBackfillDays());
  const [comingUpDays, setComingUpDaysState] = useState(getComingUpDays());
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<MsImportOutcome | null>(getMsImportOutcome());

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await msConnect());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    await msDisconnect();
    setAccount(null);
    setOutcome(null);
    setError(null);
    onSaved();
  };

  const handleImportNow = async () => {
    setImporting(true);
    setError(null);
    try {
      // Graph/auth/network failures come back IN the result (classified), so
      // a manual run reports them through the same notice the background
      // runs write to, instead of only living in this component's state.
      const result = await importTeamsTranscripts({ days });
      setMsImportLastRun(Date.now());
      setMsImportOutcome(result);
      setOutcome(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Section
      icon={<Plug className="h-5 w-5" />}
      title="Microsoft account"
      description="Optional. One sign-in connects your Outlook calendar and Teams transcripts. Lalela works identically without it — nothing runs until you connect."
    >
      {!account ? (
        <>
          <ul className="mb-3 space-y-1 text-sm text-muted-foreground">
            {MS_POWERS.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
          <Button onClick={handleConnect} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            {busy ? "Waiting for browser sign-in…" : "Connect Microsoft account"}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Signs in through your browser. Lalela only ever reads your calendar and Teams
            transcripts; the sign-in token stays in {IS_WINDOWS ? "Windows Credential Manager" : "the macOS Keychain"} on this device.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <div className="font-medium">{account.displayName}</div>
              <div className="text-muted-foreground">
                {account.mail ?? "Connected"}
                <span className="ml-2 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-foreground">
                  Connected
                </span>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {MS_POWERS.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>

          <div className="mt-4 border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={importOn}
                onChange={(e) => {
                  setImportOn(e.target.checked);
                  setMsImportEnabled(e.target.checked);
                  onSaved();
                }}
                className="accent-[var(--color-accent)]"
              />
              Import Teams transcripts automatically
            </label>
            <p className="-mt-1 ml-6 text-xs text-muted-foreground">
              Checks for new transcripts when Lalela regains focus (at most every 30 minutes)
              and files them under “Imported from Microsoft Teams”.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Backfill window</label>
              <select
                value={days}
                onChange={(e) => {
                  const d = Number(e.target.value);
                  setDays(d);
                  setMsBackfillDays(d);
                  onSaved();
                }}
                className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
              >
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
              <Button variant="outline" size="sm" onClick={handleImportNow} disabled={importing}>
                {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                {importing ? "Importing…" : "Import now"}
              </Button>
            </div>
            <ImportOutcomeNotice outcome={outcome} />
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <label className="text-sm font-medium">“Coming up” horizon</label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              How far ahead the upcoming-meetings rail above your Meetings list looks.
            </p>
            <select
              value={comingUpDays}
              onChange={(e) => {
                const d = Number(e.target.value);
                setComingUpDaysState(d);
                setComingUpDays(d);
                onSaved();
              }}
              className="mt-2 h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            >
              <option value={1}>The next day</option>
              <option value={3}>The next 3 days</option>
              <option value={7}>The next 7 days</option>
              <option value={14}>The next 14 days</option>
            </select>
          </div>
        </>
      )}
      {error && <p className="mt-3 break-words text-sm text-danger">{error}</p>}
    </Section>
  );
}

/** Other notetakers (Fathom, Read AI, Granola, Fireflies…) connect in the
 * Lalela web app — they need server-side OAuth callbacks and scheduled syncs
 * that a desktop app can't host. Imported meetings reach this app through the
 * normal cloud pull-down, so this section just points people at the web flow. */
function OtherNotetakersSection() {
  const { user } = useAuth();
  return (
    <Section
      icon={<ExternalLink className="h-5 w-5" />}
      title="Other notetakers"
      description="Bring the meetings you already have in Otter, Fathom, Read AI, Granola or Fireflies. These connect in the Lalela web app; new transcripts land in an “Imported from …” folder and appear here automatically."
    >
      <Button variant="outline" onClick={() => openUrl(`${LALELA_API}/settings`).catch(() => {})}>
        <ExternalLink className="h-4 w-4" />
        Open web app connections
      </Button>
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        <li>· Sign in to the web app with this same account, then connect a notetaker under Settings → Connections.</li>
        <li>
          ·{" "}
          {user
            ? "Imported meetings sync into this app when it regains focus."
            : "Then sign in on this device (Settings → Account) — imported meetings sync in when the app regains focus."}
        </li>
        <li>· Microsoft Teams doesn’t need this: the Microsoft connection above imports Teams transcripts directly.</li>
      </ul>
    </Section>
  );
}

/** Desktop-only "Software update" card. Lalela already checks in the background
 * (see UpdateBanner) and updates on next launch — this lets you pull the newer
 * signed build right now without quitting: check → download (with progress) →
 * install → relaunch, all through lib/updater (same signed/verified flow the
 * banner uses). iOS ships updates through the App Store, so the caller keeps
 * this behind !IS_MOBILE. */
/** Wave C1: keep Lalela in the menu bar when the window is closed. The setting
 * is stored server-side of the webview (SQLite via Rust), so we load it async
 * and default to ON if the read fails. */
/** Human byte size for the model list, e.g. "2.3 GB" / "142 MB". */
function humanBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Short, sober badge label per model kind. */
const KIND_BADGE: Record<LocalModelFile["kind"], string> = {
  llm: "Local AI",
  asr: "Transcription",
  diarization: "Speakers",
};

/** Turn a downloaded LLM's filename into its catalog label when we know it. */
function modelDisplayName(m: LocalModelFile): string {
  if (m.kind === "llm") {
    const spec = LOCAL_MODEL_CATALOG.find((s) => s.file === m.file);
    if (spec) return spec.label;
  }
  return m.label;
}

/** Map the backend's typed delete error to reassuring copy. */
function deleteErrorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case "recording_in_progress":
      return "Stop the current recording first — its transcription engine is using these models.";
    case "outside_model_dir":
      return "That file isn't in Lalela's models folder, so nothing was deleted.";
    case "not_found":
      return "That model file is already gone — refreshing the list.";
    case "failed":
      return (e as { message?: string })?.message || "Couldn't delete the model. Please try again.";
    default:
      return e instanceof Error ? e.message : "Couldn't delete the model. Please try again.";
  }
}

/**
 * "Downloaded models" — the disk-reclaim UI (desktop only). Lists every model
 * file actually on disk (local LLMs, the whisper transcription model, the
 * speaker ONNX models) with per-row delete. Everything is re-downloadable, so
 * deletion is reversible; the copy says so. Delete is disabled (with a tooltip)
 * for a model that's loaded or whose engine a live recording is using — the
 * backend refuses those too, this just avoids a dead click.
 */
function DownloadedModelsSection() {
  const [models, setModels] = useState<LocalModelFile[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [confirm, setConfirm] = useState<LocalModelFile | null>(null);
  const [freedNote, setFreedNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listLocalModels()
      .then((list) => {
        setModels(list.models);
        setTotalBytes(list.total_bytes);
        setDir(list.dir);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    // Recording can start/stop while this view is open; keep the in-use guard
    // fresh so ASR/diarization rows disable the moment a capture begins.
    const tick = () => isRecording().then(setRecording).catch(() => {});
    tick();
    const id = window.setInterval(tick, 4000);
    // A download finishing elsewhere adds a file — re-list when it completes.
    const un = onLlmComplete(() => refresh());
    return () => {
      window.clearInterval(id);
      un.then((f) => f()).catch(() => {});
    };
  }, [refresh]);

  // A model is un-deletable while it's resident in the sidecar or (ASR/speaker
  // models) while a recording is live.
  const inUse = (m: LocalModelFile) =>
    m.in_use || (recording && (m.kind === "asr" || m.kind === "diarization"));

  return (
    <Section
      icon={<HardDriveDownload className="h-5 w-5" />}
      title="Downloaded models"
      description={`On-device AI models live on this ${DEVICE_NOUN} so Lalela works offline and private. Remove any you're not using to reclaim disk space — Lalela re-downloads a model automatically the next time it needs it, so nothing here is permanent.`}
    >
      {!loaded ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking downloaded models…
        </p>
      ) : models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No models downloaded yet. Lalela downloads what it needs on first use.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">
              {humanBytes(totalBytes)} on disk
              <span className="ml-1 font-normal text-muted-foreground">
                · {models.length} {models.length === 1 ? "model" : "models"}
              </span>
            </span>
          </div>
          {freedNote && <p className="mb-3 text-sm text-success">{freedNote}</p>}
          <ul className="divide-y divide-border rounded-[var(--radius)] border border-border">
            {models.map((m) => {
              const locked = inUse(m);
              return (
                <li key={m.path} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{modelDisplayName(m)}</span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {KIND_BADGE[m.kind]}
                      </span>
                      {m.is_base_asr && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          needed for transcription
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {humanBytes(m.size_bytes)}
                      {locked && (
                        <span className="ml-2 text-warning">
                          · in use{m.kind === "llm" ? " (loaded)" : " (recording)"}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={locked}
                    title={
                      locked
                        ? m.kind === "llm"
                          ? "This model is loaded right now — it'll free up on its own, then you can delete it."
                          : "Stop the current recording to delete this model."
                        : "Delete this model to reclaim disk space"
                    }
                    onClick={() => {
                      setFreedNote(null);
                      setConfirm(m);
                    }}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                  </Button>
                </li>
              );
            })}
          </ul>
          {dir && (
            <p className="mt-2 break-all text-[11px] text-muted-foreground">Stored in {dir}</p>
          )}
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Delete ${modelDisplayName(confirm)}?`}
          body={
            confirm.is_base_asr
              ? `This frees ${humanBytes(confirm.size_bytes)}. It's the transcription model — Lalela re-downloads it automatically before your next recording, so you won't lose anything.`
              : `This frees ${humanBytes(confirm.size_bytes)}. ${
                  confirm.kind === "llm"
                    ? "Lalela re-downloads this local AI model the next time you pick it — nothing is lost."
                    : "Lalela re-downloads it automatically the next time it's needed — nothing is lost."
                }`
          }
          confirmLabel="Delete model"
          onConfirm={async () => {
            try {
              const res = await deleteLocalModel(confirm.path);
              setFreedNote(`Freed ${humanBytes(res.freed_bytes)}.`);
              refresh();
            } catch (e) {
              refresh();
              throw new Error(deleteErrorMessage(e));
            }
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </Section>
  );
}

function MenuBarSection() {
  const [on, setOn] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getCloseToTray()
      .then(setOn)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  return (
    <Section
      icon={<PanelTop className="h-5 w-5" />}
      title={IS_WINDOWS ? "System tray" : "Menu bar"}
      description={
        IS_WINDOWS
          ? "Lalela can stay in your system tray so it's always a click away — with your next meetings and a quick way to start recording."
          : "Lalela can stay in your Mac's menu bar so it's always a click away — with your next meetings and a quick way to start recording."
      }
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={!loaded}
          onChange={(e) => {
            setOn(e.target.checked);
            setCloseToTray(e.target.checked).catch(() => {});
          }}
          className="accent-[var(--color-accent)]"
        />
        Keep Lalela running in the {IS_WINDOWS ? "system tray" : "menu bar"} when the window is
        closed
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        On by default. Closing the window hides it to the {IS_WINDOWS ? "tray" : "menu bar"} instead
        of quitting, so meeting auto-detect and recordings keep working. Use Quit in the{" "}
        {IS_WINDOWS ? "tray icon" : `menu-bar icon (or ${chord("Q")})`} to exit completely.
      </p>
    </Section>
  );
}

/** Microsoft Store build: there is no in-app updater to offer, so say where
 * updates actually come from rather than showing a button that cannot work.
 * The Store re-signs and re-delivers the MSIX; an MSIX install is immutable,
 * so self-updating is not merely disabled here, it is impossible. */
function StoreUpdateSection({ version }: { version: string }) {
  return (
    <Section
      icon={<DownloadCloud className="h-5 w-5" />}
      title="Software update"
      description={STORE_UPDATE_NOTE}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          Current version <span className="font-medium">{version ? `v${version}` : "…"}</span>
        </span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        You installed Lalela from the Microsoft Store, so Windows keeps it up to date for you —
        there is nothing to check or download here. To update right now, open the Microsoft Store
        app and choose <strong>Library</strong> → <strong>Get updates</strong>.
      </p>
    </Section>
  );
}

/** Community edition: no self-updater (no Auxo feed, no signing key). Point at
 *  the source repo instead of a button that cannot work. */
function CommunityUpdateSection({ version }: { version: string }) {
  return (
    <Section
      icon={<DownloadCloud className="h-5 w-5" />}
      title="Software update"
      description="Lalela Community does not update itself."
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          Current version <span className="font-medium">{version ? `v${version}` : "…"}</span>
        </span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        You built this copy from source. To update, pull the latest code from{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => openUrl(COMMUNITY_REPO_URL).catch(() => {})}
        >
          the Lalela Community repository
        </button>{" "}
        and rebuild.
      </p>
    </Section>
  );
}

const COMMUNITY_REPO_URL = "https://github.com/OzRazak/lalela-community";

function SoftwareUpdateSection({ version }: { version: string }) {
  if (IS_COMMUNITY) return <CommunityUpdateSection version={version} />;
  if (IS_STORE_BUILD) return <StoreUpdateSection version={version} />;
  return <DirectSoftwareUpdateSection version={version} />;
}

function DirectSoftwareUpdateSection({ version }: { version: string }) {
  type UiState =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "current" }
    | { kind: "available"; update: Update }
    | { kind: "downloading"; pct: number | null }
    | { kind: "error"; message: string };
  const [state, setState] = useState<UiState>({ kind: "idle" });

  // A failed check here has always reported the real error text; recording it
  // is what lets the automatic banner count consecutive failures (and what a
  // successful manual check resets).
  const runCheck = async () => {
    setState({ kind: "checking" });
    const result = await checkForUpdateDetailed();
    recordUpdateCheck(result);
    if (result.status === "available") setState({ kind: "available", update: result.update });
    else if (result.status === "current") setState({ kind: "current" });
    else setState({ kind: "error", message: result.message });
  };

  // Before the user presses anything, show how the last automatic check went —
  // otherwise a feed that has been dead for a week looks like a quiet, healthy
  // app.
  const last = state.kind === "idle" ? lastUpdateCheck() : null;

  const runUpdate = async () => {
    if (state.kind !== "available") return;
    const u = state.update;
    setState({ kind: "downloading", pct: null });
    try {
      await installAndRelaunch(u, (d, total) => {
        setState({ kind: "downloading", pct: total ? Math.round((d / total) * 100) : null });
      });
      // relaunch() replaces the process — nothing below runs on success.
    } catch (e) {
      setState({ kind: "error", message: updateErrorMessage(e) });
    }
  };

  const busy = state.kind === "checking" || state.kind === "downloading";
  // While an update is queued or installing, the check button steps aside for
  // the update/progress UI below.
  const showCheckButton = state.kind !== "available" && state.kind !== "downloading";

  return (
    <Section
      icon={<DownloadCloud className="h-5 w-5" />}
      title="Software update"
      description="Lalela checks for updates on its own and installs them the next time you open it. You can also check right now — no need to quit and reopen. Every update is signed and verified before it installs."
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          Current version{" "}
          <span className="font-medium">{version ? `v${version}` : "…"}</span>
        </span>
        {showCheckButton && (
          <Button variant="outline" size="sm" onClick={runCheck} disabled={busy}>
            {state.kind === "checking" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking…
              </>
            ) : (
              "Check for updates"
            )}
          </Button>
        )}
      </div>

      {last?.status === "error" && (
        <p className="mt-3 flex items-start gap-1.5 break-words text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Last automatic check failed ({new Date(last.checkedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}) — {last.error}
          </span>
        </p>
      )}

      {state.kind === "current" && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          You're on the latest version{version ? ` (v${version})` : ""}.
        </p>
      )}

      {state.kind === "available" && (
        <div className="mt-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-3">
          <p className="text-sm font-semibold">Version {state.update.version} available</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.update.body
              ? state.update.body
              : "Download the new version now — Lalela will restart to finish updating."}
          </p>
          <Button size="sm" className="mt-3" onClick={runUpdate}>
            <Download className="h-4 w-4" />
            Update and restart
          </Button>
        </div>
      )}

      {state.kind === "downloading" && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            {state.pct === null ? "Downloading…" : `Downloading ${state.pct}%`} — Lalela will
            restart automatically.
          </p>
          {state.pct !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${state.pct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {state.kind === "error" && (
        <p className="mt-3 break-words text-sm text-danger">{state.message}</p>
      )}
    </Section>
  );
}

/** Notifications (Wave C3): which OS notifications Lalela sends, and which
 * activity shows in the notification bell. Detection + model-ready are
 * desktop-only (iOS has no meeting detector and no local GGUF models); the two
 * feed toggles apply on every platform. Persisted in SQLite via
 * lib/notifications (not localStorage — the model-ready notification is fired
 * from Rust and reads the same gate). */
function NotificationsSection({ onSaved }: { onSaved: () => void }) {
  const prefs = useNotificationPrefs();
  const update = (patch: Partial<NotificationPrefs>) => {
    void setNotificationPrefs({ ...prefs, ...patch });
    onSaved();
  };
  const toggleKind = (id: string) => {
    const muted = prefs.mutedDetectionKinds.includes(id)
      ? prefs.mutedDetectionKinds.filter((k) => k !== id)
      : [...prefs.mutedDetectionKinds, id];
    update({ mutedDetectionKinds: muted });
  };

  return (
    <Section
      icon={<Bell className="h-5 w-5" />}
      title="Notifications"
      description="Choose which desktop notifications Lalela sends, and which activity appears in the notification bell."
    >
      {!IS_MOBILE && (
        <>
          {/* Meeting auto-detect needs the macOS lalela-detect helper; there is
              no Windows detector yet, so don't offer a notification for it. */}
          {!IS_WINDOWS && (
          <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs.meetingDetection}
              onChange={(e) => update({ meetingDetection: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            Notify me when a meeting is detected
          </label>
          <p className="-mt-1 ml-6 text-xs text-muted-foreground">
            When a call starts and Lalela isn't in front, you'll get a notification so you can
            capture it. Whether detection runs at all is set under Recording → “Detect Zoom / Meet
            / Teams calls”.
          </p>
          {prefs.meetingDetection && (
            <div className="ml-6 mt-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Don't notify me for</p>
              <div className="space-y-1.5">
                {DETECTION_KINDS.map((k) => (
                  <label key={k.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={prefs.mutedDetectionKinds.includes(k.id)}
                      onChange={() => toggleKind(k.id)}
                      className="accent-[var(--color-accent)]"
                    />
                    {k.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          </>
          )}

          <label className={`${IS_WINDOWS ? "" : "mt-4 "}flex items-center gap-2 text-sm`}>
            <input
              type="checkbox"
              checked={prefs.modelReady}
              onChange={(e) => update({ modelReady: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            Notify me when a downloaded model is ready
          </label>
          <p className="-mt-1 ml-6 text-xs text-muted-foreground">
            A local AI model can take a while to download in the background — this tells you the
            moment it's ready to use.
          </p>
        </>
      )}

      <label className={`${IS_MOBILE ? "" : "mt-4 "}flex items-center gap-2 text-sm`}>
        <input
          type="checkbox"
          checked={prefs.overdueTasks}
          onChange={(e) => update({ overdueTasks: e.target.checked })}
          className="accent-[var(--color-accent)]"
        />
        Show overdue tasks in the notification bell
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        Overdue action items appear in the bell (and as its red badge). Turn off to hide them.
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.teamActivity}
          onChange={(e) => update({ teamActivity: e.target.checked })}
          className="accent-[var(--color-accent)]"
        />
        Show team activity in the notification bell
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        Shared-folder activity — task assignments, completions, new members — from your team.
      </p>
    </Section>
  );
}

export function SettingsView({ initialTab }: { initialTab?: SettingsTab } = {}) {
  const { user } = useAuth();
  const [apiKey, setKey] = useState(getApiKey());
  const [model, setModelState] = useState(getModel());
  const [aiSource, setAiSourceState] = useState<AiSource>(getAiSource());
  const [consentOn, setConsentOn] = useState(getConsentEnabled());
  const [consentMsg, setConsentMsg] = useState(getConsentText());
  const [autoDetectOn, setAutoDetectOn] = useState(getAutoDetectEnabled());
  const [systemAudioOn, setSystemAudioOn] = useState(getSystemAudioEnabled());
  const [irisFeedbackOn, setIrisFeedbackOn] = useState(getIrisFeedbackEnabled());
  const [folderRecursiveOn, setFolderRecursiveOn] = useState(getFolderRecursiveDefault());
  // Only builds compiled with an Iris key can send feedback; without one the
  // opt-in below is inert, so we hide it entirely (no dead control).
  const irisCapable = irisBuildConfig() !== null;
  const [transcription, setTranscription] = useState<TranscriptionMode>(getTranscriptionMode());
  const [asrEngine, setAsrEngineState] = useState(getAsrEngine());
  const [asrEngines, setAsrEngines] = useState<AsrEngineInfo[]>([]);
  const [autogenOn, setAutogenOn] = useState(getAutogenEnabled());
  const [autogenModelSel, setAutogenModelSel] = useState(getAutogenModel());
  const [actionsModelSel, setActionsModelSel] = useState(getActionsModel());
  const [responseLength, setResponseLengthState] = useState<ResponseLength>(getResponseLength());
  const availableModels = useAvailableModels();
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveFolder, setSaveFolder] = useState("");
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState<SettingsTab>(resolveTab(initialTab));

  useEffect(() => {
    getSaveFolder().then(setSaveFolder).catch(() => {});
    getVersion().then(setVersion).catch(() => {});
    listAsrEngines().then(setAsrEngines).catch(() => {});
  }, []);

  // Jump to a caller-requested tab (e.g. a "Sign in" click that deep-links to
  // Account) even when this view is already mounted.
  useEffect(() => {
    if (initialTab) setTab(resolveTab(initialTab));
  }, [initialTab]);

  const chooseFolder = async () => {
    const picked = await pickSaveFolder();
    if (picked) setSaveFolder(picked);
  };

  const flashSaved = () => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Transcription, AI models, privacy and storage.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {savedFlash && <span className="text-sm text-success">Saved</span>}
          {version && (
            <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
              Lalela v{version}
            </span>
          )}
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-border px-4 sm:px-6">
        {SETTINGS_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors",
              tab === id
                ? "border-[var(--color-accent)] font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        <div className="mx-auto grid max-w-2xl gap-4">
          {!user && !IS_COMMUNITY && (
            <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0 rounded-full bg-accent/15 p-2 text-accent">
                  <UserCircle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">You're not signed in</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sign in or create a free account to sync your meetings, share folders and get
                    a monthly AI allowance.
                  </p>
                </div>
                <Button size="sm" className="shrink-0" onClick={() => setTab("account")}>
                  Sign in
                </Button>
              </div>
            </div>
          )}
          {tab === "account" && (
            <>
          <Section
            icon={<UserCircle className="h-5 w-5" />}
            title="Account"
            description="Optional. Sign in to sync meetings across devices, share with your team, and get a free monthly AI allowance. Lalela works fully offline without an account."
          >
            <AccountPanel />
          </Section>

          <PlanUsageSection />
            </>
          )}

          {tab === "about" && !IS_MOBILE && (
            <>
              <Section
                icon={<Info className="h-5 w-5" />}
                title="About Lalela"
                description={
                  IS_COMMUNITY
                    ? "Lalela Community: the open-source, local-only edition. Recording and transcription stay on this device; AI runs on-device or with your own key."
                    : "Your private, on-device meeting notetaker. Recording and transcription stay on this device; AI runs on-device, with your own key, or on the free cloud allowance you opt into."
                }
              >
                <p className="text-sm">
                  Version <span className="font-medium">{version ? `v${version}` : "…"}</span>
                </p>
              </Section>
              <SoftwareUpdateSection version={version} />
              {!IS_COMMUNITY && <ReportAiSection />}
            </>
          )}

          {tab === "rewards" && <RewardsPanel />}

          {tab === "team" && <TeamSection />}

          {tab === "ai" && (
            <>
          <Section
            icon={<KeyRound className="h-5 w-5" />}
            title="AI model (bring your own key)"
            description={
              IS_COMMUNITY
                ? "Optional. Use your own OpenRouter key (stays on this device; usage is billed to you), or run a model on-device below."
                : "Optional. Without a key, signed-in users run on the free allowance above; with your own OpenRouter key (stays on this device) usage is unlimited and billed to you."
            }
          >
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              OpenRouter API key
            </label>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-or-..."
              onChange={(e) => setKey(e.target.value)}
              onBlur={() => {
                setApiKey(apiKey);
                flashSaved();
              }}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Get one at openrouter.ai → Keys. (Direct Anthropic / local models come later.)
            </p>

            {user && apiKey.trim() !== "" && (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  You have both a key and a free allowance — use
                </label>
                <div className="space-y-1.5">
                  {(
                    [
                      { id: "auto", label: "Automatic", note: "your key when set (today's behavior)" },
                      { id: "byok", label: "My own key", note: "always bill my provider account" },
                      { id: "free", label: "Free allowance", note: "use my Lalela plan; key stays as backup" },
                    ] satisfies Array<{ id: AiSource; label: string; note: string }>
                  ).map((opt) => (
                    <label key={opt.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="ai-source"
                        checked={aiSource === opt.id}
                        onChange={() => {
                          setAiSourceState(opt.id);
                          setAiSource(opt.id);
                          flashSaved();
                        }}
                        className="accent-[var(--color-accent)]"
                      />
                      <span>
                        {opt.label}
                        <span className="ml-1.5 text-xs text-muted-foreground">{opt.note}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
              Default model
            </label>
            <select
              value={model}
              onChange={(e) => {
                setModelState(e.target.value);
                setModel(e.target.value);
                flashSaved();
              }}
              className={inputClass}
            >
              {/* Downloaded local models first — they need no API key. */}
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </Section>

          {!IS_MOBILE && <LocalModelsSection />}

          {/* Apple Intelligence is on-device on BOTH platforms (macOS 26+ and
              iOS 26+), so it renders everywhere — it self-hides when the device
              can't run it. (LocalModelsSection above stays desktop-only: it
              manages GGUF downloads, which iOS has no path for.) */}
          <AppleIntelligenceSection />

          <AiSpeedTestSection />

          <Section
            icon={<Sparkles className="h-5 w-5" />}
            title="New meetings"
            description="What happens automatically right after a recording is saved."
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autogenOn}
                onChange={(e) => {
                  setAutogenOn(e.target.checked);
                  setAutogenEnabled(e.target.checked);
                  flashSaved();
                }}
                className="accent-[var(--color-accent)]"
              />
              Auto-generate the summary for each new meeting
            </label>
            <p className="-mt-1 ml-6 text-xs text-muted-foreground">
              A descriptive title is always suggested automatically when a model is usable;
              turning this on also runs your selected summary prompt right after saving.
            </p>
            <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
              Model for auto-generation
            </label>
            <select
              value={autogenModelSel}
              onChange={(e) => {
                setAutogenModelSel(e.target.value);
                setAutogenModel(e.target.value);
                flashSaved();
              }}
              className={inputClass}
            >
              <option value="">Use my current model</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
            <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
              Model for action-item extraction
            </label>
            <select
              value={actionsModelSel}
              onChange={(e) => {
                setActionsModelSel(e.target.value);
                setActionsModel(e.target.value);
                flashSaved();
              }}
              className={inputClass}
            >
              <option value="">Use my current model</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
            <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
              Response length
            </label>
            <select
              value={responseLength}
              onChange={(e) => {
                const v = e.target.value as ResponseLength;
                setResponseLengthState(v);
                setResponseLength(v);
                flashSaved();
              }}
              className={inputClass}
            >
              <option value="standard">Standard (default)</option>
              <option value="detailed">Detailed — thorough, longer</option>
            </select>
            <p className="-mt-1 ml-0 mt-2 text-xs text-muted-foreground">
              Applies to summaries and chat. Standard lets the model judge the
              length; Detailed asks it to go deeper and write more. You can also
              switch it per summary or chat from the picker beside the model.
            </p>
          </Section>

          {/* Auto-sort into folders — threshold + new-meeting toggle. The
              folder setup, batch run and review queue live in Meetings → To sort. */}
          <Section
            icon={<Sparkles className="h-5 w-5" />}
            title="Auto-sort into folders"
            description="Set up folders and review uncertain meetings in Meetings → To sort."
          >
            <AutoSortSettings onSaved={flashSaved} />
          </Section>

          <WorkspaceCardSection onSaved={flashSaved} />

          {!IS_COMMUNITY && <ReportAiSection />}
            </>
          )}

          {tab === "recording" && (
            <>
          <Section
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Privacy & consent"
            description="Lalela is private by design and never trains on your data."
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={consentOn}
                onChange={(e) => {
                  setConsentOn(e.target.checked);
                  setConsentEnabled(e.target.checked);
                }}
                className="accent-[var(--color-accent)]"
              />
              Show a consent reminder before recording
            </label>
            {!IS_MOBILE && (
              <>
                {/* Auto-detect is the macOS lalela-detect helper — hidden on
                    Windows, where the toggle would do nothing. */}
                {!IS_WINDOWS && (
                <>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={autoDetectOn}
                    onChange={(e) => {
                      setAutoDetectOn(e.target.checked);
                      setAutoDetectEnabled(e.target.checked);
                      setDetectionEnabled(e.target.checked).catch(() => {});
                    }}
                    className="accent-[var(--color-accent)]"
                  />
                  Detect Zoom / Meet / Teams calls and offer to record
                </label>
                <p className="-mt-1 ml-6 text-xs text-muted-foreground">
                  Watches for mic activity alongside a known meeting app. Detection runs locally;
                  nothing is recorded until you choose to.
                </p>
                </>
                )}
                {/* System-audio capture: macOS spawns the Core Audio tap
                    helper, Windows opens a WASAPI loopback stream on the
                    default playback device (src-tauri/system_tap.rs +
                    system_tap_win.rs). Both desktop platforms have it; Linux
                    does not, but we don't ship a Linux build. */}
                {!IS_MOBILE && (
                  <>
                    <label className="mt-4 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={systemAudioOn}
                        onChange={(e) => {
                          setSystemAudioOn(e.target.checked);
                          setSystemAudioEnabled(e.target.checked);
                        }}
                        className="accent-[var(--color-accent)]"
                      />
                      Also capture system audio (other participants)
                    </label>
                    <p className="-mt-1 ml-6 text-xs text-muted-foreground">
                      Records what you hear (remote voices) via a system-audio tap, labeled “Others.”
                      Off by default —{" "}
                      {IS_WINDOWS
                        ? "it records whatever your PC is playing, so mute other apps before a meeting."
                        : "on some Macs the tap can interfere with the microphone."}{" "}
                      Takes effect on your next recording.
                    </p>
                  </>
                )}
              </>
            )}
            <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
              Consent disclosure text
            </label>
            <textarea
              value={consentMsg}
              onChange={(e) => setConsentMsg(e.target.value)}
              onBlur={() => {
                setConsentText(consentMsg);
                flashSaved();
              }}
              rows={3}
              className={inputClass}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Audio retention: discarded after transcription (configurable storage arrives in a
              later phase).
            </p>
            <DataSharingSettings />
            <CloudAiConsentSetting />
            {irisCapable && (
              <>
                <label className="mt-4 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={irisFeedbackOn}
                    onChange={(e) => {
                      setIrisFeedbackOn(e.target.checked);
                      setIrisFeedbackEnabled(e.target.checked);
                    }}
                    className="accent-[var(--color-accent)]"
                  />
                  Send bug reports with a screenshot (Iris feedback)
                </label>
                <p className="-mt-1 ml-6 text-xs text-muted-foreground">
                  Off by default. When on, the in-app feedback widget can attach a screenshot of the
                  app — which may include meeting content — and your message, and send it to Auxo so
                  we can fix issues. Nothing is sent unless you file a report.
                </p>
              </>
            )}
          </Section>

          <Section
            icon={<Mic2 className="h-5 w-5" />}
            title="Transcription"
            description="How Lalela turns audio into text and tells speakers apart."
          >
            {IS_MOBILE ? (
              <div className="space-y-2">
                {(
                  [
                    {
                      id: "local" as const,
                      name: "On-device (private)",
                      desc: "Live transcript while you record. Audio never leaves the phone.",
                    },
                    {
                      id: "cloud" as const,
                      name: "Cloud (better speaker labels)",
                      desc: "Transcript arrives after you stop. Audio is uploaded securely, transcribed by AssemblyAI via our server, and deleted right after. Requires signing in.",
                    },
                  ] satisfies Array<{ id: TranscriptionMode; name: string; desc: string }>
                )
                  // Cloud transcription runs on Auxo's servers: official only.
                  .filter((opt) => !IS_COMMUNITY || opt.id === "local")
                  .map((opt) => (
                  <label
                    key={opt.id}
                    className="flex items-start gap-2 rounded-[var(--radius)] border border-border p-3 text-sm"
                  >
                    <input
                      type="radio"
                      name="transcription-mode"
                      checked={transcription === opt.id}
                      onChange={() => {
                        setTranscription(opt.id);
                        setTranscriptionMode(opt.id);
                        flashSaved();
                      }}
                      className="mt-0.5 accent-[var(--color-accent)]"
                    />
                    <span>
                      <span className="font-medium">{opt.name}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{opt.desc}</span>
                    </span>
                  </label>
                ))}
                {/* On-device engine choice — only relevant to the "local" mode,
                    and only shown once an alternative to Whisper is actually
                    available (e.g. Apple Speech on an eligible iPhone), so the
                    picker is unchanged on ineligible phones. */}
                {transcription === "local" && asrEngines.length > 1 && (
                  <div className="pt-1">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      On-device engine
                    </label>
                    <div className="space-y-2">
                      {asrEngines.map((eng) => (
                        <label
                          key={eng.id}
                          className="flex items-start gap-2 rounded-[var(--radius)] border border-border p-3 text-sm"
                        >
                          <input
                            type="radio"
                            name="asr-engine"
                            checked={asrEngine === eng.id}
                            disabled={!eng.available}
                            onChange={() => {
                              setAsrEngineState(eng.id);
                              setAsrEngine(eng.id);
                              flashSaved();
                            }}
                            className="mt-0.5 accent-[var(--color-accent)]"
                          />
                          <span>
                            <span className="font-medium">{eng.label}</span>
                            {eng.is_default && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Bundled with Lalela; works fully offline.
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  On-device transcription · speaker labels: Me / Others · multi-speaker diarization
                  for in-person meetings.
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Speech engine
                  </label>
                  <div className="space-y-2">
                    {asrEngines.map((eng) => (
                      <label
                        key={eng.id}
                        className="flex items-start gap-2 rounded-[var(--radius)] border border-border p-3 text-sm"
                      >
                        <input
                          type="radio"
                          name="asr-engine"
                          checked={asrEngine === eng.id}
                          disabled={!eng.available}
                          onChange={() => {
                            setAsrEngineState(eng.id);
                            setAsrEngine(eng.id);
                            flashSaved();
                          }}
                          className="mt-0.5 accent-[var(--color-accent)]"
                        />
                        <span>
                          <span className="font-medium">{eng.label}</span>
                          {eng.is_default && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              Bundled with Lalela; works fully offline.
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  {asrEngines.length <= 1 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Alternative engines (e.g. Parakeet for faster transcription) will appear here
                      when installed.
                    </p>
                  )}
                </div>
              </div>
            )}
          </Section>

          <DictionarySection onSaved={flashSaved} />

          {!IS_MOBILE && <DictationSection onSaved={flashSaved} />}

          {!IS_MOBILE && <CopilotSection onSaved={flashSaved} />}

          {!IS_MOBILE && <MeetingPrepSection onSaved={flashSaved} />}

          {!IS_MOBILE && <SpeakersSection onSaved={flashSaved} />}
            </>
          )}

          {tab === "notifications" && <NotificationsSection onSaved={flashSaved} />}

          {tab === "connections" && !IS_MOBILE && (
            <>
              {!IS_COMMUNITY && <CloudSyncSection />}
              {MS_INTEGRATION_AVAILABLE && <MicrosoftSection onSaved={flashSaved} />}
              {!IS_COMMUNITY && <OtherNotetakersSection />}
            </>
          )}

          {tab === "storage" && !IS_MOBILE && (
            <>
              <MenuBarSection />
              <DownloadedModelsSection />
              <Section
                icon={<FolderCog className="h-5 w-5" />}
                title="Folders"
                description="How the Meetings list behaves when you open a folder."
              >
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={folderRecursiveOn}
                    onChange={(e) => {
                      setFolderRecursiveOn(e.target.checked);
                      setFolderRecursiveDefault(e.target.checked);
                      flashSaved();
                    }}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span>
                    When you open a folder, also show meetings from its subfolders
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Off by default — a folder shows only its own meetings. You can still flip any
                      one folder from its header (This folder / Include subfolders); that folder
                      remembers your choice.
                    </span>
                  </span>
                </label>
              </Section>
              <Section
                icon={<FolderCog className="h-5 w-5" />}
                title="Storage"
                description="Every meeting is saved as clean Markdown (summary, transcript, notes) in this folder, organised by project and date. Export to DOCX from any meeting."
              >
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Save folder
                </label>
                <div className="flex items-center gap-2">
                  <input readOnly value={saveFolder} className={`${inputClass} flex-1`} />
                  <Button variant="outline" size="md" onClick={chooseFolder}>
                    Choose…
                  </Button>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
