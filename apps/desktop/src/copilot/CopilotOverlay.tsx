import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Monitor as MonitorIcon,
  X,
} from "lucide-react";
import { StaticMark } from "@auxo/amp-marks";
import { useGripResize } from "@/lib/useGripResize";
import { aiGenerateStream, NoAiError, type AiStreamHandle } from "@/lib/ai";
import { ReportAiButton } from "@/components/ReportAiContent";
import { isRecording, onRecordingStatus, onTranscriptSegment } from "@/lib/lalela";
import { copilotCaptureScreen, copilotHide, copilotStatus, ScreenPermissionError } from "@/lib/copilot";
import { computeCovered, loadDossierContext, type DossierContext } from "@/lib/copilotDossier";
import {
  COPILOT_SCREEN_DISCLOSURE,
  getCopilotScreenAwareness,
  getCopilotScreenDisclosed,
  getCopilotVisionModel,
  isVisionModel,
  setCopilotScreenAwareness,
  setCopilotScreenDisclosed,
} from "@/lib/settings";

/** How much recent transcript to feed each request (chars). Matches the brief's
 * "last ~4,000 chars" and keeps the copilot prompt lean + fast. */
const CONTEXT_CHARS = 4000;
/** Hard cap on generated tokens — small for snappy 2–3 s live guidance. */
const MAX_TOKENS = 160;

// ── Auto-answer tuning (all binding per the brief) ──────────────────────────
/** Wait this long after the last transcript segment before scanning for a
 * question — lets a question finish being spoken before we answer it. */
const AUTO_DEBOUNCE_MS = 1500;
/** Minimum time between auto-generations (hard rate limit). */
const AUTO_MIN_GAP_MS = 5000;
/** How much of the buffer tail to scan for the latest question. */
const QUESTION_TAIL_CHARS = 1500;
/** Truncate the "Answering: …" caption to this many chars. */
const CAPTION_MAX = 80;

// ── Position + size persistence ─────────────────────────────────────────────
const POS_KEY = "copilot.overlay.pos";
const SIZE_KEY = "copilot.overlay.size";
const POS_SAVE_DEBOUNCE_MS = 400;
const AUTO_KEY = "copilot.autoAnswer";

// ── Dossier fusion (CP3) ────────────────────────────────────────────────────
/** Recompute the "Your plan" coverage checklist at most this often — a trailing
 * throttle over transcript segments, so it's every few seconds, not per segment.
 * Pure client-side text matching; pauses entirely while the panel is hidden. */
const COVERAGE_INTERVAL_MS = 3000;

/** The three one-shot copilot actions. System prompts are tight: ≤5 bullets,
 * second person, no preamble/headings. Sent with `rawSystem: true`. */
const ACTIONS = [
  {
    key: "say",
    label: "What should I say?",
    system:
      'You are a live meeting copilot for the user ("you"). Read the recent transcript and suggest what you could say next to keep the conversation productive and move it forward. Reply with up to 5 short, specific bullet points, written in the second person. No preamble, no headings, no closing remarks — just the bullets.',
  },
  {
    key: "questions",
    label: "Follow-up questions",
    system:
      'You are a live meeting copilot for the user ("you"). From the recent transcript, propose sharp follow-up questions you could ask right now to clarify, dig deeper, or surface risks. Reply with up to 5 short question bullets in the second person. No preamble, no headings.',
  },
  {
    key: "recap",
    label: "Recap",
    system:
      'You are a live meeting copilot for the user ("you"). Give a fast recap so you can re-orient. Reply with up to 5 short bullet points covering the key points, any decisions, and the open questions so far. No preamble, no headings.',
  },
] as const;

/** A dedicated screen-awareness chip (CP4) — only rendered when screen
 * awareness is ON and the resolved model is vision-capable. Always attaches a
 * screenshot. */
const SCREEN_ACTION = {
  key: "screen",
  label: "What's on screen?",
  system:
    'You are a live meeting copilot for the user ("you"). A screenshot of the user\'s current screen is attached. Briefly say what\'s on their screen (e.g. the slide or document) and how it connects to the live discussion, then suggest what you could say or ask about it. Up to 5 short bullets in the second person. No preamble, no headings.',
} as const;

/** Appended to the system prompt whenever a screenshot is attached, so the model
 * treats the frame as supporting evidence while the transcript stays primary. */
const SCREEN_CONTEXT_LINE =
  "A screenshot of the user's current screen is attached as additional context (for example a slide or document they're viewing). Use it to inform your answer, but the live transcript remains the primary source of truth — do not contradict it or over-index on the image.";

type Action = (typeof ACTIONS)[number] | typeof SCREEN_ACTION;

/** System prompt for the "Answer questions" auto mode. */
const AUTO_ANSWER_SYSTEM =
  'You are a live meeting copilot for the user ("you"). The transcript ends with a question. Answer that question for the user as best you can from the conversation context. Be direct and concrete — up to 5 short bullets or a short paragraph, second person. If the context does not contain the answer, say what you would need to answer it.';

