import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Build edition (docs/OPEN-SOURCE.md, src/lib/edition.ts). LALELA_EDITION
// picks it explicitly; otherwise the official repo builds "official" (its
// edition/official.env exists) and the public export builds "community" (the
// export never ships that file). The chosen edition/<edition>.env is loaded
// into process.env, which Vite then exposes as import.meta.env.VITE_* — real
// environment variables win over the file. src-tauri/build.rs applies the
// same rule for the Rust side, so both halves always agree.
// @ts-expect-error process is a nodejs global
const env: Record<string, string | undefined> = process.env;
const editionDir = path.resolve(__dirname, "edition");
const requestedEdition = env.LALELA_EDITION?.trim();
const edition =
  requestedEdition === "official" || requestedEdition === "community"
    ? requestedEdition
    : fs.existsSync(path.join(editionDir, "official.env"))
      ? "official"
      : "community";
const editionFile = path.join(editionDir, `${edition}.env`);
if (fs.existsSync(editionFile)) {
  for (const line of fs.readFileSync(editionFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    // An empty env var counts as unset (same rule as build.rs).
    if (m && !env[m[1]]?.trim()) env[m[1]] = m[2];
  }
}
env.VITE_LALELA_EDITION = edition;
if (edition === "official") {
  // Fail the build, never ship an official app that silently drops sync.
  const missing = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_MS_CLIENT_ID",
    "VITE_POSTHOG_DEFAULT_KEY",
  ].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Official Lalela build is missing ${missing.join(", ")} (edition/official.env). ` +
        `Set LALELA_EDITION=community to build the local-only Community edition.`,
    );
  }
}

// Distribution channel, baked in at build time. "store" is the Microsoft Store
// MSIX build, which has no Tauri updater (see src-tauri/tauri.store.conf.json)
// and must not offer one. Anything else — including an unset variable — is the
// ordinary direct-download build, so the existing lanes are unaffected.
// @ts-expect-error process is a nodejs global
const distribution = process.env.LALELA_DISTRIBUTION === "store" ? "store" : "direct";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __LALELA_DISTRIBUTION__: JSON.stringify(distribution),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Amp kit (source-copied via auxo-amp scripts/add.mjs into ./amp).
      "@auxo/amp-react": path.resolve(__dirname, "./amp/react"),
      "@auxo/amp-marks": path.resolve(__dirname, "./amp/marks"),
      "@auxo/amp-primitives": path.resolve(__dirname, "./amp/primitives"),
    },
  },

  // HTML entries: the app (index.html), the lightweight dictation overlay
  // (dictation.html) and the Meeting Copilot overlay (copilot.html) — each
  // loaded by its own Tauri WebviewWindow ("dictation" / "copilot").
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        dictation: path.resolve(__dirname, "dictation.html"),
        copilot: path.resolve(__dirname, "copilot.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
