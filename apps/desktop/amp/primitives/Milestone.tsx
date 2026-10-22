/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
"use client";
// @auxo/amp-primitives — the typed <Milestone>.
//
// Celebration typed to the estate's five MOMENT_KINDS, on a graded ladder:
//   rung 0  quiet typed check   — a static ink check + the value label
//   rung 1  spring-tick         — the check pops in on a spatial spring
//   rung 2  full yellow burst   — RESERVED for accent:true moments
// Governance baked in:
//   • dial-gated — at dial 0 it renders NOTHING beyond the quiet typed check
//   • burst ONLY when the moment (or an explicit prop) is accent:true
//   • reduced-motion / <SoberZone> collapse every rung to the quiet check
//   • rate-limited — a given milestone id celebrates once per browser, and no
//     two bursts fire within a short cooldown (no confetti cascade)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAmp, type Dial } from "@auxo/amp-react";
import { getMoment, type MomentKind } from "./moments";
import { reportMoment, momentsEnv, type MomentBeneficiary } from "./report";

export type MilestoneRung = 0 | 1 | 2;

export interface MilestoneProps {
  /** Which value kind was created — types the celebration. */
  kind: MomentKind;
  /** Stable id for rate-limiting (defaults to `kind`). Same id celebrates once. */
  id?: string;
  /** Label override. Defaults to the moment's title ("Time saved", …). */
  title?: ReactNode;
  /** Warm one-liner (craft copy, written per app during the Pass). */
  message?: ReactNode;
  /** Force burst-eligibility for a non-accent kind (rare). Defaults to the
   *  moment's own `accent`. Never overrides the dial gate. */
  accent?: boolean;
  /** Override the ambient dial. */
  dial?: Dial;
  /** Rate-limit scope. "id" (default) = once per browser; "always" = every mount. */
  oncePer?: "id" | "always";
  /** Fired once when this milestone first celebrates (rung ≥ 1). */
  onCelebrate?: (kind: MomentKind, rung: MilestoneRung) => void;
  children?: ReactNode;

  // ── Scoreboard reporting (env-gated, opt-out-aware) ──────────────────────
  /**
   * Report this moment to the Atlas scoreboard when it fires. Defaults to true
   * when the NEXT_PUBLIC_MOMENTS_* env is present (a silent no-op otherwise).
   * Suppressed regardless when the app opted out via <AmpProvider moments={false}>.
   * Reporting is decoupled from the visual rung — reduced-motion and dial-0 apps
   * still tally; it fires once per the same rate-limit as the celebration.
   */
  report?: boolean;
  /** Who the value accrued to. Default "internal". */
  beneficiary?: MomentBeneficiary;
  /** Evidence for the scoreboard. `context` falls back to message → title. */
  evidence?: { quote?: string; context?: string; url?: string };
  /** Minutes saved — feeds the 100M-hours metric (time-saved kind). */
  minutesSaved?: number;
  /** Who created the value (name/handle hint). */
  actorHint?: string;
  /** Idempotency key. Defaults to a stable key derived from `id`/`kind`. */
  dedupeKey?: string;
}

/** Minimum gap between full bursts, estate-wide, to prevent a cascade. */
const BURST_COOLDOWN_MS = 4000;
let lastBurstAt = 0;

function alreadyCelebrated(storageKey: string): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}
function markCelebrated(storageKey: string) {
  try {
    window.localStorage.setItem(storageKey, "1");
  } catch {
    /* private mode / SSR — degrade to "always" */
  }
}

/** Resolve the ladder rung from dial + accent + reduced-motion. Pure. */
export function resolveRung(opts: {
  dial: Dial;
  accent: boolean;
  reducedMotion: boolean;
}): MilestoneRung {
  const { dial, accent, reducedMotion } = opts;
  if (dial === 0 || reducedMotion) return 0; // sober / reduced-motion → quiet check only
  if (accent && dial >= 2) return 2; // full burst — accent moments at higher dials
  return 1; // spring-tick
}