/** Leading words that make an utterance question-like even without a "?". */
const QUESTION_WORDS = new Set([
  "what", "how", "why", "when", "who", "where", "which",
  "can", "could", "do", "does", "did", "is", "are", "will", "would", "should",
]);

function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Two questions count as "the same" if one is a prefix of the other — so an
 * evolving/streamed question ("what should we do" → "what should we do now")
 * isn't answered twice. */
function sameQuestion(a: string, b: string): boolean {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/** Find the latest question-like utterance in the transcript tail, or null.
 * Strips "Speaker: " prefixes so a leading question word is detectable, splits
 * into sentences, and scans from the end. */
function extractLatestQuestion(buf: string): string | null {
  const tail = buf.slice(-QUESTION_TAIL_CHARS);
  const text = tail
    .split("\n")
    .map((line) => line.replace(/^[^:\n]{1,40}:\s*/, ""))
    .join(" ");
  const sentences = text.match(/[^.?!]+[.?!]?/g) ?? [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i].trim();
    if (s.length < 4) continue;
    const firstWord = (s.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (s.endsWith("?") || QUESTION_WORDS.has(firstWord)) return s;
  }
  return null;
}

function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    /* ignore */
  }
  return null;
}
function savePos(x: number, y: number) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
  } catch {
    /* ignore */
  }
}
function loadSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { w?: unknown; h?: unknown };
    if (typeof s.w === "number" && typeof s.h === "number" && s.w > 0 && s.h > 0) {
      return { w: s.w, h: s.h };
    }
  } catch {
    /* ignore */
  }
  return null;
}
function saveSize(w: number, h: number) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }));
  } catch {
    /* ignore */
  }
}
function loadAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}
function saveAuto(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Clamp a target position so the window stays on the given monitor (guards
 * against a saved position stranded on a now-disconnected display). */
function clampToMonitor(
  x: number,
  y: number,
  mon: Monitor | null,
  w: number,
  h: number,
): { x: number; y: number } {
  if (!mon) return { x, y };
  const minX = mon.position.x;
  const minY = mon.position.y;
  const maxX = mon.position.x + Math.max(0, mon.size.width - w);
  const maxY = mon.position.y + Math.max(0, mon.size.height - h);
  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
  };
}

/**
 * The Meeting Copilot overlay — a small, translucent, always-on-top panel
 * summoned by the global hotkey during a live recording. It reads the live
 * transcript the recorder emits app-wide (`transcript://segment`) into a rolling
 * ring buffer, and either answers on demand (three chips) or — with the
 * "Answer questions" toggle on — continuously answers the latest question asked.
 *
 * Movable via a native window drag on the top grip (`startDragging()`), with the
 * position persisted to localStorage and clamped on-screen on restore.
 *
 * Resource discipline: transcript + recording listeners run ONLY while enabled;
 * auto-answer does ZERO work while the panel is hidden or the feature is off; a
 * hidden/off overlay costs nothing beyond the cheap ring-buffer append.
 */
