/** How this copy of Lalela was delivered, decided at BUILD time.
 *
 * Set by `LALELA_DISTRIBUTION` in the environment when Vite runs; baked into
 * the bundle by the `__LALELA_DISTRIBUTION__` define in vite.config.ts. There
 * is no runtime detection here on purpose — a Store build and a direct-download
 * build are the same binary shape, so only the build knows which it is.
 *
 *   "direct" (default) — the NSIS .exe / macOS .dmg. Self-updates through the
 *                        Tauri updater against the signed latest.json feed.
 *   "store"            — the Microsoft Store .msix. The updater is stripped
 *                        from the Tauri config (tauri.store.conf.json) because
 *                        an MSIX install is immutable: a downloaded installer
 *                        cannot patch it, and would at best leave a second
 *                        stray copy of Lalela on the machine. Windows Update /
 *                        the Store app delivers new versions instead.
 */
export type Distribution = "direct" | "store";

export const DISTRIBUTION: Distribution =
  __LALELA_DISTRIBUTION__ === "store" ? "store" : "direct";

/** True in the Microsoft Store build. Anything that calls the updater, or
 * offers to, must be gated on `!IS_STORE_BUILD` — calling `check()` with no
 * updater config throws, and offering it would be a lie either way. */
export const IS_STORE_BUILD = DISTRIBUTION === "store";

/** What to tell a Store user in place of a "Check for updates" button. */
export const STORE_UPDATE_NOTE = "Updates come from the Microsoft Store.";
