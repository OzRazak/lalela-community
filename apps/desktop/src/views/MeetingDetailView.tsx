import { noAiHint } from "@/lib/edition";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  transcriptToText,
  speakerColor,
  formatMs,
  formatDate,
  getMeeting,
  updateMeeting,
  updateEnhancedNotes,
  deleteMeeting,
  exportMeetingFile,
  type ExportFormat,
  listProjects,
  captureForMeeting,
  removeMeetingImage,
  meetingImageSrc,
  labelMeetingSpeaker,
  listSpeakers,
  getMeetingImportSource,
  listNoteEntries,
  addNoteEntry,
  updateNoteEntry,
  deleteNoteEntry,
  type ImportSource,
  type Speaker,
  type FullMeeting,
  type NoteEntry,
  type Project,
  flattenProjectTree,
} from "@/lib/lalela";
import {
  getPrompts,
  getSelectedPromptId,
  setSelectedPromptId,
  getVoiceprintsEnabled,
  summaryModel,
  setSummaryModel,
  getResponseLength,
  setResponseLength,
  modelPickerLabel,
  type ResponseLength,
} from "@/lib/settings";
import { useModelPicker } from "@/lib/useModels";
import { LengthSelect } from "@/components/LengthSelect";
import { ExportMenu } from "@/components/ExportMenu";
import { autogenModel, generateMeetingTitle } from "@/lib/autogen";
import { updateKnowledgeAfterSummary } from "@/lib/knowledge";
import { getAutogenEnabled } from "@/lib/settings";
import { aiGenerate, NoAiError, preflightCloudAiConsent } from "@/lib/ai";
import { enhanceNotes } from "@/lib/enhanceNotes";
import { startSummaryGen, useSummaryGen } from "@/lib/summaryGen";
import { startBgTask, useBgTask } from "@/lib/bgTask";
import { useAuth } from "@/lib/auth";
import { IS_MOBILE, IS_WINDOWS, chord } from "@/lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  deleteCloudMeeting,
  pushMeeting,
  pushNoteEntries,
  pullNoteEntries,
  myActorName,
  myRoleForMeeting,
  type MeetingRole,
} from "@/lib/sync";
import { ShareDialog } from "@/components/ShareDialog";
import { ShareLinkDialog } from "@/components/ShareLinkDialog";
import { SendToAtlasDialog } from "@/components/SendToAtlasDialog";
import { TagChips } from "@/components/TagChips";
import { PendingApprovals } from "@/components/automations/PendingApprovals";
import { automationsAiModels, evaluateAutomations, meetingFactsFrom } from "@/lib/automations";
import { listAutomations } from "@/lib/tags";
import { AiConsentError } from "@/lib/aiConsent";
import { WorkflowPanel } from "@/components/WorkflowPanel";
import { ChatThread } from "@/components/ChatThread";
import { ActionItemsPanel } from "@/components/ActionItemsPanel";
import { CitedMarkdown } from "@/components/CitedMarkdown";
import { ReportAiButton } from "@/components/ReportAiContent";
import { buildMeetingContext, MEETING_CHAT_SYSTEM_PROMPT } from "@/lib/chatContext";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Mail,
  Loader2,
  Sparkles,
  ArrowLeft,
  AlertTriangle,
  Trash2,
  Users,
  Camera,
  Link2 as LinkIcon,
  X,
  Zap,
  Wand2,
  Pencil,
} from "lucide-react";

/** Compact relative time for note-entry stamps (e.g. "just now", "3m", "2h",
 * "5d"), falling back to an absolute date past a week. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Chronological concatenation of entry texts (blank-line separated) — mirrors
 * the Rust `derive_notes`, so the frontend's `notes` mirror stays exact. */
function deriveNotes(entries: NoteEntry[]): string {
  return entries
    .map((e) => e.text)
    .filter((t) => t.trim())
    .join("\n\n");
}

interface MeetingDetailViewProps {
  meetingId: string;
  /** True when the meeting was just recorded — triggers auto-title/summary. */
  autoGenerate?: boolean;
  /** True when this is a freshly-created blank note (Wave B1) — lands the user
   * in the note composer, focused and scrolled into view, ready to type. */
  focusNotes?: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
  onChanged: () => void;
}

