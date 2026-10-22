import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getErrorReportsEnabled,
  getUsageDataEnabled,
  setErrorReportsEnabled,
  setUsageDataEnabled,
} from "@/lib/settings";
import { PRIVACY_POLICY_URL, telemetryCapable } from "@/lib/analytics";

/** Opens the public privacy policy in the system browser. */
export function PrivacyPolicyLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openUrl(PRIVACY_POLICY_URL).catch(() => {})}
      className={className ?? "underline underline-offset-2 hover:text-foreground"}
    >
      Privacy policy
    </button>
  );
}

/**
 * Settings ▸ Recording & privacy: the two data-sharing choices.
 * - "Share anonymous usage data" — ON by default, untick to stop immediately.
 * - "Send anonymous crash & error reports" — OFF by default (opt-in).
 * Hidden only in builds that can never send (dev builds / VITE_POSTHOG_KEY=off).
 */
export function DataSharingSettings() {
  const [usageOn, setUsageOn] = useState(getUsageDataEnabled());
  const [crashOn, setCrashOn] = useState(getErrorReportsEnabled());
  if (!telemetryCapable()) return null;
  return (
    <div data-tour-id="settings-data-sharing">
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={usageOn}
          onChange={(e) => {
            setUsageOn(e.target.checked);
            setUsageDataEnabled(e.target.checked);
          }}
          className="accent-[var(--color-accent)]"
        />
        Share anonymous usage data
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        On by default. Tells Auxo which features get used so we can improve Lalela: things like
        “a recording started”, “a summary was made”, “an import finished”, which screen you opened,
        the app version and your operating system. Durations and counts are rounded into ranges.
        It never includes your recordings, transcripts, notes, summaries, meeting titles, people’s
        names, file names, or anything you type. If you’re signed in it’s tied to your account ID
        (not your email) so we can see the web and desktop apps together. Untick to stop
        immediately.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={crashOn}
          onChange={(e) => {
            setCrashOn(e.target.checked);
            setErrorReportsEnabled(e.target.checked);
          }}
          className="accent-[var(--color-accent)]"
        />
        Send anonymous crash &amp; error reports
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        Off by default. When on, Lalela sends a short report to Auxo when something breaks: the
        error type, a cleaned-up error message and code location, the app version, and your
        operating system and chip type. It never sends recordings, transcripts, notes, meeting
        titles, people&apos;s names, file names or file contents, and it isn&apos;t linked to your
        account. Turn it off any time — sending stops immediately.
      </p>
      <p className="ml-6 mt-2 text-xs text-muted-foreground">
        Both go to PostHog (EU cloud). Read exactly what is and isn&apos;t collected in our{" "}
        <PrivacyPolicyLink />.
      </p>
    </div>
  );
}