export function CopilotOverlay() {
  const [enabled, setEnabled] = useState(true);
  const [recording, setRecording] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoAnswer, setAutoAnswer] = useState(loadAuto);
  const [answeredQuestion, setAnsweredQuestion] = useState<string | null>(null);
  // CP3 dossier fusion: the loaded prep dossier (null = none for this meeting)
  // and the sticky set of covered plan-item ids, plus the collapsible state.
  const [dossier, setDossier] = useState<DossierContext | null>(null);
  const [coveredIds, setCoveredIds] = useState<Set<string>>(() => new Set());
  const [planOpen, setPlanOpen] = useState(true);
  // CP4 screen awareness: opt-in, OFF by default. `visionModel` mirrors the
  // dedicated screen-awareness model chosen in Settings (refreshed on show) so we
  // can tell whether image-bearing calls have somewhere to go; `screenAttached`
  // flags an answer that used a screenshot; `confirmOpen` shows the one-time
  // plain-language disclosure before the first enable.
  const [screenAware, setScreenAware] = useState(getCopilotScreenAwareness);
  const [visionModel, setVisionModelState] = useState(getCopilotVisionModel);
  const [screenAttached, setScreenAttached] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Rolling last-~4k-chars transcript (a ref — appending must never re-render).
  const bufRef = useRef("");
  // The one in-flight generation (single request at a time).
  const handleRef = useRef<AiStreamHandle | null>(null);
  // Guards streamed deltas against a superseded/cancelled run.
  const runIdRef = useRef(0);
  // Live mirrors read from stable callbacks (avoid re-subscribing on change).
  const autoAnswerRef = useRef(autoAnswer);
  const screenAwareRef = useRef(screenAware);
  const visibleRef = useRef(false);
  // Auto-answer bookkeeping.
  const lastAnsweredRef = useRef("");
  const lastAutoGenAtRef = useRef(0);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dossier bookkeeping. `dossierRef` mirrors state for stable callbacks; the
  // load runs exactly once per recording; coverage is a sticky, throttled scan.
  const dossierRef = useRef<DossierContext | null>(null);
  const dossierLoadedRef = useRef(false);
  const dossierLoadingRef = useRef(false);
  const coveredRef = useRef<Set<string>>(new Set());
  const coverageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCoverBufLenRef = useRef(-1);
  // Latest auto-answer check fn (indirection so the debounce timer + scheduler
  // don't create a useCallback dependency cycle).
  const maybeAnswerRef = useRef<() => void>(() => {});

  const cancelInFlight = useCallback(() => {
    runIdRef.current += 1; // invalidate stale deltas
    handleRef.current?.cancel();
    handleRef.current = null;
  }, []);

  const clearAutoTimer = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }, []);

  // ── Dossier: coverage checklist (pure client-side, no AI) ─────────────────
  const clearCoverageTimer = useCallback(() => {
    if (coverageTimerRef.current) {
      clearTimeout(coverageTimerRef.current);
      coverageTimerRef.current = null;
    }
  }, []);

  /** Re-scan the transcript ring buffer for newly-covered plan items. Cheap;
   * no-ops when there's no dossier or no new transcript since the last scan. */
  const recomputeCoverage = useCallback(() => {
    const d = dossierRef.current;
    if (!d || d.items.length === 0) return;
    const buf = bufRef.current;
    if (buf.length === lastCoverBufLenRef.current) return; // nothing new said
    lastCoverBufLenRef.current = buf.length;
    const prev = coveredRef.current;
    const next = computeCovered(d.items, buf, prev);
    if (next !== prev) {
      coveredRef.current = next;
      setCoveredIds(next);
    }
  }, []);

  /** Trailing throttle: arm one recompute per interval; extra segments within
   * the window don't reset it (so continuous speech still latches on time). */
  const scheduleCoverage = useCallback(() => {
    if (coverageTimerRef.current) return;
    coverageTimerRef.current = setTimeout(() => {
      coverageTimerRef.current = null;
      recomputeCoverage();
    }, COVERAGE_INTERVAL_MS);
  }, [recomputeCoverage]);

  /** Drop the dossier + coverage state (meeting ended / copilot disarmed). */
  const resetDossier = useCallback(() => {
    clearCoverageTimer();
    dossierRef.current = null;
    dossierLoadedRef.current = false;
    dossierLoadingRef.current = false;
    coveredRef.current = new Set();
    lastCoverBufLenRef.current = -1;
    setDossier(null);
    setCoveredIds(new Set());
  }, [clearCoverageTimer]);

  /** Load the dossier for the meeting happening now — exactly once per recording
   * (a single time-boxed calendar probe; a null result is remembered so we don't
   * re-probe on every show). Safe to call while hidden: it's one-shot, and the
   * continuous coverage scan is what's gated on visibility. */
  const loadDossier = useCallback(() => {
    if (dossierLoadedRef.current || dossierLoadingRef.current) return;
    dossierLoadingRef.current = true;
    loadDossierContext()
      .then((ctx) => {
        dossierLoadingRef.current = false;
        dossierLoadedRef.current = true;
        if (!ctx) return; // no dossier for this meeting → overlay runs as before
        dossierRef.current = ctx;
        setDossier(ctx);
        lastCoverBufLenRef.current = -1;
        // Seed the checklist from whatever's already been said — but only while
        // visible (zero coverage work while hidden; the show handler re-scans).
        if (visibleRef.current) recomputeCoverage();
      })
      .catch(() => {
        dossierLoadingRef.current = false;
        dossierLoadedRef.current = true;
      });
  }, [recomputeCoverage]);

  const scheduleAutoCheck = useCallback(
    (delay: number) => {
      clearAutoTimer();
      autoTimerRef.current = setTimeout(() => {
        autoTimerRef.current = null;
        maybeAnswerRef.current();
      }, delay);
    },
    [clearAutoTimer],
  );

  /** Start (or restart) a single streaming generation. `kind` labels the busy
   * chip; `question` (auto mode) drives the "Answering: …" caption. When
   * `attachScreen` is true (CP4 — screen awareness ON + a vision model), a single
   * screenshot is captured on demand and sent alongside the transcript. */
  const startGeneration = useCallback(
    (
      system: string,
      kind: string,
      context: string,
      question: string | null,
      attachScreen = false,
    ) => {
      cancelInFlight();
      const myId = runIdRef.current;
      setError(null);
      setAnswer("");
      setBusyKey(kind);
      setAnsweredQuestion(question);
      setScreenAttached(false);

      // Inject the pre-meeting dossier (CP3) ahead of the live transcript when
      // one exists, so every chip + auto-answer accounts for the user's planned
      // talking points, questions, and the meeting's intended purpose. Budget:
      // dossier ≤2k (capped at load) + transcript ≤4k (the ring buffer).
      const transcript = context || "(No transcript has been captured yet.)";
      const prep = dossierRef.current?.context;
      const userText = prep
        ? `PREP CONTEXT (your pre-meeting prep for this meeting — planned talking points, questions and background):\n${prep}\n\nLIVE TRANSCRIPT (what has been said so far):\n${transcript}`
        : transcript;

      // Fire the actual streaming generation, optionally with a screenshot. Kept
      // as a closure so the CP4 capture can run first (and be superseded safely).
      const launch = (imageDataUrl?: string) => {
        if (runIdRef.current !== myId) return; // superseded during capture
        if (imageDataUrl) setScreenAttached(true);
        const sys = imageDataUrl ? `${system}\n\n${SCREEN_CONTEXT_LINE}` : system;
        const handle = aiGenerateStream(
          userText,
          sys,
          (delta) => {
            if (runIdRef.current !== myId) return; // superseded / cancelled
            setAnswer((a) => a + delta);
          },
          // Image-bearing calls (screen awareness) go to the DEDICATED vision
          // model chosen in Settings, overriding the default ONLY when a
          // screenshot is attached; text-only calls keep the default resolution.
          {
            rawSystem: true,
            maxTokens: MAX_TOKENS,
            imageDataUrl,
            // Manual chips are user-started; auto-answer is background. (This
            // window has no consent dialog host, so an unanswered consent fails
            // closed either way and the panel shows how to allow it.)
            interactive: kind !== "auto",
            ...(imageDataUrl ? { model: getCopilotVisionModel() } : {}),
          },
        );
        handleRef.current = handle;

        handle.result
          .then(() => {
            if (runIdRef.current === myId) setBusyKey(null);
          })
          .catch((err: unknown) => {
            if (runIdRef.current !== myId) return; // cancelled / superseded
            if (err instanceof DOMException && err.name === "AbortError") return;
            setBusyKey(null);
            setError(
              err instanceof NoAiError
                ? "Set up AI in Settings to use the Meeting Copilot."
                : err instanceof Error
                  ? err.message
                  : "Something went wrong.",
            );
          });
      };

      if (!attachScreen) {
        launch();
        return;
      }
      // CP4: grab ONE frame on demand, then stream. On a permission gap show the
      // actionable hint (don't silently answer blind); any other capture hiccup
      // falls back to a transcript-only answer.
      copilotCaptureScreen()
        .then((url) => launch(url))
        .catch((err: unknown) => {
          if (runIdRef.current !== myId) return; // superseded during capture
          if (err instanceof ScreenPermissionError) {
            setBusyKey(null);
            setError(
              "Screen awareness needs Screen Recording permission — grant Lalela access in System Settings ▸ Privacy & Security ▸ Screen Recording, then try again.",
            );
            return;
          }
          launch(); // transcript-only fallback
        });
    },
    [cancelInFlight],
  );

  // Whether a manual chip should attach a screenshot right now (CP4): screen
  // awareness ON and a vision-capable screen-awareness model is available. Read
  // fresh each click so a model change in Settings takes effect immediately.
  const shouldAttachScreen = useCallback(
    () => screenAwareRef.current && isVisionModel(getCopilotVisionModel()),
    [],
  );

  // A manual chip: on-demand guidance (clears any auto caption). The three base
  // chips attach the screen when awareness is on + the model can see; the
  // dedicated "What's on screen?" chip always attaches (it's only shown then).
  const run = useCallback(
    (action: Action) =>
      startGeneration(
        action.system,
        action.key,
        bufRef.current.trim(),
        null,
        action.key === SCREEN_ACTION.key ? true : shouldAttachScreen(),
      ),
    [startGeneration, shouldAttachScreen],
  );

  /** Auto mode: answer the latest NEW question, honouring the rate limits. */
  const maybeAnswerLatestQuestion = useCallback(() => {
    // Zero work when off or hidden (state may have changed during the debounce).
    if (!autoAnswerRef.current || !visibleRef.current) return;
    const q = extractLatestQuestion(bufRef.current);
    if (!q) return; // nothing asked yet → stay idle ("Listening for questions…")
    if (sameQuestion(q, lastAnsweredRef.current)) return; // not a new question
    const since = Date.now() - lastAutoGenAtRef.current;
    if (since < AUTO_MIN_GAP_MS) {
      // Rate-limited: defer until the 5 s gap elapses, then re-evaluate (the
      // latest new question at that time wins).
      scheduleAutoCheck(AUTO_MIN_GAP_MS - since);
      return;
    }
    lastAnsweredRef.current = q;
    lastAutoGenAtRef.current = Date.now();
    // Starting the new generation cancels any in-flight one (single request).
    startGeneration(AUTO_ANSWER_SYSTEM, "auto", bufRef.current.trim(), q);
  }, [scheduleAutoCheck, startGeneration]);

  // Keep the debounce indirection pointed at the current closure.
  useEffect(() => {
    maybeAnswerRef.current = maybeAnswerLatestQuestion;
  }, [maybeAnswerLatestQuestion]);

  const toggleAuto = useCallback(() => {
    const next = !autoAnswerRef.current;
    autoAnswerRef.current = next;
    setAutoAnswer(next);
    saveAuto(next);
    if (next) {
      // Turned ON: answer the current latest question right away (if visible).
      lastAnsweredRef.current = "";
      if (visibleRef.current) scheduleAutoCheck(0);
    } else {
      // Turned OFF: stop auto work, back to on-demand mode.
      clearAutoTimer();
      cancelInFlight();
      setBusyKey(null);
      setAnsweredQuestion(null);
    }
  }, [scheduleAutoCheck, clearAutoTimer, cancelInFlight]);

  // ── Screen awareness (CP4): opt-in toggle + first-use disclosure ──────────
  /** Persist + apply the screen-awareness on/off state (shared with Settings). */
  const applyScreenAware = useCallback((next: boolean) => {
    screenAwareRef.current = next;
    setScreenAware(next);
    setCopilotScreenAwareness(next);
  }, []);

  const toggleScreenAware = useCallback(() => {
    const next = !screenAwareRef.current;
    // First time it's switched on, show the plain-language disclosure and wait
    // for an explicit confirm before enabling (this is the only off-device path).
    if (next && !getCopilotScreenDisclosed()) {
      setConfirmOpen(true);
      return;
    }
    applyScreenAware(next);
  }, [applyScreenAware]);

  const confirmScreenAware = useCallback(() => {
    setCopilotScreenDisclosed(true);
    applyScreenAware(true);
    setConfirmOpen(false);
  }, [applyScreenAware]);

  const cancelConfirm = useCallback(() => setConfirmOpen(false), []);

  // ── Native window drag + resize: persist + restore position AND size ───────
  // Restore size FIRST so the position clamp below uses the final window size.
  // Both are clamped to the current monitor (guards a saved geometry stranded on
  // a now-disconnected display).
  const restoreSaved = useCallback(async () => {
    const savedPos = loadPos();
    const savedSize = loadSize();
    if (!savedPos && !savedSize) return;
    try {
      const win = getCurrentWindow();
      const mon = await currentMonitor();
      if (savedSize) {
        const maxW = mon ? mon.size.width : savedSize.w;
        const maxH = mon ? mon.size.height : savedSize.h;
        const w = Math.max(1, Math.min(savedSize.w, maxW));
        const h = Math.max(1, Math.min(savedSize.h, maxH));
        await win.setSize(new PhysicalSize(Math.round(w), Math.round(h)));
      }
      if (savedPos) {
        const size = await win.outerSize();
        const { x, y } = clampToMonitor(savedPos.x, savedPos.y, mon, size.width, size.height);
        await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
      }
    } catch {
      /* best-effort — a failed restore just leaves the window where it is */
    }
  }, []);

  useEffect(() => {
    // Restore once on mount (covers app restart: Rust re-creates the window at
    // its default size top-centre, we nudge it to the user's saved size + spot).
    void restoreSaved();
    const win = getCurrentWindow();
    let unMoved: (() => void) | null = null;
    let unResized: (() => void) | null = null;
    win
      .onMoved(({ payload }) => {
        // Debounced so a drag doesn't hammer localStorage.
        if (posSaveTimerRef.current) clearTimeout(posSaveTimerRef.current);
        const { x, y } = payload;
        posSaveTimerRef.current = setTimeout(() => savePos(x, y), POS_SAVE_DEBOUNCE_MS);
      })
      .then((u) => {
        unMoved = u;
      })
      .catch(() => {});
    win
      .onResized(({ payload }) => {
        // Debounced (native edge-drag + the SE grip both fire this).
        if (sizeSaveTimerRef.current) clearTimeout(sizeSaveTimerRef.current);
        const { width, height } = payload;
        sizeSaveTimerRef.current = setTimeout(() => saveSize(width, height), POS_SAVE_DEBOUNCE_MS);
      })
      .then((u) => {
        unResized = u;
      })
      .catch(() => {});
    return () => {
      if (posSaveTimerRef.current) clearTimeout(posSaveTimerRef.current);
      if (sizeSaveTimerRef.current) clearTimeout(sizeSaveTimerRef.current);
      unMoved?.();
      unResized?.();
    };
  }, [restoreSaved]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    // Native drag — works even when the overlay isn't the key window (unlike a
    // CSS drag region, which fights the non-activating show).
    getCurrentWindow().startDragging().catch(() => {});
  };

  // Corner grip resize, tracked in JS (`startResizeDragging` is a no-op on
  // macOS — see useGripResize). Min mirrors the window's min_inner_size in
  // copilot.rs; the new size is persisted via the onResized listener above.
  const grip = useGripResize({ min: { w: 340, h: 220 } });

  // ── Status + arm/disarm ───────────────────────────────────────────────────
  useEffect(() => {
    copilotStatus()
      .then((s) => {
        setEnabled(s.enabled);
        visibleRef.current = s.visible;
      })
      .catch(() => {});
    isRecording().then(setRecording).catch(() => {});
    const un = listen<boolean>("copilot://enabled", (e) => setEnabled(Boolean(e.payload)));
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, []);

  // Visibility: on show, restore position + (auto) resume answering; on hide,
  // cancel in-flight work AND stop the auto timer → zero work while hidden.
  useEffect(() => {
    const un = listen<boolean>("copilot://visibility", (e) => {
      const vis = Boolean(e.payload);
      visibleRef.current = vis;
      if (vis) {
        void restoreSaved();
        setError(null);
        // Refresh the screen-awareness model + toggle state on show: the Settings
        // window (a separate webview) may have changed either while we were
        // hidden, and storage events aren't guaranteed across webviews.
        setVisionModelState(getCopilotVisionModel());
        const aware = getCopilotScreenAwareness();
        screenAwareRef.current = aware;
        setScreenAware(aware);
        // Ensure the dossier is loaded, and catch the checklist up on anything
        // said while hidden (coverage does zero work while the panel is hidden).
        loadDossier();
        recomputeCoverage();
        if (autoAnswerRef.current) {
          // A question may have been asked while hidden — answer the latest new
          // one. (Same question → no-op, so re-showing doesn't re-spend tokens.)
          scheduleAutoCheck(0);
        } else {
          setAnswer("");
          setAnsweredQuestion(null);
          setBusyKey(null);
        }
      } else {
        cancelInFlight();
        clearAutoTimer();
        clearCoverageTimer(); // zero coverage work while hidden
        setBusyKey(null);
      }
    });
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [
    cancelInFlight,
    clearAutoTimer,
    clearCoverageTimer,
    scheduleAutoCheck,
    restoreSaved,
    loadDossier,
    recomputeCoverage,
  ]);

  // Recording status — only while enabled. Ends → stop in-flight + auto work.
  useEffect(() => {
    if (!enabled) return;
    const un = onRecordingStatus((st) => {
      const live =
        st.state === "recording" || st.state === "preparing" || st.state === "transcribing";
      setRecording(live);
      if (!live) {
        cancelInFlight();
        clearAutoTimer();
        resetDossier(); // meeting over → drop the dossier + coverage
        setBusyKey(null);
      }
    });
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [enabled, cancelInFlight, clearAutoTimer, resetDossier]);

  // Load the dossier once whenever a recording is live (covers both a fresh
  // start and the overlay mounting mid-recording). Guarded to run one probe.
  useEffect(() => {
    if (enabled && recording) loadDossier();
  }, [enabled, recording, loadDossier]);

  // Transcript ring buffer — only while enabled. Cheap append; schedules an
  // auto-answer check only when the toggle is ON and the panel is visible.
  useEffect(() => {
    if (!enabled) {
      bufRef.current = "";
      resetDossier();
      return;
    }
    const un = onTranscriptSegment((s) => {
      const line = s.speaker ? `${s.speaker}: ${s.text}` : s.text;
      let buf = bufRef.current ? `${bufRef.current}\n${line}` : line;
      if (buf.length > CONTEXT_CHARS) buf = buf.slice(buf.length - CONTEXT_CHARS);
      bufRef.current = buf;
      if (autoAnswerRef.current && visibleRef.current) scheduleAutoCheck(AUTO_DEBOUNCE_MS);
      // Keep the "Your plan" checklist current — throttled, and only while the
      // panel is visible (zero coverage work while hidden).
      if (dossierRef.current && visibleRef.current) scheduleCoverage();
    });
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [enabled, scheduleAutoCheck, scheduleCoverage, resetDossier]);

  // Tear down on unmount.
  useEffect(
    () => () => {
      cancelInFlight();
      clearAutoTimer();
      clearCoverageTimer();
      if (posSaveTimerRef.current) clearTimeout(posSaveTimerRef.current);
      if (sizeSaveTimerRef.current) clearTimeout(sizeSaveTimerRef.current);
    },
    [cancelInFlight, clearAutoTimer, clearCoverageTimer],
  );

  const close = () => {
    cancelInFlight();
    copilotHide().catch(() => {});
  };

  const caption =
    answeredQuestion &&
    (answeredQuestion.length > CAPTION_MAX
      ? `${answeredQuestion.slice(0, CAPTION_MAX)}…`
      : answeredQuestion);

  // CP4: is a vision-capable screen-awareness model available? Drives whether the
  // "What's on screen?" chip appears and whether awareness captures or degrades.
  const screenVision = isVisionModel(visionModel);

  // "Your plan" checklist (CP3): only present when a dossier with parsed items
  // exists for the live meeting.
  const planItems = dossier?.items ?? [];
  const coveredCount = planItems.reduce((n, it) => n + (coveredIds.has(it.id) ? 1 : 0), 0);
  const talkingItems = planItems.filter((i) => i.kind === "talking");
  const questionItems = planItems.filter((i) => i.kind === "question");

  const renderPlanItem = (it: (typeof planItems)[number]) => {
    const done = coveredIds.has(it.id);
    return (
      <li key={it.id} className="flex items-start gap-1.5 py-0.5">
        {done ? (
          <CheckCircle2 className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
        ) : (
          <Circle className="mt-[1px] h-3.5 w-3.5 shrink-0 text-white/25" />
        )}
        <span
          className={
            "leading-snug " +
            (done ? "text-white/40 line-through" : "text-white/85")
          }
        >
          {it.text}
        </span>
      </li>
    );
  };

  // Amp-consistent pill styling shared by the action chips (dark sibling look:
  // subtle glass, hover lift, keyboard focus ring).
  const chipBase =
    "rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25";
  const chipActive = "border-white/25 bg-white/15 text-white";
  const chipIdle =
    "border-white/[0.12] bg-white/[0.05] text-white/85 hover:border-white/20 hover:bg-white/10";

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,19,24,0.94)] font-sans text-white shadow-2xl">
      {/* Header — brand mark + drag grip (native window drag on mousedown) */}
      <div
        onMouseDown={startDrag}
        title="Drag to move"
        className="flex cursor-grab select-none items-center gap-2 px-3.5 pb-2 pt-2.5 active:cursor-grabbing"
      >
        {/* The static Lalela/Amp Spark — brand identity cue (no animation loop). */}
        <StaticMark size={16} className="shrink-0 rounded-[5px]" />
        <span
          className={
            "h-2 w-2 shrink-0 rounded-full " +
            (recording ? "animate-pulse bg-[var(--color-danger,#ef4444)]" : "bg-white/30")
          }
        />
        <span className="text-[13px] font-semibold tracking-tight">Meeting Copilot</span>
        <button
          onClick={close}
          onMouseDown={(e) => e.stopPropagation()} // don't start a drag on the ✕
          aria-label="Hide Meeting Copilot"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col px-3.5">
        {!recording ? (
          <div className="flex flex-1 items-center justify-center px-2 py-6 text-center text-[12.5px] leading-snug text-white/55">
            Start a recording to use the Meeting Copilot.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {ACTIONS.map((a) => (
                <button
                  key={a.key}
                  onClick={() => run(a)}
                  className={chipBase + " " + (busyKey === a.key ? chipActive : chipIdle)}
                >
                  {a.label}
                </button>
              ))}
              {/* CP4: dedicated screen chip — only when awareness is on AND a
                  vision model is available (never offered to a blind model). */}
              {screenAware && screenVision && (
                <button
                  key={SCREEN_ACTION.key}
                  onClick={() => run(SCREEN_ACTION)}
                  className={
                    chipBase +
                    " inline-flex items-center gap-1 " +
                    (busyKey === SCREEN_ACTION.key ? chipActive : chipIdle)
                  }
                >
                  <MonitorIcon className="h-3.5 w-3.5" />
                  {SCREEN_ACTION.label}
                </button>
              )}
            </div>

            {/* Auto-answer toggle — a switch, visually distinct from the chips */}
            <button
              role="switch"
              aria-checked={autoAnswer}
              onClick={toggleAuto}
              className="mt-1.5 inline-flex w-fit items-center gap-2 rounded-full py-0.5 text-[11.5px] font-medium text-white/80 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
            >
              <span
                className={
                  "relative inline-flex h-4 w-7 items-center rounded-full transition-colors " +
                  (autoAnswer ? "bg-[var(--color-accent,#6366f1)]" : "bg-white/20")
                }
              >
                <span
                  className={
                    "inline-block h-3 w-3 transform rounded-full bg-white transition-transform " +
                    (autoAnswer ? "translate-x-3.5" : "translate-x-0.5")
                  }
                />
              </span>
              Answer questions
            </button>

            {/* Screen awareness (CP4) — opt-in, off-device. Distinct switch with a
                monitor glyph; first enable shows the disclosure confirmation. */}
            <button
              role="switch"
              aria-checked={screenAware}
              onClick={toggleScreenAware}
              title={COPILOT_SCREEN_DISCLOSURE}
              className="mt-1 inline-flex w-fit items-center gap-2 rounded-full py-0.5 text-[11.5px] font-medium text-white/80 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
            >
              <span
                className={
                  "relative inline-flex h-4 w-7 items-center rounded-full transition-colors " +
                  (screenAware ? "bg-[var(--color-accent,#6366f1)]" : "bg-white/20")
                }
              >
                <span
                  className={
                    "inline-block h-3 w-3 transform rounded-full bg-white transition-transform " +
                    (screenAware ? "translate-x-3.5" : "translate-x-0.5")
                  }
                />
              </span>
              <MonitorIcon className="h-3.5 w-3.5 text-white/60" />
              Screen awareness
            </button>

            {/* Fallback: on, but no vision model is available to attach to. Screen
                awareness picks a dedicated vision model in Settings, so this is
                only reached if the catalog has none. */}
            {screenAware && !screenVision && (
              <div className="mt-1 text-[10.5px] leading-snug text-[var(--color-warning,#f59e0b)]">
                No screen-aware model is available — choose one under Settings ▸ Meeting Copilot.
              </div>
            )}

            <div className="mb-2 mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[12.5px] leading-relaxed text-white/90">
              {error ? (
                <span className="text-[var(--color-warning,#f59e0b)]">{error}</span>
              ) : (
                <>
                  {caption && (
                    <div className="mb-1 text-[11px] italic text-white/50">
                      Answering: “{caption}”
                    </div>
                  )}
                  {screenAttached && (
                    <div className="mb-1 text-[10.5px] font-medium text-white/45">
                      📷 screen attached
                    </div>
                  )}
                  {answer ? (
                    <>
                      {answer}
                      {!busyKey && (
                        <div className="mt-1 flex justify-end whitespace-normal">
                          <ReportAiButton
                            size="xs"
                            surface="copilot"
                            output={answer}
                            className="text-white/50 hover:bg-white/10 hover:text-white"
                          />
                        </div>
                      )}
                    </>
                  ) : busyKey ? (
                    <span className="text-white/45">Thinking…</span>
                  ) : autoAnswer ? (
                    <span className="text-white/40">Listening for questions…</span>
                  ) : (
                    <span className="text-white/40">
                      Pick a prompt for live guidance drawn from the last few minutes.
                    </span>
                  )}
                </>
              )}
            </div>

            {/* "Your plan" — the dossier's talking points + questions, ticked
                off as they're covered live (pure client-side keyword match). */}
            {planItems.length > 0 && (
              <div className="mb-2 shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.03]">
                <button
                  onClick={() => setPlanOpen((o) => !o)}
                  aria-expanded={planOpen}
                  className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-[11.5px] font-medium text-white/80 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
                >
                  {planOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/45" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/45" />
                  )}
                  <span>Your plan</span>
                  <span className="ml-auto tabular-nums text-[10.5px] text-white/45">
                    {coveredCount}/{planItems.length} covered
                  </span>
                </button>
                {planOpen && (
                  <div className="max-h-[34vh] overflow-y-auto px-2.5 pb-2 pt-0.5 text-[11.5px]">
                    {talkingItems.length > 0 && (
                      <>
                        <div className="mb-0.5 mt-1 text-[9.5px] font-semibold uppercase tracking-wide text-white/35">
                          Talking points
                        </div>
                        <ul>{talkingItems.map(renderPlanItem)}</ul>
                      </>
                    )}
                    {questionItems.length > 0 && (
                      <>
                        <div className="mb-0.5 mt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-white/35">
                          Questions to ask
                        </div>
                        <ul>{questionItems.map(renderPlanItem)}</ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-white/[0.06] px-3.5 py-1.5 text-[10.5px] text-white/45">
        Private to you — kept out of most screen shares.
      </div>

      {/* Resize grip (bottom-right) — the resize affordance on the frameless
          panel (pointer-tracked; see useGripResize). */}
      <div
        {...grip}
        title="Drag to resize"
        aria-hidden="true"
        className="absolute bottom-0 right-0 z-[5] flex h-4 w-4 touch-none cursor-nwse-resize items-end justify-end p-[3px] text-white/25 hover:text-white/50"
      >
        <svg
          viewBox="0 0 10 10"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        >
          <path d="M9 3 L3 9 M9 6.5 L6.5 9" />
        </svg>
      </div>

      {/* CP4: first-use screen-awareness disclosure (plain language, off-device). */}
      {confirmOpen && (
        <div className="absolute inset-0 z-10 flex flex-col justify-center gap-3 rounded-2xl bg-[rgba(16,17,22,0.97)] px-4 py-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <MonitorIcon className="h-4 w-4 text-white/70" />
            Turn on screen awareness?
          </div>
          <p className="text-[12px] leading-relaxed text-white/75">{COPILOT_SCREEN_DISCLOSURE}</p>
          <div className="mt-1 flex justify-end gap-2">
            <button
              onClick={cancelConfirm}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
            >
              Cancel
            </button>
            <button
              onClick={confirmScreenAware}
              className="rounded-lg bg-[var(--color-accent,#6366f1)] px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Turn on
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
