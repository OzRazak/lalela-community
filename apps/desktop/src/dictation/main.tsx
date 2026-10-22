import React from "react";
import ReactDOM from "react-dom/client";

// Auxo typography (kept minimal — the overlay is one small card).
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";

// Reuse the app's tokens (colors, radius, Tailwind) so the overlay is
// Amp-consistent (dial 2) without pulling in the whole App shell.
import "../styles/globals.css";
import { AmpProvider } from "@auxo/amp-react";

import { DictationOverlay } from "./DictationOverlay";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AmpProvider dial={2}>
      <DictationOverlay />
    </AmpProvider>
  </React.StrictMode>,
);
