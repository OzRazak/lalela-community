import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/Logo";
import { Mic, Headphones, Camera, ShieldCheck, ArrowRight } from "lucide-react";
import { DEVICE_NOUN, IS_MOBILE, IS_WINDOWS, MIC_SETTINGS_PATH } from "@/lib/platform";
import { getUsageDataEnabled, setUsageDataEnabled } from "@/lib/settings";
import { telemetryCapable, trackEvent } from "@/lib/analytics";
import { PrivacyPolicyLink } from "@/components/DataSharingSettings";
import { IS_COMMUNITY } from "@/lib/edition";

interface OnboardingViewProps {
  onDone: () => void;
}

// Privacy deep-links per platform (best-effort; ignored if the scheme is
// blocked). macOS uses the System Settings URL scheme; Windows uses the
// ms-settings: URIs, both opened through the Tauri opener.
const PRIVACY = {
  mic: IS_WINDOWS
    ? "ms-settings:privacy-microphone"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  // macOS-only feature (screen capture is not compiled on Windows), so this
  // link is only ever rendered on macOS.
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** Best-effort; if the webview or the opener scope refuses the scheme we log it
 * and tell the caller, so the card can name the path in words rather than
 * leaving the click silent. */
function openPane(url: string, onFail?: () => void) {
  openUrl(url).catch((e) => {
    console.error(`Could not open the settings pane ${url}:`, e);
    onFail?.();
  });
}

export function OnboardingView({ onDone }: OnboardingViewProps) {
  const [settingsOpenFailed, setSettingsOpenFailed] = useState(false);
  const [usageOn, setUsageOn] = useState(getUsageDataEnabled());
  useEffect(() => trackEvent("onboarding_started"), []);
  const finish = () => {
    trackEvent("onboarding_completed");
    onDone();
  };
  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-y-auto bg-background pb-6 pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1.5rem,env(safe-area-inset-top))] text-foreground">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-10 w-auto" />
          <h1 className="text-2xl font-bold tracking-tight">Welcome to Lalela</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your private, on-device meeting notetaker. A couple of things before your first
            recording.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-card p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div className="text-sm">
              <p className="font-semibold">Private by design</p>
              <p className="text-muted-foreground">
                Recording and transcription happen{" "}
                <span className="font-medium text-foreground">
                  locally on your {DEVICE_NOUN}
                </span>
                . Audio is discarded after transcription.{" "}
                {IS_MOBILE
                  ? "AI summaries run on-device or, only if you allow it, through a cloud AI model — we never train on your data."
                  : "AI summaries run on a local model on your " +
                    DEVICE_NOUN +
                    (IS_COMMUNITY
                      ? " or with your own API key. Lalela asks before anything goes to a cloud AI model."
                      : ", on the free monthly cloud allowance when you sign in, or with your own API key. Lalela asks before anything goes to a cloud AI model, and we never train on your data.")}
              </p>
            </div>
          </div>

          <div className="rounded-[var(--radius)] border border-border bg-card p-4">
            <p className="mb-3 text-sm font-semibold">
              {IS_MOBILE || IS_WINDOWS
                ? "The one permission Lalela asks for"
                : "Permissions Lalela may ask for"}
            </p>
            <div className="space-y-3 text-sm">
              <PermissionRow
                icon={<Mic className="h-4 w-4" />}
                title="Microphone"
                desc={
                  IS_MOBILE
                    ? `To capture the meeting. Requested the first time you record; place your ${DEVICE_NOUN} where it can hear everyone.`
                    : "To capture your voice. Requested the first time you record."
                }
                action={
                  IS_MOBILE ? undefined : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        trackEvent("onboarding_step", { step: "mic_settings" });
                        openPane(PRIVACY.mic, () => setSettingsOpenFailed(true));
                      }}
                    >
                      Open settings
                    </Button>
                  )
                }
              />
              {!IS_MOBILE && !IS_WINDOWS && (
                <>
                  <PermissionRow
                    icon={<Headphones className="h-4 w-4" />}
                    title="System audio"
                    desc="To hear the other side of a call (no meeting bot). Optional — mic-only still works."
                  />
                  <PermissionRow
                    icon={<Camera className="h-4 w-4" />}
                    title="Screen recording"
                    desc="Only if you capture a screen region into the transcript, or use auto screen-capture."
                    action={
                      <Button variant="outline" size="sm" onClick={() => {
                        trackEvent("onboarding_step", { step: "screen_settings" });
                        openPane(PRIVACY.screen, () => setSettingsOpenFailed(true));
                      }}>
                        Open settings
                      </Button>
                    }
                  />
                </>
              )}
            </div>
          </div>

          {settingsOpenFailed && (
            <p className="px-1 text-xs text-danger">
              We couldn&apos;t open settings for you. Open it yourself: {MIC_SETTINGS_PATH}.
            </p>
          )}

          <p className="px-1 text-xs text-muted-foreground">
            {IS_MOBILE
              ? "You can change this anytime in Settings → Apps → Lalela."
              : IS_WINDOWS
                ? "You can grant this anytime in Settings → Privacy & security → Microphone. Lalela keeps working with whatever you allow."
                : "You can grant these anytime in System Settings → Privacy & Security. Lalela keeps working with whatever you allow."}
          </p>
        </div>

        {telemetryCapable() && (
          <div className="mt-4 px-1 text-xs text-muted-foreground">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={usageOn}
                onChange={(e) => {
                  // Unticking takes effect at once — not even the choice is sent.
                  setUsageOn(e.target.checked);
                  setUsageDataEnabled(e.target.checked);
                }}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>
                Share anonymous usage data (which features get used — never your meetings) to help
                improve Lalela. You can change this anytime in Settings → Recording.{" "}
                <PrivacyPolicyLink />
              </span>
            </label>
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button onClick={finish}>
            Get started
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermissionRow({
  icon,
  title,
  desc,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 rounded-full bg-muted p-1.5 text-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      {action}
    </div>
  );
}