export function Milestone({
  kind,
  id,
  title,
  message,
  accent,
  dial,
  oncePer = "id",
  onCelebrate,
  children,
  report,
  beneficiary,
  evidence,
  minutesSaved,
  actorHint,
  dedupeKey,
}: MilestoneProps) {
  const ambient = useAmp();
  const effectiveDial = (dial ?? ambient.dial) as Dial;
  const moment = getMoment(kind);
  const isAccent = accent ?? moment.accent;
  const storageKey = `amp:milestone:${id ?? kind}`;

  // Scoreboard reporting: default ON when the env is present; the app-level
  // opt-out (auxo-design.json `moments: false` → context) always wins.
  const wantsReport = (report ?? momentsEnv() !== null) && ambient.moments !== false;
  const reportedRef = useRef(false);

  // Rung the ladder WOULD play if this is a fresh celebration.
  const targetRung = resolveRung({
    dial: effectiveDial,
    accent: isAccent,
    reducedMotion: ambient.reducedMotion,
  });

  // Suppress the *animated* rung on repeat (rate-limit) — but always keep the
  // quiet typed check. Optimistic first render shows targetRung (SSR-friendly,
  // demo-visible); an effect downgrades it if this id already celebrated or the
  // global burst cooldown is active.
  const [rung, setRung] = useState<MilestoneRung>(targetRung);
  const firedRef = useRef(false);

  useEffect(() => {
    // Fire a scoreboard report exactly once per fresh moment, independent of the
    // visual rung (a reduced-motion or dial-0 moment still tallies). No-ops when
    // reporting is off (env absent / opted out) or already fired this mount.
    const fireReport = () => {
      if (reportedRef.current || !wantsReport) return;
      reportedRef.current = true;
      const asText = (n: ReactNode): string | undefined =>
        typeof n === "string" ? n : typeof n === "number" ? String(n) : undefined;
      const context = evidence?.context ?? asText(message) ?? asText(title) ?? moment.title;
      reportMoment({
        kind,
        beneficiary: beneficiary ?? "internal",
        evidence: { context, quote: evidence?.quote, url: evidence?.url },
        actorHint,
        minutesSaved,
        dedupeKey: dedupeKey ?? `milestone:${id ?? kind}`,
      });
    };

    if (oncePer === "always") {
      if (!firedRef.current && targetRung >= 1) {
        firedRef.current = true;
        onCelebrate?.(kind, targetRung);
        if (targetRung === 2) lastBurstAt = Date.now();
      }
      fireReport(); // once per mount, regardless of rung
      return;
    }
    const seen = alreadyCelebrated(storageKey);
    let playable = targetRung;
    if (seen) {
      playable = 0; // repeat visit — collapse to the quiet check
    } else if (targetRung === 2 && Date.now() - lastBurstAt < BURST_COOLDOWN_MS) {
      playable = 1; // cooldown active — downgrade burst to a spring-tick
    }
    setRung(playable);
    if (!seen) {
      markCelebrated(storageKey);
      if (playable >= 1) {
        firedRef.current = true;
        onCelebrate?.(kind, playable);
        if (playable === 2) lastBurstAt = Date.now();
      }
      fireReport(); // a fresh moment reports once per browser (matches the rate-limit)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, targetRung, oncePer]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-amp-milestone=""
      data-amp-moment={kind}
      data-amp-rung={rung}
      data-amp-accent={isAccent ? "" : undefined}
      className="amp-milestone"
    >
      {rung === 2 && <span aria-hidden="true" data-amp-burst="" className="amp-milestone-burst" />}
      <span aria-hidden="true" className="amp-milestone-check">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10.5l4 4 8-9" />
        </svg>
      </span>
      <span className="amp-milestone-body">
        <span className="amp-milestone-label">{title ?? moment.title}</span>
        {message != null && <span className="amp-milestone-message">{message}</span>}
        {children}
      </span>
    </div>
  );
}
