import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  startRecording,
  stopRecording,
  stopRecordingWav,
  cloudTranscribe,
  onCloudStatus,
  setPaused,
  captureLive,
  captureScreenshareSample,
  listWindows,
  releaseCaptureStream,
  fileSrc,
  onTranscriptSegment,
  onRecordingStatus,
  onModelProgress,
  onRecordingError,
  onAsrFallback,
  onMicSilence,
  onCaptureSources,
  formatMs,
  speakerColor,
  type Segment,
  type RecordingStatus,
  type CaptureSources,
  type LiveCapture,
  type Meeting,
  type MeetingWindow,
} from "@/lib/lalela";
import {
  Square,
  Circle,
  Loader2,
  AlertTriangle,
  Pause,
  Play,
  Headphones,
  Mic,
  Camera,
  Timer,
  Pencil,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  getAsrEngine,
  getSystemAudioEnabled,
  getTranscriptionMode,
  getVoiceprintsEnabled,
} from "@/lib/settings";
import { isMsConnected } from "@/lib/msauth";
import { currentCalendarEvent, eventAttendees, type GraphEvent } from "@/lib/msgraph";
import {
  IS_MOBILE,
  IS_WINDOWS,
  MIC_SETTINGS_PATH,
  SETTINGS_URI,
  SOUND_SETTINGS_PATH,
  chord,
} from "@/lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import { supabase } from "@/lib/supabase";
import { ChatThread } from "@/components/ChatThread";
import { buildLiveContext, LIVE_CHAT_SYSTEM_PROMPT } from "@/lib/chatContext";
import {
  durationBucket,
  markMeetingCaptured,
  markRecordingStarted,
  takeRecordingDuration,
  trackEvent,
} from "@/lib/analytics";

/** Coarse engine label for analytics — the setting value is never sent raw. */
function engineLabel(engine: string): "whisper" | "apple" | "parakeet" | "other" {
  const e = engine.toLowerCase();
  if (e.includes("apple")) return "apple";
  if (e.includes("parakeet")) return "parakeet";
  if (e.includes("whisper")) return "whisper";
  return "other";
}

/** Open an OS settings pane. Never throws at the user, but if the webview or
 * the opener scope refuses the scheme we log it and tell the caller, so the
 * surface can fall back to naming the path in words instead of doing nothing
 * visible. */
function openSettingsPane(url: string, onFail?: () => void) {
  openUrl(url).catch((e) => {
    console.error(`Could not open the settings pane ${url}:`, e);
    onFail?.();
  });
}

/** The canned "What did I miss?" instruction (Wave A4) — sent when the user taps
 * the quick chip in the live catch-up drawer. */
const CATCHUP_INSTRUCTION =
  "Briefly summarize what was discussed in the last several minutes — decisions, questions, and anything addressed to me.";

/** Screenshare sampler tick, ms: how often the meeting window is probed for
 * a changed slide. Saves happen far less often (change-triggered, ≥10s apart
 * on the backend). */
const AUTO_SAMPLE_MS = 2_500;

/** Crash-safety key for the live notes draft (Wave A2). We autosave the notes
 * pane here every few seconds while it's dirty so an app crash mid-recording
 * doesn't lose typing. We never auto-restore it — a fresh recording clears it,
 * and a successful finish clears it — so it only ever survives a crash DURING
 * the current recording. */
const LIVE_NOTES_DRAFT_KEY = "lalela.liveNotesDraft";
const NOTES_AUTOSAVE_MS = 3_000;

interface RecordingViewProps {
  onFinish: (meeting: Meeting) => void;
  /** Capture mode (Wave B1). "meeting" = the full recorder (mic + optional
   * system audio, slide capture, catch-up). "memo" = a quick voice memo: mic
   * only, no system-audio tap, no slide capture — and on finish the transcript
   * becomes the meeting's note. */
  mode?: "meeting" | "memo";
}

