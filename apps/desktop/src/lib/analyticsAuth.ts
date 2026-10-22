// Main-window-only analytics wiring: account identity, the signed_in / plan
// super properties, and sync-health outcomes. Kept out of analytics.ts so the
// dictation overlay window can track events without spinning up Supabase.
import { supabase } from "./supabase";
import { identifyUser, isInternalEmail, setSuperProp, trackEvent, usageAnalyticsActive } from "./analytics";
import { posthogUserId, rotateInstallId, setPosthogUserId } from "./posthog";
import { getSyncOutcome, SYNC_OUTCOME_CHANGED_EVENT } from "./syncStatus";
import { USAGE_DATA_EVENT } from "./settings";

const IDENTIFIED_KEY = "lalela.analytics.identified";

async function applyUser(user: { id: string; email?: string | null } | null): Promise<void> {
  const prev = posthogUserId();
  if (!user) {
    setPosthogUserId(null);
    setSuperProp("signed_in", false);
    setSuperProp("plan", "unknown");
    if (prev) {
      // Signed out on this machine: start a fresh anonymous id so the next
      // account here is never merged into this one.
      rotateInstallId();
      localStorage.removeItem(IDENTIFIED_KEY);
    }
    return;
  }
  setPosthogUserId(user.id);
  setSuperProp("signed_in", true);
  if (!usageAnalyticsActive()) return;
  // Identify once per (install, account) — re-sent if usage is turned back on.
  const marker = `${user.id}`;
  if (localStorage.getItem(IDENTIFIED_KEY) !== marker) {
    identifyUser(user.id, isInternalEmail(user.email));
    localStorage.setItem(IDENTIFIED_KEY, marker);
  }
  try {
    const { data } = await supabase.from("profiles").select("plan").eq("id", user.id).maybeSingle();
    const plan = (data as { plan?: string } | null)?.plan;
    setSuperProp("plan", plan === "pro" || plan === "team" || plan === "free" ? plan : "unknown");
  } catch {
    /* plan is a nice-to-have */
  }
}

let lastSyncClass: string | null = null;
function onSyncOutcome(): void {
  const o = getSyncOutcome();
  if (!o) return;
  const outcome = o.ok
    ? "ok"
    : o.errorClass === "auth"
      ? "denied"
      : o.errorClass === "offline"
        ? "offline"
        : "server";
  // Only transitions (and the first outcome per launch) — sync runs often.
  if (outcome === lastSyncClass) return;
  lastSyncClass = outcome;
  trackEvent("sync_outcome", { outcome });
}

let installed = false;

/** Resolve the current session (so app_opened knows signed_in), then follow
 *  auth changes and sync outcomes. Never throws. */
export async function installAnalyticsAuth(): Promise<void> {
  if (installed) return;
  installed = true;
  window.addEventListener(SYNC_OUTCOME_CHANGED_EVENT, onSyncOutcome);
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
      void applyUser(session?.user ?? null);
    }
  });
  window.addEventListener(USAGE_DATA_EVENT, () => {
    // Turned back on while signed in → identify again on the next event.
    localStorage.removeItem(IDENTIFIED_KEY);
    void supabase.auth.getSession().then(({ data }) => applyUser(data.session?.user ?? null));
  });
  try {
    const { data } = await supabase.auth.getSession();
    await applyUser(data.session?.user ?? null);
  } catch {
    /* offline at launch — events stay anonymous */
  }
}
