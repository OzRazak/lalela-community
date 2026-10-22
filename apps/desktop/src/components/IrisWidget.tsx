// components/IrisWidget.tsx
// WS35 — Auxo Iris feedback widget embed for the Lalela desktop webview.
//
// Renders NOTHING and injects NO remote script by default. The widget only
// loads when BOTH gates are open (see lib/settings.ts for the full rationale):
//   1. Build gate — irisBuildConfig() is non-null (VITE_IRIS_ENABLED="true" +
//      VITE_IRIS_KEY compiled in). No keys exist yet, so every current build
//      is an inert no-op. This is the WS35 acceptance bar.
//   2. User gate  — getIrisFeedbackEnabled() (Settings ▸ Privacy, default OFF).
//
// Lalela is a Vite/React app (not Next.js), so there is no <Script> helper:
// we imperatively append a <script> to <head> when both gates open and remove
// it (plus any nodes the widget injected) the moment either closes — so a user
// who turns the toggle off mid-session severs the remote surface immediately.
//
// Embed shape mirrors auxo-iris `components/ScriptSnippet.tsx` / aion
// `components/IrisWidget.tsx`:
//   <script src="<host>/widget.js" data-project-key data-project-url
//           [data-api] async></script>
import { useEffect, useState } from "react";
import { getIrisFeedbackEnabled, IRIS_FEEDBACK_EVENT, irisBuildConfig } from "@/lib/settings";

export function IrisWidget() {
  const [userEnabled, setUserEnabled] = useState(getIrisFeedbackEnabled);

  // Re-read the opt-in whenever the Settings toggle fires its event.
  useEffect(() => {
    const sync = () => setUserEnabled(getIrisFeedbackEnabled());
    window.addEventListener(IRIS_FEEDBACK_EVENT, sync);
    return () => window.removeEventListener(IRIS_FEEDBACK_EVENT, sync);
  }, []);

  useEffect(() => {
    const cfg = irisBuildConfig();
    // Double gate: build must be Iris-capable AND the user must have opted in.
    if (!cfg || !userEnabled) return;

    const script = document.createElement("script");
    script.src = `${cfg.host}/widget.js`;
    script.async = true;
    script.dataset.projectKey = cfg.key;
    script.dataset.projectUrl = cfg.projectUrl;
    if (cfg.api) script.dataset.api = cfg.api;
    script.setAttribute("data-lalela-iris", "1");
    document.head.appendChild(script);

    return () => {
      script.remove();
      // Best-effort teardown of anything the widget mounted into the DOM.
      document.querySelectorAll("[data-iris-widget]").forEach((n) => n.remove());
    };
  }, [userEnabled]);

  return null;
}