export function RecordingView({ onFinish, mode = "meeting" }: RecordingViewProps) {
  const isMemo = mode === "memo";
  const [segments, setSegments] = useState<Segment[]>([]);
  const [status, setStatus] = useState<RecordingStatus>({ state: "preparing" });
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Non-fatal notice, e.g. the chosen speech engine fell back to Whisper.
  const [notice, setNotice] = useState<string | null>(null);
  // Mic watchdog: true while the input delivers only digital silence.
  const [micSilent, setMicSilent] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [sources, setSources] = useState<CaptureSources | null>(null);
  // True once an "Open … settings" button failed to open anything, so we can
  // show the path in words instead of leaving the click silent.
  const [settingsOpenFailed, setSettingsOpenFailed] = useState(false);
  const [images, setImages] = useState<LiveCapture[]>([]);
  const [capturing, setCapturing] = useState(false);
  // Slide capture target: null = off, "auto" = auto-detect the meeting window,
  // a number = pin a specific window the user picked.
  const [captureTarget, setCaptureTarget] = useState<number | "auto" | null>(null);
  const [captureWindows, setCaptureWindows] = useState<MeetingWindow[]>([]);
  // Cloud mode (Phase 3): capture only, transcript arrives after Stop.
  const [cloudStage, setCloudStage] = useState<string | null>(null);
  const [cloudWavPath, setCloudWavPath] = useState<string | null>(null);
  // Wave A2 — Granola's core move: type YOUR notes while it records. On desktop
  // the notes pane sits beside the live transcript; on mobile a segmented
  // toggle swaps between the two.
  const [notes, setNotes] = useState("");
  const [mobileTab, setMobileTab] = useState<"transcript" | "notes">("transcript");
  // A draft left behind by an interrupted recording, surfaced as an opt-in
  // "restore?" chip. Non-null only when a non-empty draft was found at mount.
  const [recoverableDraft, setRecoverableDraft] = useState<string | null>(null);
  // Wave A4 — Granola's "What did I miss?": a live catch-up chat over the
  // transcript-so-far, toggled by the header button and ⌘J.
  const [catchupOpen, setCatchupOpen] = useState(false);

  const cloudMode = useRef(getTranscriptionMode() === "cloud").current;
  const startedRef = useRef(false);
  const elapsedRef = useRef(0);
  // Latest notes text, read by the finish flow + autosave without re-closing.
  const notesRef = useRef("");
  // Set on every keystroke, cleared after a draft flush — autosave only writes
  // when there's something new to persist.
  const notesDirtyRef = useRef(false);
  // The scrolling transcript container: we pin it to the bottom directly rather
  // than scrollIntoView(), so autoscroll never yanks focus from the notes pane.
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  // Slice 9: the calendar event matched at recording start (Microsoft
  // connected only) — titles the meeting and attaches its attendees on save.
  const calendarEventRef = useRef<GraphEvent | null>(null);
  // Wave A4: latest segments, read by the catch-up chat's getContext at ASK
  // time — so a question always grounds on the CURRENT transcript, never a
  // closure snapshot from when the drawer mounted.
  const segmentsRef = useRef<Segment[]>([]);
  // Wave A4: catch-up exchanges collected during the recording (the drawer's
  // ChatThread is ephemeral, so it hands each completed Q/A here). Replayed into
  // the saved meeting's chat thread on finish — survives the drawer closing.
  const catchupExchangesRef = useRef<{ question: string; answer: string }[]>([]);

  // Keep a ref of elapsed so interval/capture closures read the live value.
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  // Keep a ref of the live segments so the catch-up chat's getContext reads the
  // CURRENT transcript when a question is asked (Wave A4).
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // ⌘J toggles the catch-up drawer (Wave A4). This is a window-level listener,
  // so it fires from anywhere in the recorder EXCEPT while focus is in the notes
  // textarea — that pane calls stopPropagation() on keydown to keep app
  // shortcuts out while you type, so ⌘J won't bubble to window from there. That's
  // expected: the visible "Catch up" button always works, and you're not
  // reaching for a shortcut mid-sentence anyway.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setCatchupOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Subscribe to backend events and start the recording.
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      // StrictMode (dev) double-mounts this component, and each listener is
      // registered via `await onXxx(...)`. The first mount's cleanup runs BEFORE
      // those awaited listen() calls resolve, so without a guard the late
      // listeners are never unlistened — leaving a *second* live segment listener
      // that makes every transcript line appear (and even save) twice in dev.
      // `track` closes that race: if we were already cleaned up by the time a
      // registration resolves, it unlistens immediately and the effect bails.
      const track = (un: () => void): boolean => {
        if (cancelled) {
          un();
          return false;
        }
        unlistens.push(un);
        return true;
      };

      if (
        !track(
          await onTranscriptSegment((s) => {
            setSegments((prev) => [...prev, s]);
            // A segment means transcription is demonstrably working — clear any
            // stale "Recording problem" banner left over from engine start-up
            // (e.g. a first-run model download that briefly tripped an error).
            setError(null);
          }),
        )
      )
        return;
      if (
        !track(
          await onRecordingStatus((s) => {
            setStatus(s);
            if (s.state === "recording") setDownloadPct(null);
          }),
        )
      )
        return;
      if (
        !track(
          await onModelProgress((p) => {
            if (p.total > 0) setDownloadPct(Math.round((p.downloaded / p.total) * 100));
          }),
        )
      )
        return;
      if (!track(await onRecordingError((msg) => setError(msg)))) return;
      if (!track(await onAsrFallback((msg) => setNotice(msg)))) return;
      if (!track(await onMicSilence((silent) => setMicSilent(silent)))) return;
      if (
        !track(
          await onCaptureSources((s) => {
            setSources(s);
            // System audio was switched on but the tap never started. On macOS
            // that's the helper missing or audio-capture permission denied; on
            // Windows there is no permission at all — the loopback tap only
            // fails when there's no playback device to tap. The recording
            // continues mic-only — say so NOW, while it can still be fixed,
            // rather than letting the user discover half a transcript after
            // the meeting.
            if (s.systemRequested && !s.system)
              setNotice(
                "System audio unavailable — recording your microphone only, so the other side of " +
                  "this call won't be transcribed. Fix: " +
                  (IS_WINDOWS
                    ? `no audio output device was found — plug in or switch on your speakers or headset, pick them under ${SOUND_SETTINGS_PATH}, then restart the recording.`
                    : "System Settings → Privacy & Security → Screen & System Audio Recording → " +
                      "allow Lalela, then restart the recording."),
              );
          }),
        )
      )
        return;
      if (!track(await onCloudStatus((s) => setCloudStage(s.stage)))) return;

      if (cancelled) return;
      if (!startedRef.current) {
        startedRef.current = true;
        // Fresh recording — never inherit a problem banner from a prior one.
        setError(null);
        // Slice 9: when a Microsoft account is connected, match the calendar
        // event happening now — subject titles the meeting, attendees are
        // saved with it and join the transcription bias (lowest precedence).
        // Time-boxed so starting a recording never waits on the network.
        // A quick voice memo is a personal dictation, not a calendar meeting —
        // skip the calendar match (no auto-title, no attendees).
        let attendeeNames: string[] = [];
        if (!IS_MOBILE && !isMemo && isMsConnected()) {
          const event = await Promise.race([
            currentCalendarEvent().catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
          ]);
          if (event) {
            calendarEventRef.current = event;
            attendeeNames = eventAttendees(event)
              .map((a) => a.name?.trim())
              .filter((n): n is string => !!n);
          }
        }
        try {
          await startRecording(
            // Memo forces mic-only regardless of the system-audio setting.
            isMemo ? false : getSystemAudioEnabled(),
            !cloudMode,
            getAsrEngine(),
            getVoiceprintsEnabled(),
            attendeeNames,
            isMemo,
          );
          markRecordingStarted();
          trackEvent("recording_started", {
            mode: isMemo ? "memo" : "meeting",
            system_audio: isMemo ? false : getSystemAudioEnabled(),
            transcription: cloudMode ? "cloud" : "local",
            engine: cloudMode ? "cloud" : engineLabel(getAsrEngine()),
          });
        } catch (e) {
          setError(String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
  }, []);

  // Elapsed timer while recording (and not paused).
  useEffect(() => {
    if (status.state !== "recording" || paused) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [status.state, paused]);

  // Auto-scroll transcript. We move the transcript container's own scrollTop
  // (not scrollIntoView on a sentinel) so a new line never scrolls the page or
  // steals focus from the notes editor while the user is typing.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length, images.length]);

  // On mount, offer to recover a draft left by an interrupted recording. We
  // read it into state and surface an opt-in "restore?" chip rather than
  // auto-filling the pane — so a stale draft never silently bleeds into an
  // unrelated meeting. An empty/absent draft leaves the pane like a fresh start.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LIVE_NOTES_DRAFT_KEY);
      if (saved && saved.trim()) setRecoverableDraft(saved);
      else localStorage.removeItem(LIVE_NOTES_DRAFT_KEY);
    } catch {
      /* private-mode / storage disabled — autosave is best-effort */
    }
  }, []);

  // Crash-safety autosave: flush the notes draft to localStorage every few
  // seconds while it's dirty. Cleared on a fresh start and on a clean finish.
  useEffect(() => {
    const id = setInterval(() => {
      if (!notesDirtyRef.current) return;
      notesDirtyRef.current = false;
      try {
        localStorage.setItem(LIVE_NOTES_DRAFT_KEY, notesRef.current);
      } catch {
        /* best-effort */
      }
    }, NOTES_AUTOSAVE_MS);
    return () => clearInterval(id);
  }, []);

  // Slide capture (Slice 4): probe the chosen window every few seconds; the
  // backend saves a WebP frame only when a held slide changed. Only that one
  // window is ever captured — switching to email or another app produces
  // nothing. `captureTarget` is a pinned window id, "auto" (detect the meeting
  // window), or null (off).
  useEffect(() => {
    if (captureTarget === null || status.state !== "recording" || paused) return;
    const windowId = captureTarget === "auto" ? null : captureTarget;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return; // never overlap ticks if a capture runs long
      busy = true;
      try {
        const cap = await captureScreenshareSample(elapsedRef.current * 1000, windowId);
        if (cap) setImages((prev) => [...prev, cap]);
      } catch {
        /* ignore a single failed sample */
      } finally {
        busy = false;
      }
    }, AUTO_SAMPLE_MS);
    return () => {
      clearInterval(id);
      // The backend may hold a live stream on the sampled window (fullscreen
      // Spaces) — release it when capture turns off or the target changes.
      void releaseCaptureStream().catch(() => {});
    };
  }, [captureTarget, status.state, paused]);

  // Load the window list for the picker (once recording, and on each open).
  const refreshWindows = async () => {
    try {
      setCaptureWindows(await listWindows());
    } catch {
      /* window helper not built — picker just shows Off / Auto-detect */
    }
  };
  useEffect(() => {
    if (status.state === "recording") void refreshWindows();
  }, [status.state]);

  const handleCapture = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const cap = await captureLive(elapsedRef.current * 1000, true);
      if (cap) setImages((prev) => [...prev, cap]);
    } catch (e) {
      setError(String(e));
    } finally {
      setCapturing(false);
    }
  };

  // Pull the recovered draft into the live pane. It becomes the current notes
  // (and stays crash-safe from here — marked dirty so autosave keeps it fresh).
  const restoreDraft = () => {
    if (recoverableDraft == null) return;
    setNotes(recoverableDraft);
    notesRef.current = recoverableDraft;
    notesDirtyRef.current = true;
    setRecoverableDraft(null);
  };

  // Decline the recovery: hide the chip and drop the stored draft for good.
  const dismissDraft = () => {
    setRecoverableDraft(null);
    try {
      localStorage.removeItem(LIVE_NOTES_DRAFT_KEY);
    } catch {
      /* best-effort */
    }
  };

  // Analytics: the recording's length, read once at Stop (memo vs meeting).
  const recordedMsRef = useRef(0);

  const finish = (finalSegments: Segment[]) => {
    trackEvent("transcription_completed", {
      engine: cloudMode ? "cloud" : engineLabel(getAsrEngine()) === "apple" ? "apple" : "local",
      source: "recording",
      duration: durationBucket(recordedMsRef.current),
      success: finalSegments.length > 0,
    });
    if (finalSegments.length > 0) markMeetingCaptured("recording");
    // Calendar auto-title (Slice 9): the matched event's subject replaces the
    // "Meeting · <date>" placeholder ONLY — a calendar title also suppresses
    // the AI title suggestion downstream (MeetingDetailView keeps non-default
    // titles). Attendees ride along and are attached on save.
    const calEvent = calendarEventRef.current;
    const calAttendees = calEvent ? eventAttendees(calEvent) : [];
    const dateLabel = new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    // Reaching finish means the notes are now in the save payload — drop the
    // crash-safety draft (read from the ref so async cloud paths see the latest).
    try {
      localStorage.removeItem(LIVE_NOTES_DRAFT_KEY);
    } catch {
      /* best-effort */
    }
    // Voice memo (Wave B1): the transcript IS the note. Flatten the segments
    // (all "Me") into plain prose and make it the meeting's notes — any jots the
    // user typed in the pane go above it. save_meeting seeds this as ONE note
    // entry (the existing NoteEntry path), so notes-derivation, Enhance and sync
    // all work; the entry is authored as the local user (claimed on first push).
    let notesOut = notesRef.current;
    if (isMemo) {
      const spoken = finalSegments
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      notesOut = [notesRef.current.trim(), spoken].filter(Boolean).join("\n\n");
    }
    onFinish({
      title: isMemo
        ? `Voice memo · ${dateLabel}`
        : calEvent?.subject?.trim() || `Meeting · ${dateLabel}`,
      dateISO: new Date().toISOString(),
      segments: finalSegments,
      images: images.map((c) => ({ t_ms: c.t_ms, src_path: c.src_path, caption: "" })),
      notes: notesOut,
      attendees: calAttendees.length > 0 ? calAttendees : null,
      // Wave A4: live catch-up exchanges ride into the save payload — App.tsx
      // replays them into the saved meeting's chat thread (best-effort).
      catchup: catchupExchangesRef.current.length > 0 ? catchupExchangesRef.current : null,
    });
  };

  /** Cloud path: upload the WAV and wait for the server-side transcript.
   * Kept separate from stop so a failed upload/job can be retried. */
  const runCloudTranscription = async (wavPath: string) => {
    setError(null);
    setStopping(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        throw new Error(
          "Cloud transcription needs an account. Sign in under Settings → Account, or switch Settings → Transcription back to on-device.",
        );
      }
      finish(await cloudTranscribe(wavPath, token));
    } catch (e) {
      trackEvent("transcription_completed", {
        engine: "cloud",
        source: "recording",
        duration: durationBucket(recordedMsRef.current),
        success: false,
      });
      setError(String(e));
      setStopping(false);
      setCloudStage(null);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    recordedMsRef.current = takeRecordingDuration() || recordedMsRef.current;
    trackEvent("recording_stopped", {
      mode: isMemo ? "memo" : "meeting",
      duration: durationBucket(recordedMsRef.current),
    });
    if (cloudMode) {
      try {
        const wavPath = await stopRecordingWav();
        setCloudWavPath(wavPath);
        await runCloudTranscription(wavPath);
      } catch (e) {
        // Stopping itself failed (e.g. nothing captured) — save what we have.
        setError(String(e));
        setStopping(false);
      }
      return;
    }
    let finalSegments = segments;
    try {
      // Backend flushes the last window, runs diarization, and returns the
      // final transcript (may take a moment on the first run while models download).
      finalSegments = await stopRecording();
    } catch {
      /* fall back to the live segments */
    }
    finish(finalSegments);
  };

  const togglePause = async () => {
    const next = !paused;
    setPausedState(next);
    try {
      await setPaused(next);
    } catch {
      /* ignore */
    }
  };

  const title = `${isMemo ? "Voice memo" : "New meeting"} · ${new Date().toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  )}`;

  const isLive = status.state === "recording";
  const isPreparing = status.state === "preparing";

  // Interleave transcript lines and captured images by timestamp.
  const timeline = [
    ...segments.map((seg, i) => ({ kind: "seg" as const, t: seg.t0_ms, seg, key: `s${i}` })),
    ...images.map((img, i) => ({ kind: "img" as const, t: img.t_ms, img, key: `i${i}` })),
  ].sort((a, b) => a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "seg" ? -1 : 1));

  // The "notepad that listens": type your own notes while the meeting records.
  // They ride into the saved meeting's notes field, so it opens with them already
  // in the post-meeting "Your notes" box. Shared by both desktop pane + mobile tab.
  const notesPane = (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      {!IS_MOBILE && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
          <Pencil className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Your notes</span>
          <span className="text-xs text-muted-foreground">— saved with this meeting</span>
        </div>
      )}
      {recoverableDraft && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm">
          <RotateCcw className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-muted-foreground">
            Restore notes from your interrupted recording?
          </span>
          <button
            onClick={restoreDraft}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-accent hover:bg-muted"
          >
            Restore
          </button>
          <button
            onClick={dismissDraft}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden p-4">
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            notesRef.current = e.target.value;
            notesDirtyRef.current = true;
            // Typing supersedes the recovery offer — hide it; autosave then
            // overwrites the stale stored draft with this session's notes.
            if (recoverableDraft !== null) setRecoverableDraft(null);
          }}
          // Keep every keystroke inside the editor: stopPropagation prevents the
          // window-level app shortcuts (⌘K palette, Esc handlers) from firing
          // while you type here.
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Jot your own notes while it listens — questions, decisions, follow-ups. Saved alongside the transcript and summary."
          className="h-full w-full resize-none rounded-[var(--radius)] border border-border bg-card p-4 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
    </div>
  );

  const transcriptPane = (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      {!IS_MOBILE && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
          <span className="text-sm font-semibold">Live transcript</span>
        </div>
      )}
      <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        {timeline.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
            <div>
              <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
              <p>
                {cloudMode
                  ? cloudStage === "uploading"
                    ? "Uploading audio…"
                    : cloudStage === "transcribing"
                      ? "Transcribing in the cloud… this can take a minute."
                      : "Recording — with cloud transcription, the transcript arrives after you stop."
                  : isPreparing
                    ? "Getting ready…"
                    : "Listening… your transcript will appear here."}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-3">
            {timeline.map((item) =>
              item.kind === "seg" ? (
                <div key={item.key} className="flex gap-3">
                  <div className="w-14 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground">
                    {formatMs(item.seg.t0_ms)}
                  </div>
                  <div className="flex-1">
                    <span
                      className="mr-2 text-xs font-semibold"
                      style={{ color: speakerColor(item.seg.speaker) }}
                    >
                      {item.seg.speaker}
                    </span>
                    <span className="text-[15px] leading-relaxed">{item.seg.text}</span>
                  </div>
                </div>
              ) : (
                <div key={item.key} className="flex gap-3">
                  <div className="w-14 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground">
                    {formatMs(item.img.t_ms)}
                  </div>
                  <figure className="flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
                    <img
                      src={fileSrc(item.img.src_path)}
                      alt="Screen capture"
                      className="max-h-80 w-full object-contain"
                    />
                    <figcaption className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                      <Camera className="h-3 w-3" />
                      Screen capture
                    </figcaption>
                  </figure>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Wave A4: the live catch-up drawer's contents — a header + an ephemeral
  // ChatThread grounded on the in-progress transcript. Kept mounted (shown/hidden
  // via a class) so the visible Q/A survives ⌘J toggles; collected exchanges also
  // persist independently in catchupExchangesRef for replay on finish.
  const catchupPanel = (
    <>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">Catch up</span>
        </div>
        <button
          onClick={() => setCatchupOpen(false)}
          title={`Close (${chord("J")})`}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatThread
          ephemeral
          compact
          scope="meeting"
          systemPrompt={LIVE_CHAT_SYSTEM_PROMPT}
          getContext={async () => buildLiveContext(segmentsRef.current)}
          placeholder="Ask about the meeting so far…"
          busyLabel="Catching you up…"
          quickActions={[{ label: "What did I miss?", instruction: CATCHUP_INSTRUCTION }]}
          onExchange={(question, answer) =>
            catchupExchangesRef.current.push({ question, answer })
          }
          emptyHint={
            <>
              Ask anything about the conversation so far — or tap "What did I miss?" to recap the
              last few minutes.
            </>
          }
        />
      </div>
    </>
  );

  return (
    // min-w-0 flex-1: this is a flex ITEM of App's row wrapper. Without them it
    // shrank to its content, so a Voice memo (no banner, empty transcript)
    // rendered ~650 px wide with the right of the window blank.
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {isLive && !paused && (
              <>
                <Circle className="h-2.5 w-2.5 animate-pulse fill-danger text-danger" />
                <span className="font-medium text-danger">Recording</span>
                <span>·</span>
              </>
            )}
            {isLive && paused && (
              <>
                <Pause className="h-3.5 w-3.5" />
                <span className="font-medium">Paused</span>
                <span>·</span>
              </>
            )}
            {isPreparing && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>
                  {downloadPct !== null
                    ? `Downloading model… ${downloadPct}%`
                    : status.message ?? "Preparing…"}
                </span>
                <span>·</span>
              </>
            )}
            <span className="font-mono tabular-nums">{formatMs(elapsed * 1000)}</span>
            {sources && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  {sources.system ? (
                    <>
                      <Headphones className="h-3.5 w-3.5" />
                      Mic + system audio
                    </>
                  ) : (
                    <>
                      <Mic className="h-3.5 w-3.5" />
                      Mic only
                    </>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Slide capture is a meeting affordance — hidden for a quick memo. */}
          {isLive && !IS_MOBILE && !IS_WINDOWS && !isMemo && (
            <>
              <Button
                variant="outline"
                onClick={handleCapture}
                disabled={stopping || capturing}
                title="Capture a screen region into the transcript"
              >
                {capturing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
                Capture
              </Button>
              <div
                className={
                  "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm " +
                  (captureTarget !== null ? "border-accent text-foreground" : "border-border text-muted-foreground")
                }
                title="Capture slides from a window: pick a window to track (it keeps capturing that window even as you switch apps), or auto-detect the meeting window. One image is saved per slide change."
              >
                <Timer className="h-4 w-4 shrink-0" />
                <select
                  value={
                    captureTarget === null ? "off" : captureTarget === "auto" ? "auto" : String(captureTarget)
                  }
                  onMouseDown={() => void refreshWindows()}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCaptureTarget(v === "off" ? null : v === "auto" ? "auto" : Number(v));
                  }}
                  disabled={stopping}
                  className="max-w-[13rem] bg-transparent text-foreground outline-none"
                >
                  <option value="off">Slide capture: off</option>
                  <option value="auto">Auto-detect meeting window</option>
                  {[...captureWindows]
                    .sort(
                      (a, b) =>
                        Number(b.meeting) - Number(a.meeting) ||
                        b.width * b.height - a.width * a.height,
                    )
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.app}
                        {/* untitled windows (e.g. Teams meetings) need the size to tell them apart */}
                        {w.title ? ` — ${w.title}` : ` — ${w.width}×${w.height}`}
                      </option>
                    ))}
                  {typeof captureTarget === "number" &&
                    !captureWindows.some((w) => w.id === captureTarget) && (
                      <option value={captureTarget}>Chosen window (no longer listed)</option>
                    )}
                </select>
              </div>
            </>
          )}
          {/* "What did I miss?" is a meeting affordance — hidden for a memo. */}
          {isLive && !isMemo && (
            <Button
              variant="outline"
              onClick={() => setCatchupOpen((v) => !v)}
              disabled={stopping}
              title={`Ask what you missed (${chord("J")})`}
              className={catchupOpen ? "border-accent text-accent" : ""}
            >
              <Sparkles className="h-4 w-4" />
              Catch up
            </Button>
          )}
          {isLive && (
            <Button variant="outline" onClick={togglePause} disabled={stopping}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {paused ? "Resume" : "Pause"}
            </Button>
          )}
          <Button variant="danger" onClick={handleStop} disabled={stopping}>
            {stopping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {stopping
              ? cloudStage === "uploading"
                ? "Uploading…"
                : cloudStage === "transcribing"
                  ? "Transcribing…"
                  : status.state === "diarizing"
                    ? "Separating speakers…"
                    : "Finishing…"
              : "Stop"}
          </Button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/10 px-6 py-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Recording problem</p>
            <p className="text-danger/80">{error}</p>
            <p className="mt-1 text-xs text-danger/70">
              {IS_WINDOWS
                ? `We're not hearing your microphone — check ${MIC_SETTINGS_PATH} and that the right input device is selected, then try again.`
                : `If this is about microphone access, allow Lalela under ${MIC_SETTINGS_PATH}, then try again.`}
            </p>
            {!IS_MOBILE && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    openSettingsPane(SETTINGS_URI.microphone, () => setSettingsOpenFailed(true))
                  }
                >
                  Open microphone settings
                </Button>
                {IS_WINDOWS && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      openSettingsPane(SETTINGS_URI.sound, () => setSettingsOpenFailed(true))
                    }
                  >
                    Open sound settings
                  </Button>
                )}
                {settingsOpenFailed && (
                  <p className="w-full text-xs text-danger/70">
                    We couldn&apos;t open settings for you. Open it yourself: {MIC_SETTINGS_PATH}{" "}
                    for microphone access, {SOUND_SETTINGS_PATH} for the input device.
                  </p>
                )}
              </div>
            )}
            {cloudWavPath && !stopping && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => runCloudTranscription(cloudWavPath)}>
                  Retry transcription
                </Button>
                <Button variant="outline" size="sm" onClick={() => finish([])}>
                  Save without transcript
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {notice && !error && (
        <div className="flex items-start gap-2 border-b border-border bg-primary/10 px-6 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">{notice}</p>
        </div>
      )}

      {/* Amber, not red: silence is usually just a quiet room, not a failure. */}
      {micSilent && !error && (
        <div className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-6 py-3 text-sm text-warning">
          <Mic className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">No sound detected yet</p>
            <p className="text-warning/80">
              Lalela is still recording, but the microphone hasn't picked up any sound for a few
              seconds. It will transcribe as soon as someone speaks.
              {IS_MOBILE
                ? " If someone is speaking, check that another app isn't using the microphone."
                : ` If someone is speaking, check your input device under ${SOUND_SETTINGS_PATH}, and that Lalela is allowed under ${MIC_SETTINGS_PATH}. If it still shows nothing, restarting your device restores the audio system.`}
            </p>
            {!IS_MOBILE && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    openSettingsPane(SETTINGS_URI.sound, () => setSettingsOpenFailed(true))
                  }
                >
                  Open sound settings
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    openSettingsPane(SETTINGS_URI.microphone, () => setSettingsOpenFailed(true))
                  }
                >
                  Open microphone settings
                </Button>
                {settingsOpenFailed && (
                  <p className="w-full text-xs text-danger/70">
                    We couldn&apos;t open settings for you. Open it yourself: {MIC_SETTINGS_PATH}{" "}
                    for microphone access, {SOUND_SETTINGS_PATH} for the input device.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {IS_MOBILE ? (
        <>
          {/* Segmented Transcript / Notes toggle (mobile only). */}
          <div className="border-b border-border px-4 py-2">
            <div className="flex rounded-full bg-muted p-0.5 text-sm font-medium">
              {(["transcript", "notes"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setMobileTab(tab)}
                  className={
                    "flex-1 rounded-full px-3 py-1.5 transition-colors " +
                    (mobileTab === tab
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground")
                  }
                >
                  {tab === "transcript" ? "Transcript" : "Notes"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {mobileTab === "notes" ? notesPane : transcriptPane}
          </div>
        </>
      ) : (
        // Desktop: two-pane split. Notes is the primary writing surface (a
        // notepad that listens), the live transcript reads alongside it. The
        // catch-up drawer opens as a third column next to the transcript, so the
        // notes/transcript split is never disturbed (Wave A4).
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-[1.35] overflow-hidden">{notesPane}</div>
          <div className="flex min-h-0 flex-1 overflow-hidden border-l border-border">
            {transcriptPane}
          </div>
          <aside
            className={
              "flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden border-l border-border bg-surface" +
              (catchupOpen ? "" : " hidden")
            }
          >
            {catchupPanel}
          </aside>
        </div>
      )}

      {/* Mobile: a full-height sheet over the recorder (Wave A4). Kept mounted
          and toggled with `hidden` so the catch-up conversation persists. */}
      {IS_MOBILE && (
        <div
          className={
            "fixed inset-0 z-50 flex flex-col bg-background" + (catchupOpen ? "" : " hidden")
          }
          style={{
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {catchupPanel}
        </div>
      )}

      <footer className="border-t border-border px-6 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground">
        Transcribed locally · audio is discarded after transcription · AI summaries are added when
        you stop.
      </footer>
    </div>
  );
}