export function MeetingDetailView({
  meetingId,
  autoGenerate = false,
  focusNotes = false,
  onBack,
  onOpenSettings,
  onChanged,
}: MeetingDetailViewProps) {
  const [meeting, setMeeting] = useState<FullMeeting | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");
  // `notes` is now DERIVED from the entry log (A7) — kept here as a mirror so
  // Enhance (A3) and every persist() path keep reading it unchanged.
  const [notes, setNotes] = useState("");
  // Notes LOG (A7): authored, timestamped entries. Their concatenation IS the
  // meeting's notes; adding/editing/deleting re-derives it backend-side.
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [composer, setComposer] = useState("");
  // Blank note (Wave B1): focused + scrolled into view on open (see focusNotes).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [myName, setMyName] = useState("");
  const [summary, setSummary] = useState("");
  // Enhanced notes (A3): AI-polished version of the user's notes, stored
  // separately (the raw notes are never mutated). Detached generation is keyed
  // in the shared bgTask store so it survives leaving/returning to the meeting.
  const [enhancedNotes, setEnhancedNotes] = useState("");
  const [enhanceOfferDismissed, setEnhanceOfferDismissed] = useState(false);
  const enhanceKey = `enhance:${meetingId}`;
  const enhanceGen = useBgTask<string>(enhanceKey);
  const enhancing = enhanceGen.status === "running";
  const [projectId, setProjectId] = useState<string | null>(null);
  // Summary generation lives in a module-level store keyed by meeting id (T4),
  // so it stays running and observable regardless of which view is mounted —
  // the view renders immediately and never blocks on the sidecar on mount.
  const gen = useSummaryGen(meetingId);
  const generating = gen.status === "generating";
  const [error, setError] = useState<string | null>(null);
  const [promptId, setPromptId] = useState(getSelectedPromptId());
  // Summary model: defaults to the user's global default (local included) and
  // is persisted across meetings. `useModelPicker` only falls a missing local
  // model back to Haiku once the on-device check has resolved — it never
  // flashes to Haiku while a present local default is still loading.
  const { model, setModel, models } = useModelPicker(summaryModel);
  const [length, setLength] = useState<ResponseLength>(getResponseLength);
  const [leftTab, setLeftTab] = useState<"summary" | "workflows" | "actions" | "chat">(
    "summary",
  );
  const [copied, setCopied] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showShareLink, setShowShareLink] = useState(false);
  const [showAtlas, setShowAtlas] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [role, setRole] = useState<MeetingRole>(null);
  // Transcript search + citation-seek: refs per rendered line, the key being
  // highlighted after a jump, and the search query/match cursor.
  const segEls = useRef(new Map<string, HTMLDivElement>());
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [tSearch, setTSearch] = useState("");
  const [matchIdx, setMatchIdx] = useState(-1); // -1 = not jumped yet
  // "This is…" speaker assignment (Slice 1): which label is being renamed,
  // the typed name, and the directory for autocomplete.
  const [assignLabel, setAssignLabel] = useState<string | null>(null);
  const [assignName, setAssignName] = useState("");
  const [knownSpeakers, setKnownSpeakers] = useState<Speaker[]>([]);
  // Import provenance (Slice 2): trust badge for externally-sourced meetings.
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  // "Run automations now" one-off (T1): busy flag, a short result note, and a
  // key bumped afterward so TagChips + this meeting's PendingApprovals refetch.
  const [autoRunBusy, setAutoRunBusy] = useState(false);
  const [autoRunNote, setAutoRunNote] = useState<string | null>(null);
  const [autoKey, setAutoKey] = useState(0);

  const { user } = useAuth();
  const readOnly = role === "viewer";
  const prompts = useMemo(() => getPrompts(), []);

  // Run ALL enabled automations against just this meeting (one-off testing).
  // Same engine entry as live/retro runs, so the shared ledger keeps it
  // idempotent and ask-mode sends land in this meeting's approvals card.
  const runAutomationsNow = async () => {
    if (!meeting || autoRunBusy) return;
    setAutoRunBusy(true);
    setAutoRunNote(null);
    try {
      // User-started: ask for cloud-AI consent up front if any enabled
      // automation can use AI (the engine's own calls are background).
      const autos = await listAutomations().catch(() => []);
      const models = await automationsAiModels(autos.filter((a) => a.enabled)).catch(
        () => [] as string[],
      );
      if (models.length) await preflightCloudAiConsent(models).catch(() => false);
      const r = await evaluateAutomations(meetingFactsFrom(meeting));
      const bits: string[] = [];
      if (r.executed) bits.push(`${r.executed} action${r.executed === 1 ? "" : "s"} run`);
      if (r.queued) bits.push(`${r.queued} queued for approval`);
      if (r.failed) bits.push(`${r.failed} failed`);
      setAutoRunNote(
        r.matched
          ? `${r.matched} automation${r.matched === 1 ? "" : "s"} matched` +
              (bits.length ? ` · ${bits.join(" · ")}` : "")
          : "No automations matched this meeting.",
      );
      setAutoKey((k) => k + 1); // refetch tag chips + pending approvals
      onChanged();
    } catch {
      setAutoRunNote("Couldn't run automations.");
    } finally {
      setAutoRunBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, ps] = await Promise.all([getMeeting(meetingId), listProjects()]);
      if (cancelled) return;
      getMeetingImportSource(meetingId)
        .then((src) => !cancelled && setImportSource(src))
        .catch(() => {});
      setMeeting(m);
      setTitle(m.title);
      setNotes(m.notes);
      setSummary(m.summary);
      setEnhancedNotes(m.enhanced_notes ?? "");
      setProjectId(m.project_id);
      setProjects(ps);
      // Notes LOG (A7): show the local entries immediately, then best-effort
      // pull the cloud entries (teammates' attributed additions) and reconcile.
      const local = await listNoteEntries(meetingId);
      if (cancelled) return;
      setEntries(local);
      setNotes(deriveNotes(local));
      if (user) {
        await pullNoteEntries(meetingId);
        if (cancelled) return;
        const merged = await listNoteEntries(meetingId);
        if (cancelled) return;
        setEntries(merged);
        setNotes(deriveNotes(merged));
        setMeeting((prev) => (prev ? { ...prev, notes: deriveNotes(merged) } : prev));
      }
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [meetingId, user]);

  // Blank note (Wave B1): once the meeting has loaded, land the user in the note
  // composer — focused and scrolled into view, ready to type. The composer is on
  // the default "summary" tab, so it's mounted; a short delay lets the layout
  // settle. Read-only (viewer) meetings have no composer, so this no-ops there.
  useEffect(() => {
    if (!focusNotes || !meeting || readOnly) return;
    const t = setTimeout(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [focusNotes, meeting, readOnly]);

  // My display name for authoring entries (profile name, else email). Falls back
  // to "" — the backend keeps a blank name and viewers render "You" for own rows.
  useEffect(() => {
    if (!user) {
      setMyName("");
      return;
    }
    let cancelled = false;
    myActorName(user.id)
      .then((n) => !cancelled && setMyName(n))
      .catch(() => !cancelled && setMyName(user.email ?? ""));
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Resolve my role (viewer = read-only). Local-only meetings stay editable.
  useEffect(() => {
    if (!user) {
      setRole(null);
      return;
    }
    let cancelled = false;
    myRoleForMeeting(user.id, meetingId)
      .then((r) => !cancelled && setRole(r))
      .catch(() => !cancelled && setRole(null));
    return () => {
      cancelled = true;
    };
  }, [user, meetingId]);

  // Adopt a summary that finished generating while this view was elsewhere.
  // The mount effect may have read the meeting BEFORE generation completed, so
  // when the store reports "done" we pull the result in (a no-op if it already
  // matches — React bails on an identical setState). setSummary is stable.
  useEffect(() => {
    if (gen.status === "done" && gen.summary != null) setSummary(gen.summary);
  }, [gen.status, gen.summary]);

  // Same adoption for a detached enhance-notes run (A3): pick up the result if
  // it finished while this view was elsewhere. onSuccess already persisted it.
  useEffect(() => {
    if (enhanceGen.status === "done" && enhanceGen.result != null) {
      setEnhancedNotes(enhanceGen.result);
    }
  }, [enhanceGen.status, enhanceGen.result]);

  // Freshly recorded meeting: auto-suggest a descriptive title (always, when a
  // model is usable) and generate the summary if the Settings toggle is on.
  // Best-effort — any failure just leaves the default title / empty summary.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!autoGenerate || !meeting || autoRanRef.current) return;
    if (meeting.segments.length === 0) return;
    autoRanRef.current = true;
    const m = meeting;
    (async () => {
      // Only the recorder's "Meeting · <date>" placeholder gets an AI title —
      // a calendar-subject title (Slice 9) or user-chosen name is never
      // clobbered.
      const isPlaceholderTitle = /^Meeting · /.test(m.title);
      const newTitle = isPlaceholderTitle ? await generateMeetingTitle(m.segments) : null;
      if (newTitle) setTitle(newTitle);
      if (getAutogenEnabled() && !m.summary) {
        // Detached, best-effort — the "Generating…" indicator on the summary
        // pane reflects it and it survives navigating away/back (T4). No
        // onError: auto-summary stays silent, manual Generate still works.
        const prompt = prompts.find((p) => p.id === promptId) ?? prompts[0];
        void startSummaryGen(m.id, {
          run: () =>
            aiGenerate(transcriptToText(m.segments), prompt.text, autogenModel(), {
              length: getResponseLength(),
            }),
          // Persist the title in the same write so the title we just generated
          // isn't clobbered by the base state.
          onSuccess: (result) =>
            persist({ ...(newTitle ? { title: newTitle } : {}), summary: result }),
        });
      } else if (newTitle) {
        await persist({ title: newTitle });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerate, meeting]);

  const persist = async (
    patch: {
      title?: string;
      notes?: string;
      summary?: string;
      projectId?: string | null;
    } = {},
  ) => {
    if (!meeting) return;
    const next = { title, notes, summary, projectId, ...patch };
    try {
      const updated = await updateMeeting(
        meeting.id,
        next.title,
        next.notes,
        next.summary,
        next.projectId ?? null,
      );
      onChanged();
      if (user) pushMeeting(user.id, updated).catch(() => {});
    } catch (e) {
      setError(String(e));
    }
  };

  const generate = () => {
    if (!meeting) return;
    setError(null);
    const prompt = prompts.find((p) => p.id === promptId) ?? prompts[0];
    setSelectedPromptId(prompt.id);
    const m = meeting;
    const text = transcriptToText(m.segments);
    // Detached generation (T4): started here but owned by the module store, so
    // it keeps running — and stays visible as "Generating…" — even if the user
    // leaves this meeting. The completed summary is adopted on return via the
    // store, and persisted regardless of whether this view is still mounted.
    void startSummaryGen(m.id, {
      // projectId routes the rolling project brief into the prompt (Slice 3);
      // length caps the response (Wave A1).
      run: () => aiGenerate(text, prompt.text, model, { projectId, length, interactive: true }),
      onSuccess: async (result) => {
        await persist({ summary: result });
        // Knowledge layer (Slice 3): recompile the project brief + wiki pages
        // in the background. Fire-and-forget — never blocks or fails the
        // summary the user asked for.
        updateKnowledgeAfterSummary({ ...m, summary: result });
      },
      onError: (e) => setError(e instanceof NoAiError ? "no-key" : e instanceof AiConsentError ? e.message : String(e)),
    });
  };

  // "Enhance my notes" (A3): merge the user's rough notes with the transcript
  // into polished, cited notes — stored in enhanced_notes (the raw notes are
  // never touched). Detached like summaries, so it survives navigation, and it
  // reuses the summary model + length pickers already on the page.
  const runEnhance = () => {
    if (!meeting || !notes.trim() || meeting.segments.length === 0) return;
    setError(null);
    const m = meeting;
    const rough = notes;
    void startBgTask<string>(enhanceKey, {
      run: () => enhanceNotes(rough, m.segments, model, { projectId, length, interactive: true }),
      onSuccess: async (result) => {
        try {
          const updated = await updateEnhancedNotes(m.id, result);
          setEnhancedNotes(result);
          setMeeting(updated);
          onChanged();
          if (user) pushMeeting(user.id, updated).catch(() => {});
        } catch (e) {
          setError(String(e));
        }
      },
      onError: (e) => setError(e instanceof NoAiError ? "no-key" : e instanceof AiConsentError ? e.message : String(e)),
    });
  };

  // "Use as summary": copy the enhanced notes into the summary field via the
  // existing persist() flow, so every share/export/copy path picks them up free.
  const useEnhancedAsSummary = async () => {
    if (!enhancedNotes.trim()) return;
    setSummary(enhancedNotes);
    await persist({ summary: enhancedNotes });
  };

  // ── Notes LOG (A7) ────────────────────────────────────────────────────────
  // Adopt a fresh entry list returned by a mutation command (which already
  // re-derived `notes` + rewrote the files backend-side). Mirror the derived
  // notes into local state so Enhance/persist keep working, then sync to cloud.
  const adoptEntries = (fresh: NoteEntry[]) => {
    setEntries(fresh);
    const derived = deriveNotes(fresh);
    setNotes(derived);
    setMeeting((prev) => (prev ? { ...prev, notes: derived } : prev));
    onChanged();
    if (!user || !meeting) return;
    // Owned meeting: pushMeeting mirrors the derived notes AND rides the entries
    // up (it calls pushNoteEntries). A shared meeting I can edit isn't mine to
    // upsert (owner_id RLS 403s), so push just the entries directly.
    if (!role || role === "owner") {
      pushMeeting(user.id, { ...meeting, notes: derived }).catch(() => {});
    } else {
      pushNoteEntries(user.id, meeting.id).catch(() => {});
    }
  };

  const addEntry = async () => {
    if (!meeting || readOnly) return;
    const text = composer.trim();
    if (!text) return;
    try {
      const fresh = await addNoteEntry(meeting.id, user?.id ?? null, myName, text);
      setComposer("");
      adoptEntries(fresh);
    } catch (e) {
      setError(String(e));
    }
  };

  const startEdit = (e: NoteEntry) => {
    setEditingId(e.id);
    setEditingText(e.text);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const text = editingText.trim();
    if (!text) return;
    try {
      const fresh = await updateNoteEntry(editingId, text);
      setEditingId(null);
      setEditingText("");
      adoptEntries(fresh);
    } catch (e) {
      setError(String(e));
    }
  };

  const removeEntry = async (id: string) => {
    if (!confirm("Delete this note?")) return;
    try {
      const fresh = await deleteNoteEntry(id);
      adoptEntries(fresh);
    } catch (e) {
      setError(String(e));
    }
  };

  // An entry is "mine" (editable/deletable) when I authored it, or it's an
  // authorless local entry (recording-finish / legacy backfill on this device).
  const ownEntry = (e: NoteEntry) => e.author_id === null || e.author_id === user?.id;

  const copySummary = async () => {
    const text = summary || (meeting ? transcriptToText(meeting.segments) : "");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const emailSummary = () => {
    if (!meeting) return;
    const body = encodeURIComponent(
      (summary ? summary + "\n\n---\n" : "") +
        `Transcript:\n${transcriptToText(meeting.segments)}`,
    );
    const url = `mailto:?subject=${encodeURIComponent(title)}&body=${body}`;
    // WKWebView (macOS and iOS alike) silently ignores mailto: navigation —
    // hand it to the system opener, which launches the default mail app.
    openUrl(url).catch((e) => setError(String(e)));
  };

  const handleExport = async (format: ExportFormat) => {
    setError(null);
    setExporting(true);
    try {
      await exportMeetingFile(meetingId, format);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleCapture = async () => {
    if (!meeting || capturing) return;
    setError(null);
    setCapturing(true);
    try {
      // Anchor the capture to the end of the transcript.
      const tMs = meeting.segments.length
        ? meeting.segments[meeting.segments.length - 1].t1_ms
        : 0;
      const updated = await captureForMeeting(meeting.id, tMs, true);
      if (updated) {
        setMeeting(updated);
        onChanged();
        if (user) pushMeeting(user.id, updated).catch(() => {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCapturing(false);
    }
  };

  const handleRemoveImage = async (imageId: string) => {
    if (!meeting) return;
    try {
      const updated = await removeMeetingImage(meeting.id, imageId);
      setMeeting(updated);
      onChanged();
      if (user) pushMeeting(user.id, updated).catch(() => {});
    } catch (e) {
      setError(String(e));
    }
  };

  /** "This is X" (Slice 1): relabel every line of a speaker and — when this
   * meeting recorded their voice — enrol/refresh their voiceprint.
   * `nameOverride` powers the one-click attendee chips (Slice 9). */
  const confirmAssign = async (nameOverride?: string) => {
    const name = (nameOverride ?? assignName).trim();
    if (!meeting || !assignLabel || !name) return;
    try {
      const updated = await labelMeetingSpeaker(meeting.id, assignLabel, name);
      setMeeting(updated);
      setAssignLabel(null);
      onChanged();
      if (user) pushMeeting(user.id, updated).catch(() => {});
    } catch (e) {
      setError(String(e));
      setAssignLabel(null);
    }
  };

  const handleDelete = async () => {
    await deleteMeeting(meetingId);
    // Signed-in: remove the cloud copy too, or the next pull re-imports it and
    // the meeting "comes back" after a restart. Shared (read-only) meetings are
    // someone else's — never delete those from the cloud.
    // Not awaited: local delete already succeeded, so navigate immediately
    // (the cloud delete is queued and best-effort; it never rejects).
    if (user && !readOnly) void deleteCloudMeeting(meetingId);
    onChanged();
    onBack();
  };

  if (!meeting) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const hasContent = meeting.segments.length > 0;

  // Attendee names from the calendar invite (Slice 9), offered as one-click
  // speaker suggestions — minus names already used for a speaker here.
  const usedSpeakerNames = new Set(meeting.segments.map((s) => s.speaker.trim().toLowerCase()));
  const attendeeSuggestions = (meeting.attendees ?? [])
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n && !usedSpeakerNames.has(n.toLowerCase()));

  // Interleave transcript lines and captured images by timestamp.
  const timeline = [
    ...meeting.segments.map((seg, i) => ({
      kind: "seg" as const,
      t: seg.t0_ms,
      seg,
      key: `s${i}`,
    })),
    ...meeting.images.map((img) => ({
      kind: "img" as const,
      t: img.t_ms,
      img,
      key: img.id,
    })),
  ].sort((a, b) => a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "seg" ? -1 : 1));

  const flashLine = (key: string) => {
    const el = segEls.current.get(key);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightKey(key);
    setTimeout(() => setHighlightKey((k) => (k === key ? null : k)), 2000);
  };

  /** Jump to the transcript line covering `ms` (last line at or before it). */
  const seekTranscript = (ms: number) => {
    const segs = timeline.filter((t) => t.kind === "seg");
    if (segs.length === 0) return;
    const target =
      [...segs].reverse().find((s) => s.t <= ms) ?? segs[0];
    flashLine(target.key);
  };

  const searchMatches = tSearch.trim()
    ? timeline.filter(
        (t) =>
          t.kind === "seg" &&
          `${t.seg.speaker} ${t.seg.text}`.toLowerCase().includes(tSearch.trim().toLowerCase()),
      )
    : [];

  const gotoMatch = (idx: number) => {
    if (searchMatches.length === 0) return;
    const next = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setMatchIdx(next);
    flashLine(searchMatches[next].key);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon" onClick={onBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {/* Below xl the title fills the first row beside Back (2.5rem + the
            0.75rem gap) and the actions wrap below; otherwise flex-1 squeezed it
            to one character next to Project / Copy. */}
        <div className="min-w-0 flex-1 basis-[calc(100%-3.25rem)] xl:basis-0">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => persist({})}
            disabled={readOnly}
            className="w-full bg-transparent text-lg font-bold tracking-tight outline-none disabled:opacity-100"
          />
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {formatDate(meeting.created_at)}
            {readOnly && (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
                View only · shared as viewer
              </span>
            )}
            {importSource &&
              (importSource.kind === "audio" ? (
                // Audio imports ran the real transcription pipeline on real
                // audio — trusted, unlike external text (Slice 7).
                <span
                  className="rounded-full bg-success/15 px-2 py-0.5 font-medium text-foreground"
                  title={`Transcribed by Lalela from ${importSource.original_filename} (${importSource.trust_level})`}
                >
                  Imported audio · {importSource.original_filename}
                  {importSource.media_duration_ms != null &&
                    ` · ${Math.round(importSource.media_duration_ms / 60000)} min`}
                </span>
              ) : (
                <span
                  className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-foreground"
                  title={`Imported from ${importSource.original_filename} — externally sourced, not recorded by Lalela (${importSource.trust_level})`}
                >
                  Imported · {importSource.original_filename}
                </span>
              ))}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <TagChips key={autoKey} meetingId={meeting.id} readOnly={readOnly} />
            {!readOnly && (
              <button
                onClick={runAutomationsNow}
                disabled={autoRunBusy}
                title="Run all enabled automations on this meeting"
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
              >
                {autoRunBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Zap className="h-3 w-3" />
                )}
                Run automations
              </button>
            )}
            {autoRunNote && (
              <span className="text-xs text-muted-foreground">{autoRunNote}</span>
            )}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Project
          <select
            value={projectId ?? ""}
            onChange={(e) => {
              const v = e.target.value || null;
              setProjectId(v);
              persist({ projectId: v });
            }}
            disabled={readOnly}
            className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm text-foreground disabled:opacity-60"
            title="File this meeting under a project (projects are also how meetings are shared)"
          >
            <option value="">Unfiled</option>
            {flattenProjectTree(projects).map(({ project: p, depth }) => (
              <option key={p.id} value={p.id}>
                {" ".repeat(depth) + p.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={copySummary}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          Copy
        </Button>
        <Button variant="outline" size="sm" onClick={emailSummary}>
          <Mail className="h-4 w-4" />
          Email
        </Button>
        {/* Screen capture is macOS-only (ScreenCaptureKit helper) — hidden on
            Windows like the recording-view Capture button. */}
        {!readOnly && !IS_MOBILE && !IS_WINDOWS && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCapture}
            disabled={capturing}
            title="Capture a screen region into this meeting"
          >
            {capturing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
            Capture
          </Button>
        )}
        {!IS_MOBILE && <ExportMenu onExport={handleExport} busy={exporting} />}
        {user && !readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              projectId
                ? setShowShare(true)
                : setError("Assign this meeting to a project (top-right) to share it.")
            }
          >
            <Users className="h-4 w-4" />
            Share
          </Button>
        )}
        {user && !readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowShareLink(true)}
            title="Create a private, revocable link to this meeting"
          >
            <LinkIcon className="h-4 w-4" />
            Share link
          </Button>
        )}
        {/* Hidden on iOS/iPadOS: it needs an Atlas account App Review can't have
            (Guideline 2.1 — every visible feature must work for the reviewer). */}
        {user && !readOnly && !IS_MOBILE && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAtlas(true)}
            title="Send this meeting to Atlas for proposed follow-up actions (send again any time)"
          >
            <Sparkles className="h-4 w-4" />
            Send to Atlas
          </Button>
        )}
        {!readOnly && (
          <Button variant="ghost" size="icon" onClick={handleDelete} title="Delete meeting">
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </header>

      {/* Ask-mode automation sends waiting on this meeting (hidden when none). */}
      <div className="px-4 pt-3 sm:px-6 [&:empty]:hidden">
        <PendingApprovals key={autoKey} meetingId={meeting.id} onChanged={onChanged} />
      </div>

      {showShare &&
        projectId &&
        (() => {
          const proj = projects.find((p) => p.id === projectId);
          return proj ? (
            <ShareDialog
              projectId={proj.id}
              projectName={proj.name}
              projectCreatedMs={proj.created_at}
              onClose={() => setShowShare(false)}
            />
          ) : null;
        })()}

      {showAtlas && user && (
        <SendToAtlasDialog meetingId={meeting.id} onClose={() => setShowAtlas(false)} />
      )}

      {showShareLink && user && (
        <ShareLinkDialog
          meeting={meeting}
          uid={user.id}
          onClose={() => setShowShareLink(false)}
        />
      )}

      {assignLabel && meeting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
            <h3 className="font-semibold">
              Who is “{assignLabel}”?
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Renames every “{assignLabel}” line in this meeting.
              {getVoiceprintsEnabled() &&
                " If this meeting recorded their voice, Lalela will recognise them automatically next time."}
            </p>
            <input
              autoFocus
              value={assignName}
              onChange={(e) => setAssignName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAssignLabel(null);
                if (e.key === "Enter" && assignName.trim()) void confirmAssign();
              }}
              list="known-speakers"
              placeholder="Name, e.g. Thandi Mokoena"
              className="mt-3 w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <datalist id="known-speakers">
              {knownSpeakers.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
            {attendeeSuggestions.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  From the calendar invite
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {attendeeSuggestions.map((name) => (
                    <button
                      key={name}
                      onClick={() => void confirmAssign(name)}
                      className="rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-accent hover:text-accent"
                      title={`Rename “${assignLabel}” to ${name}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAssignLabel(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!assignName.trim()} onClick={() => void confirmAssign()}>
                Rename speaker
              </Button>
            </div>
          </div>
        </div>
      )}

      <div
        className={
          IS_MOBILE
            ? "flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
            : // A note with no audio (blank note / voice memo without speech) has
              // no transcript — drop the empty transcript column and let the
              // summary/notes column span the full width (Wave B1).
              timeline.length > 0
              ? "grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1.4fr_1fr]"
              : "grid flex-1 grid-cols-1 overflow-hidden"
        }
      >
        <div
          className={
            IS_MOBILE
              ? leftTab === "chat"
                ? // Chat pins its input; give it a bounded viewport on mobile.
                  "flex h-[70vh] min-h-0 flex-col overflow-hidden"
                : "flex flex-col"
              : leftTab === "chat"
                ? // Chat manages its own scroll and pins the input to the bottom.
                  "flex min-h-0 flex-col overflow-hidden border-r border-border"
                : "flex flex-col overflow-y-auto border-r border-border"
          }
        >
          {/* Mobile gets Summary | Chat; desktop adds Workflows + Action items. */}
          <div className="flex gap-1 border-b border-border bg-surface px-5 pt-2">
            {(IS_MOBILE
              ? (["summary", "chat"] as const)
              : (["summary", "workflows", "actions", "chat"] as const)
            ).map((tab) => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab)}
                className={
                  leftTab === tab
                    ? "rounded-t-[var(--radius)] border border-b-0 border-border bg-card px-3 py-1.5 text-sm font-semibold"
                    : "px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                }
              >
                {tab === "summary"
                  ? "Summary"
                  : tab === "workflows"
                    ? "Workflows"
                    : tab === "actions"
                      ? "Action items"
                      : "Chat"}
              </button>
            ))}
          </div>

          {leftTab === "chat" ? (
            <ChatThread
              key={meeting.id}
              scope="meeting"
              scopeId={meeting.id}
              meeting={meeting}
              buildContext={() => buildMeetingContext(meeting)}
              systemPrompt={MEETING_CHAT_SYSTEM_PROMPT}
              placeholder="Ask about this meeting…"
              busyLabel="Reading this meeting…"
              onSeek={seekTranscript}
              emptyHint={
                <>
                  Ask anything about this meeting — "What were the decisions?", "Draft a
                  follow-up email", "What did I promise to do?"
                </>
              }
              onOpenSettings={onOpenSettings}
            />
          ) : !IS_MOBILE && leftTab === "workflows" ? (
            <WorkflowPanel meeting={meeting} />
          ) : !IS_MOBILE && leftTab === "actions" ? (
            <ActionItemsPanel meeting={meeting} onOpenSettings={onOpenSettings} />
          ) : (
            <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3">
            <select
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            >
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSummaryModel(e.target.value); // remembered across meetings
              }}
              className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
              title="AI model"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelPickerLabel(m)}
                </option>
              ))}
            </select>
            <LengthSelect
              value={length}
              onChange={(v) => {
                setLength(v);
                setResponseLength(v); // remembered across meetings
              }}
            />
            <Button
              size="sm"
              onClick={generate}
              disabled={generating || !hasContent || readOnly}
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {generating ? "Generating…" : summary ? "Regenerate" : "Generate summary"}
            </Button>
          </div>

          <div className="px-5 py-4">
            {error === "no-key" ? (
              <div className="flex items-start gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div>
                  <p className="font-medium">
                    {noAiHint(
                      "To generate: sign in for free monthly AI, add your own key, or download a local model",
                    )}
                  </p>
                  <button
                    onClick={onOpenSettings}
                    className="mt-1 font-medium text-accent hover:underline"
                  >
                    Open Settings →
                  </button>
                </div>
              </div>
            ) : error ? (
              <div className="rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                {error}
              </div>
            ) : generating ? (
              // Detached generation in flight — leaving and returning keeps it
              // running and lands right back on this indicator (T4). Shows
              // streamed tokens if the sidecar ever exposes them (`gen.partial`).
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p>
                  Generating summary… you can leave this meeting and come back — it
                  keeps running.
                </p>
                {gen.partial && (
                  <div className="md mt-2 w-full text-left">
                    <CitedMarkdown onSeek={seekTranscript}>{gen.partial}</CitedMarkdown>
                  </div>
                )}
              </div>
            ) : summary ? (
              <>
                <div className="md">
                  <CitedMarkdown onSeek={seekTranscript}>{summary}</CitedMarkdown>
                </div>
                <div className="mt-3 flex justify-end">
                  <ReportAiButton surface="summary" output={summary} model={model} />
                </div>
              </>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Sparkles className="mx-auto mb-2 h-5 w-5" />
                Pick a prompt and click <span className="font-medium">Generate summary</span>.
              </div>
            )}
          </div>

          {/* Notes LOG (A7): a log of authored, timestamped entries. Anyone who
              can see the meeting adds; only the author edits/deletes their own.
              Their concatenation is the meeting's `notes` (Enhance reads it). */}
          <div className="border-t border-border px-5 py-4">
            <h3 className="mb-2 text-sm font-semibold">Notes</h3>

            {entries.length > 0 && (
              <div className="space-y-2">
                {entries.map((e) => {
                  const mine = ownEntry(e);
                  const editing = editingId === e.id;
                  return (
                    <div
                      key={e.id}
                      className="rounded-[var(--radius)] border border-border bg-card p-3"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {mine ? "You" : e.author_name || "Teammate"}
                          </span>
                          <span aria-hidden>·</span>
                          <span>{relTime(e.updated_at)}</span>
                        </div>
                        {mine && !readOnly && !editing && (
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => startEdit(e)}
                              title="Edit"
                              className="rounded p-1 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => removeEntry(e.id)}
                              title="Delete"
                              className="rounded p-1 text-muted-foreground hover:text-danger"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {editing ? (
                        <div>
                          <textarea
                            value={editingText}
                            onChange={(ev) => setEditingText(ev.target.value)}
                            autoFocus
                            className="min-h-20 w-full resize-y rounded-[var(--radius)] border border-border bg-surface p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          />
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <Button size="sm" onClick={saveEdit} disabled={!editingText.trim()}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingId(null);
                                setEditingText("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="whitespace-pre-wrap text-sm">{e.text}</p>
                          {/* Copilot prep dossiers are AI-written notes. */}
                          {e.text.includes("Auto-prepared by Lalela Meeting Copilot") && (
                            <div className="mt-1 flex justify-end">
                              <ReportAiButton size="xs" surface="dossier" output={e.text} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {readOnly ? (
              entries.length === 0 && (
                <p className="text-sm text-muted-foreground">No notes.</p>
              )
            ) : (
              <div className={entries.length > 0 ? "mt-2" : ""}>
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void addEntry();
                    }
                  }}
                  placeholder={
                    entries.length > 0
                      ? "Add a note…"
                      : "Jot anything here — saved alongside the transcript and summary."
                  }
                  className="min-h-20 w-full resize-y rounded-[var(--radius)] border border-border bg-card p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{IS_MOBILE ? "" : `${chord("↵")} to add`}</span>
                  <Button size="sm" onClick={addEntry} disabled={!composer.trim()}>
                    Add note
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Enhanced notes (A3): your rough notes merged with the transcript
              into polished, cited notes. Your own lines render black; AI
              additions are greyed and carry a [m:ss] citation. */}
          <div className="border-t border-border px-5 py-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Enhanced notes</h3>
              {!readOnly && (enhancedNotes || notes.trim()) && (
                <div className="flex items-center gap-1.5">
                  {enhancedNotes && !enhancing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={useEnhancedAsSummary}
                      title="Replace the summary with these enhanced notes"
                    >
                      Use as summary
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={runEnhance}
                    disabled={enhancing || !notes.trim() || !hasContent}
                    title={
                      !notes.trim()
                        ? "Type some notes first"
                        : !hasContent
                          ? "Needs a transcript to cite"
                          : "Merge your notes with the transcript"
                    }
                  >
                    {enhancing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4" />
                    )}
                    {enhancing ? "Enhancing…" : enhancedNotes ? "Re-enhance" : "Enhance"}
                  </Button>
                </div>
              )}
            </div>

            {enhancing ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p>Enhancing your notes… you can leave this meeting and come back — it keeps running.</p>
              </div>
            ) : enhancedNotes ? (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  Your own lines are shown exactly as you wrote them; greyed, cited text is drawn
                  from the transcript — click a timestamp to jump there.
                </p>
                <div className="md rounded-[var(--radius)] border border-border bg-card p-3">
                  <CitedMarkdown onSeek={seekTranscript} aiMuted>
                    {enhancedNotes}
                  </CitedMarkdown>
                </div>
                <div className="mt-2 flex justify-end">
                  <ReportAiButton surface="enhanced_notes" output={enhancedNotes} model={model} />
                </div>
              </>
            ) : !readOnly && notes.trim() && hasContent && !enhanceOfferDismissed ? (
              // Quiet auto-offer — an affordance, not a modal.
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-dashed border-border bg-surface px-3 py-2.5 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Wand2 className="h-4 w-4 shrink-0 text-accent" />
                  Enhance these notes with the transcript?
                </span>
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={runEnhance}>
                    Enhance
                  </Button>
                  <button
                    onClick={() => setEnhanceOfferDismissed(true)}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    title="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {readOnly
                  ? "No enhanced notes."
                  : "Turn your rough notes into polished, cited notes — merged with the transcript."}
              </p>
            )}
          </div>
            </>
          )}
        </div>

        {/* Transcript column — omitted entirely for a note with no audio, so a
            blank note / silent memo reads clean instead of "No transcript". */}
        {timeline.length > 0 && (
        <div className={IS_MOBILE ? "flex flex-col" : "flex flex-col overflow-hidden"}>
          <div className="flex items-center gap-2 border-b border-t border-border bg-surface px-5 py-2.5 lg:border-t-0">
            <span className="text-sm font-semibold">Transcript</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              <input
                value={tSearch}
                onChange={(e) => {
                  setTSearch(e.target.value);
                  setMatchIdx(-1);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    gotoMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1);
                  }
                }}
                placeholder="Search transcript…"
                className="h-7 w-44 rounded-[var(--radius)] border border-border bg-card px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              {tSearch.trim() && (
                <>
                  <span className="w-12 text-center text-[11px] text-muted-foreground">
                    {searchMatches.length
                      ? `${Math.max(matchIdx + 1, 0)}/${searchMatches.length}`
                      : "0/0"}
                  </span>
                  <button
                    onClick={() => gotoMatch(matchIdx - 1)}
                    disabled={!searchMatches.length}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Previous match"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => gotoMatch(matchIdx + 1)}
                    disabled={!searchMatches.length}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    title="Next match"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className={IS_MOBILE ? "px-5 py-4" : "flex-1 overflow-y-auto px-5 py-4"}>
            {timeline.length > 0 ? (
              <div className="space-y-2.5">
                {timeline.map((item) =>
                  item.kind === "seg" ? (
                    <div
                      key={item.key}
                      ref={(el) => {
                        if (el) segEls.current.set(item.key, el);
                        else segEls.current.delete(item.key);
                      }}
                      className={
                        "flex gap-2.5 rounded-[var(--radius)] text-sm transition-colors " +
                        (highlightKey === item.key
                          ? "bg-accent/15 ring-1 ring-accent"
                          : tSearch.trim() &&
                              `${item.seg.speaker} ${item.seg.text}`
                                .toLowerCase()
                                .includes(tSearch.trim().toLowerCase())
                            ? "bg-warning/10"
                            : "")
                      }
                    >
                      <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground">
                        {formatMs(item.seg.t0_ms)}
                      </span>
                      <span>
                        <button
                          className="mr-1.5 rounded text-xs font-semibold hover:underline disabled:no-underline"
                          style={{ color: speakerColor(item.seg.speaker) }}
                          disabled={readOnly}
                          title="Rename this speaker (This is…)"
                          onClick={() => {
                            setAssignLabel(item.seg.speaker);
                            setAssignName(/^Speaker \d+$/.test(item.seg.speaker) ? "" : item.seg.speaker);
                            listSpeakers().then(setKnownSpeakers).catch(() => {});
                          }}
                        >
                          {item.seg.speaker}
                        </button>
                        {item.seg.text}
                      </span>
                    </div>
                  ) : (
                    <div key={item.key} className="flex gap-2.5 text-sm">
                      <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground">
                        {formatMs(item.img.t_ms)}
                      </span>
                      <figure className="group relative flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
                        <img
                          src={meetingImageSrc(meeting.dir_path, item.img.rel_path)}
                          alt={item.img.caption || "Screen capture"}
                          className="max-h-72 w-full object-contain"
                        />
                        {!readOnly && (
                          <button
                            onClick={() => handleRemoveImage(item.img.id)}
                            title="Remove image"
                            className="absolute right-1.5 top-1.5 rounded-full bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <figcaption className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                          <Camera className="h-3 w-3" />
                          {item.img.caption || "Screen capture"}
                        </figcaption>
                      </figure>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No transcript was captured.</p>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
