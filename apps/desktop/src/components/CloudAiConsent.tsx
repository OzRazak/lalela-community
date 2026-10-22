import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { SoberZone } from "@auxo/amp-react";
import { Button } from "@/components/ui/Button";
import { PrivacyPolicyLink } from "@/components/DataSharingSettings";
import {
  CLOUD_AI_CONSENT_EVENT,
  CLOUD_AI_CONSENT_REQUIRED,
  getCloudAiConsent,
  registerCloudAiConsentPrompt,
  setCloudAiConsent,
} from "@/lib/aiConsent";
import { DEVICE_NOUN, IS_IOS, IS_MACOS, IS_MOBILE } from "@/lib/platform";

/** The on-device options this build actually has, named per platform (no
 * "Apple Intelligence" on Windows, no "local model" claim on phones). */
const ON_DEVICE_OPTIONS: string = IS_MOBILE
  ? IS_IOS
    ? "On-device options (Apple Intelligence, where available)"
    : "On-device options, where available,"
  : IS_MACOS
    ? "On-device options (a local model you download in Settings, or Apple Intelligence where available)"
    : "On-device options (a local model you download in Settings)";

/** What leaves the device, and to whom — shared by the dialog and Settings so
 * the two can never disagree. Keep in step with the marketing privacy page and
 * the App Store privacy answers (docs/APP-STORE-RELEASE.md). */
function Disclosure() {
  return (
    <>
      <p>
        Summaries, chat, task extraction, Copilot and automations can run on a{" "}
        <strong>cloud AI model</strong>. When they do, the text they work on (such as your
        transcript, notes, the names in them, your question, your workspace and folder briefs, and
        any screenshot you attach) is
        sent from your {DEVICE_NOUN} to Auxo&apos;s server and on to <strong>OpenRouter</strong>, which
        passes it to the company behind the model you picked (for example Anthropic, OpenAI or
        Google) to generate the answer. With your own OpenRouter key it goes straight to
        OpenRouter. Nothing is sent until you allow it, and automatic steps (like naming a new
        meeting) wait until you&apos;ve answered.
      </p>
      <p>
        Auxo doesn&apos;t sell this content or use it for advertising. {ON_DEVICE_OPTIONS} never
        leave your {DEVICE_NOUN} and don&apos;t need this.
      </p>
    </>
  );
}

/**
 * Mounted once, beside App in main.tsx. Asks — one time — before any meeting content is sent to
 * a third-party AI provider (App Review 5.1.2(i); Mac + Windows since 1.3.11).
 * Only a generation the user just started opens it; background work waits
 * quietly. The AI front door awaits the answer; "Not now" stores a refusal,
 * revocable in Settings.
 */
export function CloudAiConsentHost() {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    if (!CLOUD_AI_CONSENT_REQUIRED) return;
    return registerCloudAiConsentPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        }),
    );
  }, []);

  if (!open) return null;
  const answer = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  return (
    // Consent is a registered sober zone (auxo-design.json): no personality.
    <SoberZone>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-ai-consent-title"
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      >
        <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[var(--radius)] border border-border bg-card shadow-xl">
          <div className="flex items-center gap-3 border-b border-border p-5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 id="cloud-ai-consent-title" className="font-semibold">
                Allow cloud AI?
              </h2>
              <p className="text-xs text-muted-foreground">
                Your meeting text is shared with an AI provider
              </p>
            </div>
          </div>
          <div className="space-y-3 p-5 text-sm text-muted-foreground">
            <Disclosure />
            <p className="text-xs">
              You can change this any time in Settings → Recording → Privacy &amp; consent.{" "}
              <PrivacyPolicyLink />
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border p-4">
            <Button variant="outline" onClick={() => answer(false)}>
              Not now
            </Button>
            <Button onClick={() => answer(true)}>Allow</Button>
          </div>
        </div>
      </div>
    </SoberZone>
  );
}

/** Settings ▸ Recording ▸ Privacy & consent: the revocable switch. Shown on
 * every build that enforces the gate (all native builds since 1.3.11). */
export function CloudAiConsentSetting() {
  const [on, setOn] = useState(getCloudAiConsent() === "granted");
  useEffect(() => {
    const sync = () => setOn(getCloudAiConsent() === "granted");
    window.addEventListener(CLOUD_AI_CONSENT_EVENT, sync);
    return () => window.removeEventListener(CLOUD_AI_CONSENT_EVENT, sync);
  }, []);
  if (!CLOUD_AI_CONSENT_REQUIRED) return null;
  return (
    <div data-tour-id="settings-cloud-ai-consent">
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setCloudAiConsent(e.target.checked);
          }}
          className="accent-[var(--color-accent)]"
        />
        Allow cloud AI (share meeting text with AI providers)
      </label>
      <div className="-mt-1 ml-6 space-y-2 text-xs text-muted-foreground">
        <Disclosure />
        <p>Untick to stop immediately: cloud AI requests are refused until you allow it again.</p>
      </div>
    </div>
  );
}
