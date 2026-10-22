/* Amp kit · tokens · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
/* ===========================================================================
   Amp tokens — Tailwind v3 bridge (preset).
   For the React-18 / Tailwind-v3 era apps (auxo-focus, okestudio, couples-
   capital). Same canonical values as the v4 @theme, derived from tokens.json
   so the two eras never drift. Use in tailwind.config.js:
       module.exports = { presets: [require('./amp/tailwind-amp-preset.cjs')] }
   This preset only registers Tailwind *utility classes*. The Amp component CSS
   also reads `--color-*` / `--radius-*` custom properties (emitted for free by
   the v4 @theme) — so a v3 app must ALSO provide that variable layer:
       @import "amp/tokens.css";   (the v3-era equivalent of @theme output)
       @import "amp/motion.css";   (the 6 motion tokens + reduced-motion)
   Both are imported in your global stylesheet. (An app with its own themed
   token layer may instead map `--color-*` onto its variables — see the README.)
   =========================================================================== */
const tokens = require("./tokens.json");

const c = tokens.color;

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        background: c.background,
        foreground: c.foreground,
        muted: { DEFAULT: c.muted, foreground: c["muted-foreground"] },
        border: c.border,
        card: c.card,
        surface: c.surface,
        primary: { DEFAULT: c.primary, foreground: c["primary-foreground"] },
        accent: { DEFAULT: c.accent, foreground: c["accent-foreground"] },
        danger: c.danger,
      },
      borderRadius: {
        DEFAULT: tokens.radius.DEFAULT,
        card: tokens.radius.card,
        panel: tokens.radius.panel,
      },
      fontFamily: {
        sans: tokens.font.sans.split(",").map((s) => s.trim()),
      },
      transitionTimingFunction: {
        "amp-spatial": tokens.motion["spatial-default"].default.easing,
        "amp-effect": tokens.motion["effect-default"].default.easing,
      },
      transitionDuration: {
        "amp-fast": String(tokens.motion["spatial-fast"].default.durationMs),
        "amp-default": String(tokens.motion["spatial-default"].default.durationMs),
        "amp-slow": String(tokens.motion["spatial-slow"].default.durationMs),
      },
    },
  },
};
