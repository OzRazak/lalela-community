import React from "react";
import ReactDOM from "react-dom/client";

// Auxo typography
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/courier-prime/400.css";

import "./styles/globals.css";
import App from "./App";
import { getOnboarded, migrateLegacyLocalStorage } from "./lib/settings";
import { applyStoredTheme } from "./lib/cosmetics";
import { initErrorReporting } from "./lib/errorReporting";
import { initAnalytics } from "./lib/analytics";
import { installAnalyticsAuth } from "./lib/analyticsAuth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CloudAiConsentHost } from "./components/CloudAiConsent";

// Amp — the Auxo design language. Lalela runs at dial 2 (archetype C, desktop):
// personable but privacy-calm. AmpProvider stamps the dial on the document root
// and honours prefers-reduced-motion; SparkProvider injects the real CSS/SVG
// Spark so every Amp primitive (empty states, welcome, milestone) upgrades from
// the sober stub to the dial-2 mascot with zero per-call-site churn.
import { AmpProvider } from "@auxo/amp-react";
import { SparkProvider } from "@auxo/amp-primitives";
import { Spark } from "@auxo/amp-marks";

// 2026-07 rename: bring Clio-era localStorage across before anything reads it.
migrateLegacyLocalStorage();

// Wave E1: apply the persisted cosmetic theme before first paint (swaps a few
// Amp CSS custom properties on :root) so a chosen look never flashes default.
applyStoredTheme();

// Opt-in, content-free crash & error reports (OFF by default; Settings ▸
// Recording ▸ Privacy & consent). See lib/errorReporting.ts + lib/posthog.ts.
initErrorReporting();

// Anonymous usage data (ON by default, Settings ▸ Privacy to turn off). Named,
// allowlisted events only — see lib/analytics.ts and docs/ANALYTICS.md.
const firstRun = !getOnboarded();
void installAnalyticsAuth().finally(() => initAnalytics({ firstRun }));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AmpProvider dial={2}>
      <SparkProvider component={Spark}>
        <ErrorBoundary>
          <App />
          {/* Third-party AI consent (App Review 5.1.2(i)) — beside App, not in
              it, so it's mounted whichever full-window branch App renders
              (meeting detail, live recording, onboarding, main). */}
          <CloudAiConsentHost />
        </ErrorBoundary>
      </SparkProvider>
    </AmpProvider>
  </React.StrictMode>,
);
