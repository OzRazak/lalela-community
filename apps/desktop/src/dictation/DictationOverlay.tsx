import { trackEvent } from "@/lib/analytics";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StaticMark } from "@auxo/amp-marks";
import { cancelDictation, finishDictation } from "@/lib/dictation";
import { useGripResize } from "@/lib/useGripResize";

type State = "starting" | "preparing" | "listening" | "transcribing";

/**
 * The dictation overlay — the small, always-on-top window that appears on the
 * global hotkey. It only reflects backend state (the Rust `DictationSession`
 * owns the mic + Whisper): it renders the live level + partial transcript and
 * routes Enter → finish, Esc → cancel. Insertion happens in Rust after finish;
 * if the paste can't proceed (no Accessibility, password field, …) the backend
 * sends a `dictation://notice` message which we surface here.
 *
 * The card can be dragged anywhere and resized from its corner grip;
 * Rust saves the spot + size on hide and restores it before the next show.
 */
export function DictationOverlay() {
  const [state, setState] = useState<State>("listening");
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guard so a double Enter / hotkey race doesn't fire finish twice.
  const done = useRef(false);
  // Transcript scroll: follow the newest text unless the user has scrolled up
  // to read; re-follow once they scroll back to the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      listen<string>("dictation://state", (e) => {
        const s = (e.payload as State) ?? "listening";
        setState(s);
        // A fresh session (the window is reused/hidden, not reloaded): re-arm the
        // finish/cancel guard and clear the previous run's UI.
        if (s === "listening" || s === "preparing" || s === "starting") {
          done.current = false;
          stickToBottom.current = true;
          setNotice(null);
          setError(null);
          setPartial("");
        }
      }),
      listen<string>("dictation://partial", (e) => setPartial(e.payload ?? "")),
      listen<number>("dictation://level", (e) => setLevel(e.payload ?? 0)),
      listen<string>("dictation://notice", (e) => setNotice(e.payload ?? null)),
      listen<string>("dictation://error", (e) => setError(e.payload ?? "Something went wrong")),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    trackEvent("feature_used", { feature: "dictation", action: "inserted" });
    finishDictation().catch(() => {});
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    trackEvent("feature_used", { feature: "dictation", action: "cancelled" });
    cancelDictation().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the newest words in view as partials stream in (and on resize).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [partial]);
  useEffect(() => {
    const onResize = () => {
      const el = scrollRef.current;
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  // Drag the card from anywhere except the buttons, the scrollable transcript
  // (so its scrollbar works) and the resize grip.
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    if ((e.target as HTMLElement).closest("button, [data-no-drag]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  // Corner grip resize (tracked in JS — see useGripResize). Bounds mirror
  // OVERLAY_MIN/OVERLAY_MAX in dictation.rs; Rust saves the new size on hide.
  const grip = useGripResize({ min: { w: 320, h: 130 }, max: { w: 1200, h: 900 } });

  const resizeGrip = (
    <div
      data-no-drag
      {...grip}
      title="Drag to resize"
      className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-se-resize touch-none"
    >
      <svg viewBox="0 0 10 10" className="h-full w-full text-white/30" aria-hidden>
        <path d="M9 3L3 9M9 6L6 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </div>
  );

  // A backend notice (couldn't paste) takes over the whole card — the session is
  // already finished, so the listening controls no longer apply.
  if (notice) {
    return (
      <div
        onMouseDown={startDrag}
        className="flex h-screen w-screen select-none flex-col justify-center gap-2 overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,19,24,0.94)] p-3.5 font-sans text-white shadow-2xl"
      >
        <div className="flex items-center gap-2">
          {/* Static Lalela/Amp Spark — sibling brand cue with the Copilot. */}
          <StaticMark size={16} className="shrink-0 rounded-[5px]" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-warning,#f59e0b)]" />
          <span className="text-sm font-semibold tracking-tight">On your clipboard</span>
        </div>
        <p className="text-xs leading-snug text-white/70">{notice}</p>
      </div>
    );
  }

  const listening = state === "listening" || state === "starting" || state === "preparing";
  const statusLabel =
    error != null
      ? "Couldn’t start"
      : state === "transcribing"
        ? "Transcribing…"
        : state === "preparing" || state === "starting"
          ? "Getting ready…"
          : "Listening";

  return (
    <div
      onMouseDown={startDrag}
      className="relative flex h-screen w-screen select-none flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,19,24,0.94)] p-3.5 font-sans text-white shadow-2xl"
    >
      {/* Status row: brand mark + pulsing dot + label + level meter */}
      <div className="flex shrink-0 items-center gap-2.5">
        {/* Static Lalela/Amp Spark — sibling brand cue with the Copilot. */}
        <StaticMark size={16} className="shrink-0 rounded-[5px]" />
        <span
          className={
            "h-2.5 w-2.5 shrink-0 rounded-full " +
            (error != null
              ? "bg-[var(--color-danger,#ef4444)]"
              : listening
                ? "animate-pulse bg-[var(--color-danger,#ef4444)]"
                : "bg-[var(--color-accent,#6366f1)]")
          }
        />
        <span className="text-sm font-semibold tracking-tight">{statusLabel}</span>
        <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[var(--color-accent,#6366f1)] transition-[width] duration-100"
            style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
          />
        </div>
      </div>

      {/* Live partial transcript (or a hint) — fills the card and scrolls, so a
          long dictation is readable in full at any size. */}
      <div
        ref={scrollRef}
        data-no-drag
        onScroll={onTranscriptScroll}
        className="my-1.5 min-h-[2.5rem] flex-1 overflow-y-auto pr-1"
      >
        {error != null ? (
          <p className="text-xs text-[var(--color-danger,#ef4444)]">{error}</p>
        ) : partial ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-snug text-white/90">
            {partial}
          </p>
        ) : (
          <p className="text-sm italic text-white/45">
            {state === "transcribing" ? "Finishing up…" : "Speak now…"}
          </p>
        )}
      </div>

      {/* Controls + hints */}
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-[11px] text-white/45">
          <kbd className="font-mono">⏎</kbd> insert · <kbd className="font-mono">Esc</kbd> cancel
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={cancel}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
          >
            Cancel
          </button>
          <button
            onClick={finish}
            className="rounded-lg bg-[var(--color-accent,#6366f1)] px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Insert
          </button>
        </div>
      </div>
      {resizeGrip}
    </div>
  );
}
